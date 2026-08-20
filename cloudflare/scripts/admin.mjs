#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HELP = `RunPublic operator admin

Environment:
  RUNPUBLIC_ADMIN_URL       Default: https://edge.runpublic.dev
  RUNPUBLIC_ADMIN_SECRET    Optional environment override
  RUNPUBLIC_ADMIN_SECRET_FILE
                            Default: ~/.config/runpublic/operator-admin-secret
  RUNPUBLIC_TOKEN_OUTPUT_FILE
                            Optional private file for newly issued developer token

Commands:
  npm run cloudflare:admin -- create-account <account> [max-services]
  npm run cloudflare:admin -- list-accounts
  npm run cloudflare:admin -- create-token <account> [name] [--revoke-existing]
  npm run cloudflare:admin -- revoke-token <account> <token-id>
`;

const [command, ...args] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help') {
  process.stdout.write(HELP);
  process.exit(0);
}

const baseUrl = String(process.env.RUNPUBLIC_ADMIN_URL || 'https://edge.runpublic.dev').replace(/\/$/, '');
const adminSecretFile = path.resolve(
  process.env.RUNPUBLIC_ADMIN_SECRET_FILE ||
    path.join(os.homedir(), '.config', 'runpublic', 'operator-admin-secret'),
);
const adminSecret =
  process.env.RUNPUBLIC_ADMIN_SECRET ||
  (await readFile(adminSecretFile, 'utf8').then((value) => value.trim()).catch(() => ''));
if (!adminSecret) {
  process.stderr.write(
    `RUNPUBLIC_ADMIN_SECRET is required (or save it with mode 0600 at ${adminSecretFile})\n`,
  );
  process.exit(1);
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminSecret}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `admin API returned HTTP ${response.status}`);
  }
  return payload;
}

try {
  let result;
  if (command === 'create-account') {
    const [account, rawMaxServices] = args;
    if (!account) throw new Error('create-account requires an account name');
    const maxServices = rawMaxServices === undefined ? undefined : Number(rawMaxServices);
    result = await request('/_runpublic/admin/accounts', {
      method: 'POST',
      body: { account, ...(maxServices === undefined ? {} : { maxServices }) },
    });
  } else if (command === 'list-accounts') {
    result = await request('/_runpublic/admin/accounts');
  } else if (command === 'create-token') {
    const account = args[0];
    if (!account) throw new Error('create-token requires an account name');
    const revokeExisting = args.includes('--revoke-existing');
    const name = args.slice(1).find((value) => value !== '--revoke-existing');
    result = await request(`/_runpublic/admin/accounts/${encodeURIComponent(account)}/tokens`, {
      method: 'POST',
      body: { name, revokeExisting },
    });
  } else if (command === 'revoke-token') {
    const [account, tokenId] = args;
    if (!account || !tokenId) throw new Error('revoke-token requires an account and token ID');
    await request(
      `/_runpublic/admin/accounts/${encodeURIComponent(account)}/tokens/${encodeURIComponent(tokenId)}`,
      { method: 'DELETE' },
    );
    result = { revoked: true, tokenId };
  } else {
    throw new Error(`unknown command "${command}"`);
  }
  if (result?.token?.value && process.env.RUNPUBLIC_TOKEN_OUTPUT_FILE) {
    const outputPath = path.resolve(process.env.RUNPUBLIC_TOKEN_OUTPUT_FILE);
    await writeFile(outputPath, `${result.token.value}\n`, { flag: 'wx', mode: 0o600 });
    result.token.value = `<written to ${outputPath}>`;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`runpublic-admin: ${error.message}\n`);
  process.exitCode = 1;
}
