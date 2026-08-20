#!/usr/bin/env node

import { createEdgeServer } from '../src/edge-server.js';

function env(primary, legacy) {
  return process.env[primary] ?? process.env[legacy];
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function parseTokens(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('RUNPUBLIC_TOKENS_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RUNPUBLIC_TOKENS_JSON must map account names to tokens');
  }
  return parsed;
}

const allowAnonymous = parseBoolean(
  env('RUNPUBLIC_ALLOW_ANONYMOUS', 'DEVPUBLIC_ALLOW_ANONYMOUS'),
);
const tokens = parseTokens(env('RUNPUBLIC_TOKENS_JSON', 'DEVPUBLIC_TOKENS_JSON'));
const alphaAccount = env('RUNPUBLIC_ALPHA_ACCOUNT', 'DEVPUBLIC_ALPHA_ACCOUNT');
const alphaToken = env('RUNPUBLIC_ALPHA_TOKEN', 'DEVPUBLIC_ALPHA_TOKEN');
if (alphaAccount || alphaToken) {
  if (!alphaAccount || !alphaToken) {
    throw new Error('RUNPUBLIC_ALPHA_ACCOUNT and RUNPUBLIC_ALPHA_TOKEN must be set together');
  }
  tokens[alphaAccount] = alphaToken;
}
if (!allowAnonymous && Object.keys(tokens).length === 0) {
  throw new Error(
    'Set RUNPUBLIC_TOKENS_JSON, or explicitly set RUNPUBLIC_ALLOW_ANONYMOUS=true for development',
  );
}

const configuredPublicPort = env('RUNPUBLIC_PUBLIC_PORT', 'DEVPUBLIC_PUBLIC_PORT');
const edge = createEdgeServer({
  domain: env('RUNPUBLIC_DOMAIN', 'DEVPUBLIC_DOMAIN') || 'localhost',
  tokens,
  allowAnonymous,
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || env('RUNPUBLIC_PORT', 'DEVPUBLIC_PORT') || 8080),
  publicScheme: env('RUNPUBLIC_PUBLIC_SCHEME', 'DEVPUBLIC_PUBLIC_SCHEME') || 'https',
  publicPort: configuredPublicPort == null ? undefined : Number(configuredPublicPort),
});

const address = await edge.start();
const printableAddress = typeof address === 'object' && address
  ? `${address.address}:${address.port}`
  : String(address);
console.log(`RunPublic edge listening on ${printableAddress}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down RunPublic edge`);
  try {
    await edge.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(`RunPublic edge shutdown failed: ${error.message}`);
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
