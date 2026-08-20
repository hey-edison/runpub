# Production runbook

RunPublic's public edge is a Cloudflare Worker backed by Durable Objects and D1.
The Railway edge is retained as a single-replica fallback.

## First deployment

1. Install dependencies and authenticate the operator machine:

   ```bash
   npm ci
   npx wrangler login
   ```

2. Create the production database:

   ```bash
   npx wrangler d1 create runpublic-production
   ```

   Copy the returned database ID into `cloudflare/wrangler.jsonc` in place of
   `REPLACE_WITH_D1_DATABASE_ID`.

3. Apply the schema:

   ```bash
   npm run cloudflare:migrate
   ```

4. Generate a 32-byte-or-longer admin secret using a password generator. Store
   it in your password manager or at
   `~/.config/runpublic/operator-admin-secret` with mode `0600`, then send it
   directly to Wrangler without adding it to shell history:

   ```bash
   npx wrangler secret put RUNPUBLIC_ADMIN_SECRET --config cloudflare/wrangler.jsonc
   ```

5. Validate and deploy:

   ```bash
   npm run check
   npm run cloudflare:deploy
   curl https://edge.runpublic.dev/health
   ```

The existing proxied wildcard DNS record is sufficient for the Worker route.
Do not delete the Railway custom domain while it is the rollback origin.

## Create a developer account

The included admin tool reads the environment override or the private default
file described above:

```bash
npm run cloudflare:admin -- create-account keshavmac 25
```

The command prints a developer token exactly once. Deliver it through a secure
channel. The developer logs in with a temporary token file:

Set `RUNPUBLIC_TOKEN_OUTPUT_FILE` before the admin command when you want the
one-time token written directly to a new mode-`0600` file instead of displayed.

```bash
runpublic login \
  --server https://edge.runpublic.dev \
  --account keshavmac \
  --token-file /path/to/temporary-token
```

Delete the temporary file after login. Rotate a compromised token with:

```bash
npm run cloudflare:admin -- create-token keshavmac replacement --revoke-existing
```

## Release checklist

- Run `npm run check` and the local Worker/D1 integration test.
- Apply D1 migrations before code that depends on them.
- Deploy during a monitored window and verify health, login, HTTP, webhook POST,
  and WebSocket traffic.
- Watch Worker errors, Durable Object request failures, D1 errors, 429s, and
  p95/p99 latency.
- Confirm Railway remains at one replica.
- Export D1 before destructive migrations and test restore instructions.

## Rollback

If the Worker edge fails, remove or disable its `*.runpublic.dev/*` route in
Cloudflare. The existing wildcard DNS record will send requests to the Railway
origin again. The current CLI supports both protocol versions. Do not roll back
a D1 migration destructively; deploy forward-compatible code first.

## Secrets and data

- Cloudflare secret: `RUNPUBLIC_ADMIN_SECRET`.
- D1 stores account metadata, token hashes, reservations, and audit events.
- Developer machines store their plaintext token in
  `~/.config/runpublic/config.json` with mode `0600` by default.
- Do not log authorization headers, plaintext tokens, request bodies, or webhook
  contents.
- Define and publish retention, acceptable-use, privacy, and abuse-response
  policies before opening self-service signup.
