import assert from 'node:assert/strict';
import test from 'node:test';

import worker, {
  createHostname as createWorkerHostname,
  createServiceLabel as createWorkerServiceLabel,
} from '../cloudflare/src/worker.js';
import { createHostname as createNodeHostname, createServiceLabel as createNodeServiceLabel } from '../src/naming.js';

test('Cloudflare and Node edges generate identical short and truncated hostnames', async () => {
  const short = { project: 'ai-native-ats', service: 'frontend', account: 'keshavmac' };
  const long = {
    project: 'a-very-long-project-name-that-keeps-going-and-going',
    service: 'a-very-long-frontend-service-name',
    account: 'a-very-long-developer-account-name',
  };
  assert.equal(await createWorkerServiceLabel(short), createNodeServiceLabel(short));
  assert.equal(await createWorkerServiceLabel(long), createNodeServiceLabel(long));
  assert.equal(
    await createWorkerHostname({ ...long, domain: 'runpublic.dev' }),
    createNodeHostname({ ...long, domain: 'runpublic.dev' }),
  );
});

test('Cloudflare edge health response does not require database access', async () => {
  const response = await worker.fetch(
    new Request('https://edge.runpublic.dev/health'),
    { RUNPUBLIC_DOMAIN: 'runpublic.dev' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    architecture: 'durable-objects',
    version: '0.2.0',
  });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('Cloudflare edge rejects hostnames outside its managed domain', async () => {
  const response = await worker.fetch(
    new Request('https://attacker.example/'),
    { RUNPUBLIC_DOMAIN: 'runpublic.dev' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 404);
});
