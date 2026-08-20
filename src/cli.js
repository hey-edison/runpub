import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authConfigPath,
  createProjectConfig,
  loadAuthConfig,
  loadProjectConfig,
  saveAuthConfig,
  validateName,
  validateServer,
} from './config.js';
import { TunnelClient } from './tunnel-client.js';

const HELP = `runpublic - expose local development services over HTTPS

Usage:
  runpublic login --server <url> --account <name> (--token <token> | --token-file <path>)
  runpublic whoami [--json]
  runpublic init --project <name> [--json]
  runpublic expose <port> --project <name> --service <name> [options]
  runpublic run [service] [--json]
  runpublic help
  runpublic version

Expose options:
  --host <host>          Local host (default: 127.0.0.1)
  --protocol <protocol>  Local protocol: http or https (default: http)
  --json                 Emit newline-delimited JSON events

Authentication environment overrides:
  RUNPUBLIC_SERVER, RUNPUBLIC_ACCOUNT, RUNPUBLIC_TOKEN
  Legacy DEVPUBLIC_* names are also accepted.
`;

function parseArguments(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    if (equalsIndex !== -1) {
      const name = argument.slice(2, equalsIndex);
      flags[name] = argument.slice(equalsIndex + 1);
      continue;
    }

    const name = argument.slice(2);
    if (name === 'json' || name === 'help' || name === 'skip-verify') {
      flags[name] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    flags[name] = value;
    index += 1;
  }

  return { positionals, flags };
}

function assertAllowedFlags(flags, allowed) {
  const unknown = Object.keys(flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0) {
    throw new Error(`unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((flag) => `--${flag}`).join(', ')}`);
  }
}

function requiredFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function createReporter(json) {
  return {
    event(type, details = {}) {
      if (json) {
        process.stdout.write(`${JSON.stringify({ type, ...details })}\n`);
        return;
      }

      if (type === 'online') {
        process.stdout.write(`${details.service}: ${details.publicUrl} -> ${details.localUrl}\n`);
      } else if (type === 'started') {
        process.stdout.write(`${details.service}: started (pid ${details.pid})\n`);
      } else if (type === 'stopped') {
        process.stdout.write(`${details.service}: stopped\n`);
      } else if (type === 'login') {
        process.stdout.write(`Logged in as ${details.account} (${details.server})\n`);
      } else if (type === 'init') {
        process.stdout.write(`Created ${details.path}\n`);
      } else if (type === 'whoami') {
        process.stdout.write(`${details.account} (${details.server})\n`);
      }
    },
  };
}

function localUrl(protocol, host, port) {
  const printableHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}://${printableHost}:${port}`;
}

function credentialEndpoint(server) {
  const url = new URL(server);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = '/_runpublic/me';
  url.search = '';
  url.hash = '';
  return url;
}

