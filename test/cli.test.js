import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildServiceEnvironment,
  promptForAgentInstructions,
  promptForServiceSelection,
  resolveServiceSelection,
} from '../src/cli.js';
import { saveProcessState } from '../src/process-state.js';

const execFileAsync = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'bin', 'runpublic.js');

async function invoke(args, cwd) {
  return await execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, RUNPUBLIC_HOME: path.join(cwd, '.auth') },
  });
}

test('init auto-detects a project and writes a ready-to-run configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-init-'));
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
    name: 'mobile-demo',
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^7.0.0' },
  })}\n`);

  const result = await invoke(['init', '--json'], directory);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['init', 'detected']);
  const config = JSON.parse(await readFile(path.join(directory, 'runpublic.json'), 'utf8'));
  assert.deepEqual(config, {
    project: 'mobile-demo',
    services: { frontend: { command: 'npm run dev', port: 5173 } },
  });
});

test('non-interactive setup selects services by folder for an ambiguous repository', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-select-'));
  for (const name of ['admin-web', 'customer-web']) {
    const serviceDirectory = path.join(directory, name);
    await mkdir(serviceDirectory);
    await writeFile(path.join(serviceDirectory, 'package.json'), `${JSON.stringify({
      name,
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^7.0.0' },
    })}\n`);
  }
  const result = await invoke(['init', '--services', 'customer-web', '--json'], directory);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['selected', 'init', 'detected']);
  const config = JSON.parse(await readFile(path.join(directory, 'runpublic.json'), 'utf8'));
  assert.deepEqual(config.services, {
    frontend: { command: 'npm run dev', port: 5173, cwd: 'customer-web' },
  });
});

test('non-interactive ambiguous setup fails with actionable choices', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-ambiguous-'));
  for (const name of ['admin-web', 'customer-web']) {
    const serviceDirectory = path.join(directory, name);
    await mkdir(serviceDirectory);
    await writeFile(path.join(serviceDirectory, 'package.json'), `${JSON.stringify({
      name,
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^7.0.0' },
    })}\n`);
  }
  await assert.rejects(
    invoke(['init', '--json'], directory),
    (error) => /multiple services detected/.test(error.stderr) && /--services/.test(error.stderr),
  );
});

test('setup re-runs detection and replaces an existing manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-setup-'));
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
    name: 'fresh-project',
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^7.0.0' },
  })}\n`);
  await writeFile(path.join(directory, 'runpublic.json'), `${JSON.stringify({
    project: 'old-project',
    services: { old: { command: 'old-command', port: 9999, cwd: 'legacy' } },
  })}\n`);

  await invoke(['setup', '--json'], directory);
  const config = JSON.parse(await readFile(path.join(directory, 'runpublic.json'), 'utf8'));
  assert.equal(config.project, 'fresh-project');
  assert.deepEqual(config.services, {
    frontend: { command: 'npm run dev', port: 5173 },
  });
});

test('setup preserves custom commands and environment for a reselected service', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-setup-preserve-'));
  await mkdir(path.join(directory, 'web'));
  await writeFile(path.join(directory, 'web', 'package.json'), `${JSON.stringify({
    name: 'web',
    scripts: { dev: 'next dev' },
    dependencies: { next: '^16.0.0', react: '^19.0.0' },
  })}\n`);
  await writeFile(path.join(directory, 'runpublic.json'), `${JSON.stringify({
    project: 'custom-project',
    services: {
      frontend: {
        command: 'npm run custom-dev',
        port: 3100,
        cwd: 'web',
        env: { NEXT_PUBLIC_API_BASE: '${RUNPUBLIC_BACKEND_URL}/api/v1' },
      },
    },
  })}\n`);

  await invoke(['setup', '--json'], directory);
  const config = JSON.parse(await readFile(path.join(directory, 'runpublic.json'), 'utf8'));
  assert.equal(config.services.frontend.command, 'npm run custom-dev');
  assert.equal(config.services.frontend.port, 3100);
  assert.equal(
    config.services.frontend.env.NEXT_PUBLIC_API_BASE,
    '${RUNPUBLIC_BACKEND_URL}/api/v1',
  );
});

test('natural service, all, and numeric shortcuts route through the CLI', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-help-'));
  for (const args of [
    ['frontend', '--help'],
    ['all', '--help'],
    ['3000', '--help'],
  ]) {
    const result = await invoke(args, directory);
    assert.match(result.stdout, /runpublic <service>/);
    assert.equal(result.stderr, '');
  }
});

test('status reports configured local services without requiring login', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-status-'));
  await writeFile(path.join(directory, 'runpublic.json'), `${JSON.stringify({
    project: 'status-demo',
    services: { frontend: { command: 'npm run dev', port: 49151 } },
  })}\n`);

  const result = await invoke(['status', '--json'], directory);
  const event = JSON.parse(result.stdout);
  assert.equal(event.type, 'status');
  assert.equal(event.service, 'frontend');
  assert.equal(event.localOnline, false);
  assert.equal(event.tunnelActive, false);
  assert.equal(event.localUrl, 'http://127.0.0.1:49151');
});

test('stop reports when no managed project process is active', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-stop-'));
  const result = await invoke(['stop'], directory);
  assert.match(result.stdout, /No active RunPublic session/i);
});

