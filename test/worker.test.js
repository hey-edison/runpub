import assert from 'node:assert/strict';
import test from 'node:test';

import worker, {
  createHostname as createWorkerHostname,
  createServiceLabel as createWorkerServiceLabel,
  tunnelResponseInit,
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
    { RUNPUB_DOMAIN: 'runpublic.dev' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    architecture: 'durable-objects',
    version: '0.6.0',
  });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('Cloudflare edge serves a secure product page at the apex domain', async () => {
  const response = await worker.fetch(
    new Request('https://runpublic.dev/'),
    { RUNPUB_DOMAIN: 'runpublic.dev' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /npm install --global runpub/);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('strict-transport-security'), /includeSubDomains/);
});

test('GitHub device login fails closed until the operator enables it', async () => {
  const response = await worker.fetch(
    new Request('https://edge.runpublic.dev/_runpub/auth/github/device/start', {
      method: 'POST',
    }),
    { RUNPUB_DOMAIN: 'runpublic.dev', RUNPUB_SIGNUPS_ENABLED: 'false' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: 'SIGNUP_UNAVAILABLE', message: 'GitHub sign-in is not configured' },
  });
});

test('Cloudflare accepts former RunPublic environment and API names', async () => {
  const response = await worker.fetch(
    new Request('https://edge.runpublic.dev/_runpublic/auth/github/device/start', {
      method: 'POST',
    }),
    { RUNPUBLIC_DOMAIN: 'runpublic.dev', RUNPUBLIC_SIGNUPS_ENABLED: 'false' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SIGNUP_UNAVAILABLE');
});

test('Cloudflare does not double-compress encoded tunnel responses', () => {
  const compressed = tunnelResponseInit(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-encoding': 'gzip',
  });
  assert.equal(compressed.encodeBody, 'manual');
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');

  const identity = tunnelResponseInit(200, {
    'content-type': 'application/json',
  });
  assert.equal(identity.encodeBody, 'automatic');
});

test('Cloudflare edge rejects hostnames outside its managed domain', async () => {
  const response = await worker.fetch(
    new Request('https://attacker.example/'),
    { RUNPUB_DOMAIN: 'runpublic.dev' },
    { waitUntil() {} },
  );
  assert.equal(response.status, 404);
});
