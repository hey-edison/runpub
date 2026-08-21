import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildServiceEnvironment } from '../src/cli.js';
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
