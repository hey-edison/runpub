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
import { detectProject, inferProjectName } from './detect.js';
import { createServiceLabel } from './naming.js';
import {
  listProcessStates,
  processIsAlive,
  removeProcessState,
  saveProcessState,
} from './process-state.js';
import { TunnelClient } from './tunnel-client.js';

const DEFAULT_SERVER = 'https://edge.runpublic.dev';

const HELP = `runpublic - expose local development services over HTTPS

Usage:
  runpublic                         Auto-detect, start, and expose this project
  runpublic <service>               Start and expose one configured service
  runpublic all                     Start and expose every configured service
  runpublic <port> [options]        Expose an already-running local port
  runpublic login [--server <url>] [--account <namespace>] [--no-browser]
  runpublic login [--server <url>] --account <name> (--token <token> | --token-file <path>)
  runpublic whoami [--json]
  runpublic init [--project <name>] [--json]
  runpublic expose <port> --project <name> --service <name> [options]
  runpublic run [service] [--json]
  runpublic status [--json]
  runpublic stop
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
    if (name === 'json' || name === 'help' || name === 'skip-verify' || name === 'no-browser') {
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
      } else if (type === 'github-device') {
        process.stdout.write(
          `Open ${details.verificationUri}\nEnter code: ${details.userCode}\nWaiting for GitHub approval...\n`,
        );
      } else if (type === 'init') {
        process.stdout.write(`Created ${details.path}\n`);
      } else if (type === 'detected') {
        process.stdout.write(
          `Detected ${details.service}: ${details.kind} in ${details.cwd} (port ${details.port})\n`,
        );
      } else if (type === 'whoami') {
        process.stdout.write(`${details.account} (${details.server})\n`);
      } else if (type === 'status') {
        const state = details.tunnelActive
          ? 'public'
          : details.localOnline
            ? 'local only'
            : 'stopped';
        const publicPart = details.tunnelActive && details.publicUrl ? ` — ${details.publicUrl}` : '';
        process.stdout.write(`${details.service}: ${state} on ${details.localUrl}${publicPart}\n`);
      } else if (type === 'stop-requested') {
        process.stdout.write(`Stopping RunPublic process ${details.pid}...\n`);
      } else if (type === 'nothing-to-stop') {
        process.stdout.write('No active RunPublic session was found for this project.\n');
      }
    },
  };
}

function localUrl(protocol, host, port) {
  const printableHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}://${printableHost}:${port}`;
}

function edgeEndpoint(server, pathname) {
  const url = new URL(server);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url;
}

function credentialEndpoint(server) {
  return edgeEndpoint(server, '/_runpublic/me');
}

async function responsePayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function responseError(payload, response, prefix) {
  const message = payload?.error?.message || `server returned HTTP ${response.status}`;
  return new Error(`${prefix}: ${message}`);
}

