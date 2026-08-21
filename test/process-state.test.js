import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listProcessStates,
  removeProcessState,
  saveProcessState,
} from '../src/process-state.js';

test('stores private per-project process state and removes it cleanly', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'runpub-process-'));
  const env = { RUNPUB_HOME: home };
  const filePath = await saveProcessState({
    version: 1,
    pid: process.pid,
    project: 'state-demo',
    startedAt: new Date().toISOString(),
    services: [{ name: 'frontend', port: 3000 }],
  }, env);

  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const states = await listProcessStates('state-demo', env);
  assert.equal(states.length, 1);
  assert.equal(states[0].pid, process.pid);
  assert.equal(states[0].services[0].name, 'frontend');

  await removeProcessState(filePath);
  assert.deepEqual(await listProcessStates('state-demo', env), []);
});

test('discovers active state written by the former RunPublic CLI', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'runpub-legacy-process-'));
  const filePath = await saveProcessState({
    version: 1,
    pid: process.pid,
    project: 'legacy-state-demo',
    startedAt: new Date().toISOString(),
    services: [{ name: 'backend', port: 8000 }],
  }, { RUNPUBLIC_HOME: path.join(base, 'runpublic') });

  const states = await listProcessStates('legacy-state-demo', { XDG_CONFIG_HOME: base });
  assert.equal(states.length, 1);
  assert.equal(states[0].filePath, filePath);
  await removeProcessState(filePath);
});
