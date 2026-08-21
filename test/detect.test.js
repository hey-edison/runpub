import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectProject, inferProjectName } from '../src/detect.js';

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('detects a single Vite project with its conventional port', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-vite-'));
  await writeJson(path.join(directory, 'package.json'), {
    name: '@example/customer-portal',
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^7.0.0' },
  });
  await writeFile(path.join(directory, 'package-lock.json'), '{}\n');

  const detected = await detectProject(directory);
  assert.equal(detected.project, 'customer-portal');
  assert.deepEqual(detected.services, {
    frontend: { command: 'npm run dev', port: 5173 },
  });
});

test('detects frontend and FastAPI services in a conventional monorepo', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-fullstack-'));
  const frontend = path.join(directory, 'frontend');
  const backend = path.join(directory, 'backend');
  await mkdir(frontend);
  await mkdir(path.join(backend, 'app'), { recursive: true });
  await writeJson(path.join(frontend, 'package.json'), {
    name: 'frontend',
    scripts: { dev: 'next dev' },
    dependencies: { next: '^16.0.0', react: '^19.0.0' },
  });
  await writeFile(path.join(backend, 'requirements.txt'), 'fastapi\nuvicorn\n');
  await writeFile(path.join(backend, 'app', 'main.py'), 'app = None\n');

  const detected = await detectProject(directory, 'example-app');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  assert.equal(detected.project, 'example-app');
  assert.deepEqual(detected.services, {
    frontend: { command: 'npm run dev', port: 3000, cwd: 'frontend' },
    backend: {
      command: `${python} -m uvicorn app.main:app --reload --port 8000`,
      port: 8000,
      cwd: 'backend',
    },
  });
});

test('detects package-manager workspaces and disambiguates repeated roles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runpublic-workspaces-'));
  await mkdir(path.join(directory, 'apps', 'dashboard'), { recursive: true });
  await mkdir(path.join(directory, 'apps', 'admin'), { recursive: true });
  await writeJson(path.join(directory, 'package.json'), {
    name: 'suite',
    private: true,
    workspaces: ['apps/*'],
  });
  for (const name of ['dashboard', 'admin']) {
    await writeJson(path.join(directory, 'apps', name, 'package.json'), {
      name,
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^7.0.0' },
    });
  }

  const detected = await detectProject(directory);
  assert.equal(Object.keys(detected.services).length, 2);
  assert.deepEqual(detected.services['admin-frontend'], {
    command: 'npm run dev',
    port: 5173,
    cwd: 'apps/admin',
  });
  assert.deepEqual(detected.services['dashboard-frontend'], {
    command: 'npm run dev -- --port 5174',
    port: 5174,
    cwd: 'apps/dashboard',
  });
});

test('infers a DNS-safe project name from the directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'My Project '));
  assert.match(await inferProjectName(directory), /^[a-z0-9-]+$/);
});
