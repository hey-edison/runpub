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
    services: { old: { command: 'old-command', port: 9999 } },
  })}\n`);

  await invoke(['setup', '--json'], directory);
  const config = JSON.parse(await readFile(path.join(directory, 'runpublic.json'), 'utf8'));
  assert.equal(config.project, 'fresh-project');
  assert.deepEqual(config.services, {
    frontend: { command: 'npm run dev', port: 5173 },
  });
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