test('stop terminates a managed RunPublic process from another terminal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-stop-live-'));
  const authHome = path.join(directory, '.auth');
  await writeFile(path.join(directory, 'runpublic.json'), `${JSON.stringify({
    project: 'stop-demo',
    services: { frontend: { command: 'npm run dev', port: 3000 } },
  })}\n`);
  const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)',
  ]);
  const exitPromise = once(child, 'exit');
  try {
    await saveProcessState({
      version: 1,
      pid: child.pid,
      project: 'stop-demo',
      startedAt: new Date().toISOString(),
      services: [{ name: 'frontend', port: 3000 }],
    }, { RUNPUBLIC_HOME: authHome });
    const result = await invoke(['stop'], directory);
    assert.match(result.stdout, new RegExp(`Stopping RunPublic process ${child.pid}`));
    const [code, signal] = await exitPromise;
    assert.ok(code === 0 || signal === 'SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('injects stable cross-service URLs and expands configured environment', () => {
  const services = {
    frontend: { env: { NEXT_PUBLIC_API_BASE: '${RUNPUBLIC_BACKEND_URL}/api/v1' } },
    backend: { env: {} },
  };
  const env = buildServiceEnvironment(
    { server: 'https://edge.runpublic.dev', account: 'keshavmac' },
    'ai-native-ats',
    'frontend',
    services.frontend,
    services,
  );
  assert.equal(
    env.RUNPUBLIC_FRONTEND_URL,
    'https://ai-native-ats-frontend-keshavmac.runpublic.dev',
  );
  assert.equal(
    env.RUNPUBLIC_BACKEND_URL,
    'https://ai-native-ats-backend-keshavmac.runpublic.dev',
  );
  assert.equal(
    env.NEXT_PUBLIC_API_BASE,
    'https://ai-native-ats-backend-keshavmac.runpublic.dev/api/v1',
  );
});

test('service selection accepts numbers and folders but rejects ambiguous roles', () => {
  const detection = {
    candidates: [
      { id: '1', cwd: 'admin-web', suggestedName: 'frontend' },
      { id: '2', cwd: 'customer-web', suggestedName: 'frontend' },
      { id: '3', cwd: 'backend', suggestedName: 'backend' },
    ],
  };
  assert.deepEqual(resolveServiceSelection(detection, '2,backend'), ['2', '3']);
  assert.throws(() => resolveServiceSelection(detection, 'frontend'), /ambiguous/);
  assert.throws(() => resolveServiceSelection(detection, 'missing'), /does not match/);
});

test('interactive setup renders choices and returns the selected services', async () => {
  const detection = {
    candidates: [
      {
        id: '1',
        cwd: 'careers-web',
        suggestedName: 'frontend',
        detectedAs: 'Node.js frontend',
        command: 'npm run dev',
        port: 3000,
      },
      {
        id: '2',
        cwd: 'edison-web',
        suggestedName: 'frontend',
        detectedAs: 'Node.js frontend',
        command: 'npm run dev',
        port: 3000,
      },
      {
        id: '3',
        cwd: 'backend',
        suggestedName: 'backend',
        detectedAs: 'FastAPI backend',
        command: 'python3 -m uvicorn app.main:app',
        port: 8000,
      },
    ],
  };
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk.toString(); });
  input.end('2,3\n');

  const selected = await promptForServiceSelection(detection, { input, output });
  assert.deepEqual(selected, ['2', '3']);
  assert.match(rendered, /RunPublic found several development services/);
  assert.match(rendered, /2\. edison-web/);
  assert.match(rendered, /comma-separated numbers/);
});

test('AI-agent setup prompt is explicit and defaults to disabled', async () => {
  for (const [answer, expected] of [['yes\n', true], ['\n', false]]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk) => { rendered += chunk.toString(); });
    input.end(answer);

    assert.equal(await promptForAgentInstructions({ input, output }), expected);
    assert.match(rendered, /Make RunPublic the default for AI coding agents/);
    assert.match(rendered, /\[y\/N\]/);
  }
});

test('init --agents installs agent instructions non-interactively', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-cli-agents-'));
  const home = path.join(directory, 'home');
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
    name: 'agent-demo',
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^7.0.0' },
  })}\n`);

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    RUNPUBLIC_HOME: path.join(directory, '.auth'),
  };
  const { stdout } = await execFileAsync(process.execPath, [cli, 'init', '--agents', '--json'], {
    cwd: directory,
    env,
  });
  const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === 'agent-instructions').length, 4);
  assert.match(
    await readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8'),
    /RunPublic development servers/,
  );
  assert.match(
    await readFile(path.join(directory, '.cursor', 'rules', 'runpublic.mdc'), 'utf8'),
    /alwaysApply: true/,
  );

  const status = await execFileAsync(process.execPath, [cli, 'agents', 'status', '--json'], {
    cwd: directory,
    env,
  });
  assert.ok(
    status.stdout.trim().split('\n').map((line) => JSON.parse(line)).every(
      (event) => event.type === 'agent-instructions' && event.installed,
    ),
  );

  await execFileAsync(process.execPath, [cli, 'agents', 'remove', '--json'], {
    cwd: directory,
    env,
  });
  const removedStatus = await execFileAsync(
    process.execPath,
    [cli, 'agents', 'status', '--json'],
    { cwd: directory, env },
  );
  assert.ok(
    removedStatus.stdout.trim().split('\n').map((line) => JSON.parse(line)).every(
      (event) => event.type === 'agent-instructions' && !event.installed,
    ),
  );
});