async function verifyCredentials({ server, account, token }) {
  const response = await fetch(credentialEndpoint(server), {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'runpublic-cli' },
    signal: AbortSignal.timeout(10_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const message = payload?.error?.message || `server returned HTTP ${response.status}`;
    throw new Error(`login verification failed: ${message}`);
  }
  if (payload.account !== account) {
    throw new Error(
      `login verification failed: token belongs to "${payload.account || 'unknown'}", not "${account}"`,
    );
  }
}

function tunnelFor(auth, options) {
  return new TunnelClient({
    server: auth.server,
    token: auth.token,
    account: auth.account,
    project: options.project,
    service: options.service,
    localHost: options.host,
    localPort: options.port,
    localProtocol: options.protocol,
  });
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

async function exposeCommand(positionals, flags, reporter) {
  assertAllowedFlags(flags, ['project', 'service', 'host', 'protocol', 'json']);
  if (positionals.length !== 1) {
    throw new Error('usage: runpublic expose <port> --project <name> --service <name>');
  }

  const port = Number(positionals[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer between 1 and 65535');
  }

  const project = validateName(requiredFlag(flags, 'project'), 'project');
  const service = validateName(requiredFlag(flags, 'service'), 'service');
  const host = flags.host ?? '127.0.0.1';
  const protocol = flags.protocol ?? 'http';
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('--host must be a non-empty string');
  }
  if (!['http', 'https'].includes(protocol)) {
    throw new Error('--protocol must be either "http" or "https"');
  }

  const auth = await loadAuthConfig();
  const tunnel = tunnelFor(auth, { project, service, host, port, protocol });
  const result = await tunnel.start();
  reporter.event('online', {
    project,
    service,
    hostname: result.hostname,
    publicUrl: result.publicUrl,
    localUrl: localUrl(protocol, host, port),
  });

  return new Promise((resolve) => {
    let stopping = false;
    const stop = async (signal) => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await Promise.resolve(tunnel.stop()).catch(() => {});
      reporter.event('stopped', { project, service, signal });
      resolve(signalExitCode(signal));
    };
    const onSigint = () => void stop('SIGINT');
    const onSigterm = () => void stop('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

function spawnService(service, directory, json) {
  return spawn(service.command, {
    cwd: directory,
    env: process.env,
    shell: true,
    stdio: json ? ['inherit', process.stderr, process.stderr] : 'inherit',
  });
}

function tryPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForService(name, service, child) {
  const deadline = Date.now() + service.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`service "${name}" exited before listening on ${service.host}:${service.port}`);
    }
    if (await tryPort(service.host, service.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `service "${name}" did not listen on ${service.host}:${service.port} within ${service.readyTimeoutMs}ms`,
  );
}

async function runCommand(positionals, flags, reporter) {
  assertAllowedFlags(flags, ['json']);
  if (positionals.length > 1) {
    throw new Error('usage: runpublic run [service] [--json]');
  }

  const auth = await loadAuthConfig();
  const loaded = await loadProjectConfig();
  const requestedService = positionals[0];
  if (
    requestedService !== undefined &&
    !Object.hasOwn(loaded.config.services, requestedService)
  ) {
    throw new Error(`service "${requestedService}" is not defined in ${loaded.path}`);
  }

  const entries = requestedService
    ? [[requestedService, loaded.config.services[requestedService]]]
    : Object.entries(loaded.config.services);
  const running = new Map();
  let stopping = false;
  let signal;

  const stopEntry = async (name, entry, stopChild = true) => {
    if (entry.stopped) return;
    entry.stopped = true;
    await Promise.resolve(entry.tunnel?.stop()).catch(() => {});
    if (stopChild && entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill('SIGTERM');
    }
    reporter.event('stopped', { project: loaded.config.project, service: name });
  };

  const stopAll = async (receivedSignal) => {
    if (stopping) return;
    stopping = true;
    signal = receivedSignal;
    await Promise.all(
      [...running.entries()].map(([name, entry]) => stopEntry(name, entry, true)),
    );
  };

  const onSigint = () => void stopAll('SIGINT');
  const onSigterm = () => void stopAll('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    for (const [name, service] of entries) {
      const child = spawnService(service, loaded.directory, Boolean(flags.json));
      const entry = { child, tunnel: undefined, stopped: false };
      running.set(name, entry);
      reporter.event('started', {
        project: loaded.config.project,
        service: name,
        pid: child.pid,
      });

      entry.exitPromise = new Promise((resolve) => {
        let resolved = false;
        const finish = (result) => {
          if (resolved) return;
          resolved = true;
          resolve({ name, ...result });
          void stopEntry(name, entry, false);
        };
        child.once('error', (error) => {
          entry.spawnError = error;
          finish({ code: 1, signal: null, error });
        });
        child.once('exit', (code, childSignal) => {
          finish({ code, signal: childSignal, error: entry.spawnError });
        });
      });
    }

    await Promise.all(
      entries.map(async ([name, service]) => {
        const entry = running.get(name);
        if (entry.spawnError || entry.child.exitCode !== null || entry.child.signalCode !== null) {
          throw entry.spawnError ?? new Error(`service "${name}" exited before its tunnel started`);
        }
        await waitForService(name, service, entry.child);
        const tunnel = tunnelFor(auth, {
          project: loaded.config.project,
          service: name,
          host: service.host,
          port: service.port,
          protocol: service.protocol,
        });
        entry.tunnel = tunnel;
        const result = await tunnel.start();
        if (entry.stopped) {
          await Promise.resolve(tunnel.stop()).catch(() => {});
          return;
        }
        reporter.event('online', {
          project: loaded.config.project,
          service: name,
          hostname: result.hostname,
          publicUrl: result.publicUrl,
          localUrl: localUrl(service.protocol, service.host, service.port),
        });
      }),
    );

    const exits = await Promise.all([...running.values()].map((entry) => entry.exitPromise));

    if (signal) return signalExitCode(signal);
    const failed = exits.find((exit) => exit.error || (exit.code ?? 1) !== 0);
    return failed ? failed.code || 1 : 0;
  } catch (error) {
    await stopAll();
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

async function packageVersion() {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
  try {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const jsonRequested = argv.includes('--json') || argv.some((arg) => arg.startsWith('--json='));
  try {
    const command = argv[0];
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      process.stdout.write(`${await packageVersion()}\n`);
      return 0;
    }

    const { positionals, flags } = parseArguments(argv.slice(1));
    const reporter = createReporter(Boolean(flags.json));
    if (flags.help) {
      process.stdout.write(HELP);
      return 0;
    }

    if (command === 'login') {
      assertAllowedFlags(flags, ['server', 'account', 'token', 'token-file', 'skip-verify', 'json']);
      if (positionals.length > 0) throw new Error('login does not accept positional arguments');
      const server = validateServer(requiredFlag(flags, 'server'));
      const account = validateName(requiredFlag(flags, 'account'), 'account');
      const inlineToken = flags.token;
      const tokenFile = flags['token-file'];
      if (Boolean(inlineToken) === Boolean(tokenFile)) {
        throw new Error('provide exactly one of --token or --token-file');
      }
      const token = inlineToken ?? (await readFile(path.resolve(tokenFile), 'utf8')).trim();
      if (!token) throw new Error('token must be a non-empty string');
      if (!flags['skip-verify']) await verifyCredentials({ server, account, token });
      const filePath = await saveAuthConfig({ server, account, token });
      reporter.event('login', { server, account, path: filePath });
      return 0;
    }

    if (command === 'whoami') {
      assertAllowedFlags(flags, ['json']);
      if (positionals.length > 0) throw new Error('whoami does not accept positional arguments');
      const auth = await loadAuthConfig();
      reporter.event('whoami', {
        server: auth.server,
        account: auth.account,
        configPath: authConfigPath(),
      });
      return 0;
    }

    if (command === 'init') {
      assertAllowedFlags(flags, ['project', 'json']);
      if (positionals.length > 0) throw new Error('init does not accept positional arguments');
      const project = requiredFlag(flags, 'project');
      const filePath = await createProjectConfig(project);
      reporter.event('init', { project, path: path.resolve(filePath) });
      return 0;
    }

    if (command === 'expose') {
      return await exposeCommand(positionals, flags, reporter);
    }
    if (command === 'run') {
      return await runCommand(positionals, flags, reporter);
    }

    throw new Error(`unknown command "${command}" (run "runpublic help")`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonRequested) {
      process.stderr.write(`${JSON.stringify({ type: 'error', message })}\n`);
    } else {
      process.stderr.write(`runpublic: ${message}\n`);
    }
    return 1;
  }
}