function openBrowser(url) {
  const options = { detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'darwin') child = spawn('open', [url], options);
  else if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], options);
  else child = spawn('xdg-open', [url], options);
  child.once('error', () => {});
  child.unref();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function githubDeviceLogin({ server, requestedAccount, noBrowser, reporter }) {
  const startResponse = await fetch(edgeEndpoint(server, '/_runpublic/auth/github/device/start'), {
    method: 'POST',
    headers: { 'user-agent': 'runpublic-cli' },
    signal: AbortSignal.timeout(10_000),
  });
  const started = await responsePayload(startResponse);
  if (!startResponse.ok) throw responseError(started, startResponse, 'GitHub login failed');
  if (!started.deviceCode || !started.userCode || !started.verificationUri) {
    throw new Error('GitHub login failed: server returned an invalid device response');
  }

  reporter.event('github-device', {
    verificationUri: started.verificationUri,
    userCode: started.userCode,
    expiresIn: started.expiresIn,
  });
  if (!noBrowser) openBrowser(started.verificationUri);

  const expiresIn = Math.min(Math.max(Number(started.expiresIn) || 900, 60), 1_800);
  const deadline = Date.now() + expiresIn * 1_000;
  let intervalSeconds = Math.min(Math.max(Number(started.interval) || 5, 1), 30);
  while (Date.now() < deadline) {
    await wait(intervalSeconds * 1_000);
    const response = await fetch(edgeEndpoint(server, '/_runpublic/auth/github/device/poll'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'runpublic-cli' },
      body: JSON.stringify({
        deviceCode: started.deviceCode,
        ...(requestedAccount ? { account: requestedAccount } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await responsePayload(response);
    if (response.status === 202) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter)) {
        intervalSeconds = Math.min(Math.max(retryAfter, intervalSeconds), 30);
      }
      continue;
    }
    if (!response.ok) throw responseError(payload, response, 'GitHub login failed');
    if (!payload.account || !payload.token?.value) {
      throw new Error('GitHub login failed: server returned incomplete credentials');
    }
    return { account: payload.account, token: payload.token.value };
  }
  throw new Error('GitHub login timed out; run "runpublic login" to try again');
}

async function verifyCredentials({ server, account, token }) {
  const response = await fetch(credentialEndpoint(server), {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'runpublic-cli' },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw responseError(payload, response, 'login verification failed');
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
  let statePath;
  try {
    statePath = await saveProcessState({
      version: 1,
      pid: process.pid,
      project,
      startedAt: new Date().toISOString(),
      services: [{ name: service, port, publicUrl: result.publicUrl }],
    });
  } catch (error) {
    await Promise.resolve(tunnel.stop()).catch(() => {});
    throw error;
  }

  return new Promise((resolve) => {
    let stopping = false;
    const stop = async (signal) => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await Promise.resolve(tunnel.stop()).catch(() => {});
      await removeProcessState(statePath).catch(() => {});
      reporter.event('stopped', { project, service, signal });
      resolve(signalExitCode(signal));
    };
    const onSigint = () => void stop('SIGINT');
    const onSigterm = () => void stop('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

function environmentVariableName(serviceName) {
  return `RUNPUBLIC_${serviceName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`;
}

export function buildServiceEnvironment(auth, project, serviceName, service, allServices) {
  const env = { ...process.env };
  const domain = publicDomain(auth);
  env.RUNPUBLIC_PROJECT = project;
  env.RUNPUBLIC_SERVICE = serviceName;
  if (domain) {
    for (const name of Object.keys(allServices)) {
      const publicUrl = `https://${createServiceLabel({ project, service: name, account: auth.account })}.${domain}`;
      env[environmentVariableName(name)] = publicUrl;
      if (name === serviceName) env.RUNPUBLIC_URL = publicUrl;
    }
  }
  for (const [name, rawValue] of Object.entries(service.env)) {
    const expanded = rawValue.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, variable) =>
      env[variable] === undefined ? match : env[variable],
    );
    if (/\$\{RUNPUBLIC_[A-Z0-9_]+\}/.test(expanded)) {
      throw new Error(
        `services.${serviceName}.env.${name} needs a public domain; set RUNPUBLIC_DOMAIN for this server`,
      );
    }
    env[name] = expanded;
  }
  return env;
}

function spawnService(service, directory, json, env) {
  return spawn(service.command, {
    cwd: path.resolve(directory, service.cwd),
    env,
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
  let statePath;

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
      const child = spawnService(
        service,
        loaded.directory,
        Boolean(flags.json),
        buildServiceEnvironment(
          auth,
          loaded.config.project,
          name,
          service,
          loaded.config.services,
        ),
      );
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

    statePath = await saveProcessState({
      version: 1,
      pid: process.pid,
      project: loaded.config.project,
      configPath: loaded.path,
      startedAt: new Date().toISOString(),
      services: entries.map(([name, service]) => ({ name, port: service.port })),
    });

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
    await removeProcessState(statePath).catch(() => {});
  }
}

async function initializeProject(flags, reporter, { allowEmpty = false } = {}) {
  const detection = await detectProject(process.cwd(), flags.project);
  if (!allowEmpty && Object.keys(detection.services).length === 0) {
    throw new Error(
      'could not detect a development service; run "runpublic init --project <name>" and add its command and port to runpublic.json',
    );
  }
  const filePath = await createProjectConfig(
    detection.project,
    process.cwd(),
    detection.services,
  );
  reporter.event('init', { project: detection.project, path: path.resolve(filePath) });
  for (const service of detection.detections) {
    reporter.event('detected', {
      project: detection.project,
      service: service.name,
      kind: service.detectedAs,
      cwd: service.cwd,
      port: service.port,
      command: service.command,
    });
  }
  return filePath;
}

async function ensureProjectConfig(reporter) {
  try {
    return await loadProjectConfig();
  } catch (error) {
    if (!String(error?.message).startsWith('could not find runpublic.json')) throw error;
    await initializeProject({}, reporter);
    return await loadProjectConfig();
  }
}

function publicDomain(auth) {
  if (process.env.RUNPUBLIC_DOMAIN) return process.env.RUNPUBLIC_DOMAIN;
  const hostname = new URL(auth.server).hostname;
  if (hostname === 'edge.runpublic.dev' || hostname.endsWith('.runpublic.dev')) {
    return 'runpublic.dev';
  }
  return undefined;
}

async function statusCommand(positionals, flags, reporter) {
  assertAllowedFlags(flags, ['json']);
  if (positionals.length > 0) throw new Error('status does not accept positional arguments');
  const loaded = await loadProjectConfig();
  let auth;
  try {
    auth = await loadAuthConfig();
  } catch {
    auth = undefined;
  }
  const domain = auth ? publicDomain(auth) : undefined;
  const states = await listProcessStates(loaded.config.project);
  const liveStates = [];
  for (const state of states) {
    if (processIsAlive(state.pid)) liveStates.push(state);
    else await removeProcessState(state.filePath);
  }

  for (const [name, service] of Object.entries(loaded.config.services)) {
    const localOnline = await tryPort(service.host, service.port);
    const tunnelActive = liveStates.some((state) =>
      state.services.some((activeService) => activeService.name === name),
    );
    const publicUrl = domain
      ? `https://${createServiceLabel({ project: loaded.config.project, service: name, account: auth.account })}.${domain}`
      : undefined;
    reporter.event('status', {
      project: loaded.config.project,
      service: name,
      localOnline,
      tunnelActive,
      localUrl: localUrl(service.protocol, service.host, service.port),
      publicUrl,
    });
  }
  return 0;
}

async function stopCommand(positionals, flags, reporter) {
  assertAllowedFlags(flags, ['json']);
  if (positionals.length > 0) throw new Error('stop does not accept positional arguments');
  let project;
  try {
    project = (await loadProjectConfig()).config.project;
  } catch (error) {
    if (!String(error?.message).startsWith('could not find runpublic.json')) throw error;
    project = await inferProjectName();
  }

  const states = await listProcessStates(project);
  let stopped = 0;
  for (const state of states) {
    if (!processIsAlive(state.pid)) {
      await removeProcessState(state.filePath);
      continue;
    }
    process.kill(state.pid, 'SIGTERM');
    reporter.event('stop-requested', { project, pid: state.pid, services: state.services });
    stopped += 1;
  }
  if (stopped === 0) reporter.event('nothing-to-stop', { project });
  return 0;
}

async function portShortcut(port, flags, reporter) {
  assertAllowedFlags(flags, ['project', 'service', 'host', 'protocol', 'json']);
  let loaded;
  try {
    loaded = await loadProjectConfig();
  } catch (error) {
    if (!String(error?.message).startsWith('could not find runpublic.json')) throw error;
  }
  const numericPort = Number(port);
  const matching = loaded
    ? Object.entries(loaded.config.services).find(([, service]) => service.port === numericPort)
    : undefined;
  const project = flags.project ?? loaded?.config.project ?? await inferProjectName();
  const service = flags.service ?? matching?.[0] ?? 'app';
  return await exposeCommand([port], {
    ...flags,
    project,
    service,
    host: flags.host ?? matching?.[1].host,
    protocol: flags.protocol ?? matching?.[1].protocol,
  }, reporter);
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
    let command = argv[0];
    let commandArguments = argv.slice(1);
    if (!command) {
      command = 'run';
      commandArguments = [];
    } else if (command === '--json') {
      command = 'run';
      commandArguments = argv;
    }
    if (command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      process.stdout.write(`${await packageVersion()}\n`);
      return 0;
    }

    if (command === 'all') command = 'run';
    const builtInCommands = new Set(['login', 'whoami', 'init', 'expose', 'run', 'status', 'stop']);
    if (/^\d+$/.test(command)) {
      commandArguments = [command, ...commandArguments];
      command = '__port__';
    } else if (!builtInCommands.has(command)) {
      commandArguments = [command, ...commandArguments];
      command = 'run';
    }

    const { positionals, flags } = parseArguments(commandArguments);
    const reporter = createReporter(Boolean(flags.json));
    if (flags.help) {
      process.stdout.write(HELP);
      return 0;
    }

    if (command === 'login') {
      assertAllowedFlags(flags, [
        'server',
        'account',
        'token',
        'token-file',
        'skip-verify',
        'no-browser',
        'json',
      ]);
      if (positionals.length > 0) throw new Error('login does not accept positional arguments');
      const server = validateServer(
        flags.server ?? process.env.RUNPUBLIC_SERVER ?? process.env.DEVPUBLIC_SERVER ?? DEFAULT_SERVER,
      );
      const manualLogin = Boolean(flags.token || flags['token-file'] || flags['skip-verify']);
      let account;
      let token;
      if (manualLogin) {
        if (flags['no-browser']) throw new Error('--no-browser is only valid for GitHub login');
        account = validateName(requiredFlag(flags, 'account'), 'account');
        const inlineToken = flags.token;
        const tokenFile = flags['token-file'];
        if (Boolean(inlineToken) === Boolean(tokenFile)) {
          throw new Error('provide exactly one of --token or --token-file');
        }
        token = inlineToken ?? (await readFile(path.resolve(tokenFile), 'utf8')).trim();
        if (!token) throw new Error('token must be a non-empty string');
        if (!flags['skip-verify']) await verifyCredentials({ server, account, token });
      } else {
        const requestedAccount = flags.account
          ? validateName(flags.account, 'account')
          : undefined;
        ({ account, token } = await githubDeviceLogin({
          server,
          requestedAccount,
          noBrowser: Boolean(flags['no-browser']),
          reporter,
        }));
        await verifyCredentials({ server, account, token });
      }
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
      await initializeProject(flags, reporter, { allowEmpty: true });
      return 0;
    }

    if (command === 'expose') {
      return await exposeCommand(positionals, flags, reporter);
    }
    if (command === 'run') {
      await ensureProjectConfig(reporter);
      return await runCommand(positionals, flags, reporter);
    }
    if (command === '__port__') {
      const [port, ...extraPositionals] = positionals;
      if (extraPositionals.length > 0) throw new Error('usage: runpublic <port> [options]');
      return await portShortcut(port, flags, reporter);
    }
    if (command === 'status') {
      return await statusCommand(positionals, flags, reporter);
    }
    if (command === 'stop') {
      return await stopCommand(positionals, flags, reporter);
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
