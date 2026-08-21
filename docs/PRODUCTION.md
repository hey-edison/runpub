# Production runbook

RunPub's public edge is a Cloudflare Worker backed by Durable Objects and D1.
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

3. Apply every D1 migration:

   ```bash
   npm run cloudflare:migrate
   ```

4. Generate a 32-byte-or-longer admin secret using a password generator. Store
   it in your password manager or at
   `~/.config/runpub/operator-admin-secret` with mode `0600`, then send it
   directly to Wrangler without adding it to shell history:

   ```bash
   npx wrangler secret put RUNPUB_ADMIN_SECRET --config cloudflare/wrangler.jsonc
   ```

5. Register a GitHub OAuth app owned by the operator organization. Use
   `https://runpublic.dev` as its homepage and callback URL, enable Device Flow,
   and set the public client ID as `RUNPUB_GITHUB_CLIENT_ID` in
   `cloudflare/wrangler.jsonc`. No client secret is needed for GitHub device
   flow. Keep `RUNPUB_SIGNUPS_ENABLED=false` until the policies, rate limits,
   and smoke checks below are complete.

6. Validate and deploy:

   ```bash
   npm run check
   npm run cloudflare:deploy
   curl https://edge.runpublic.dev/health
   ```

The wildcard route handles tunnel hostnames. The apex `runpublic.dev` entry is a
Worker Custom Domain, so Cloudflare creates its DNS record and certificate. Do
not delete the Railway custom domain while it is the rollback origin.

7. Verify `runpub login --no-browser` with a test GitHub account, then change
   `RUNPUB_SIGNUPS_ENABLED` to `true`, deploy again, and repeat the login,
   HTTP, webhook, and WebSocket smoke tests.

## Create or recover a developer account

Developers normally run `runpub login`. GitHub device login provisions one
account per immutable GitHub user ID and gives it the configured free service
quota.

The operator tool remains available for support recovery, service accounts, and
private installations. It reads the environment override or the private default
admin-secret file:

```bash
npm run cloudflare:admin -- create-account keshavmac 25
```

The command prints a developer token exactly once. Deliver it through a secure
channel. The developer logs in with a temporary token file:

Set `RUNPUB_TOKEN_OUTPUT_FILE` before the admin command when you want the
one-time token written directly to a new mode-`0600` file instead of displayed.

```bash
runpub login \
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

- Cloudflare secret: `RUNPUB_ADMIN_SECRET`.
- D1 stores GitHub user IDs, account metadata, token hashes, reservations, and
  audit events. GitHub access tokens are used transiently and are not stored.
- Developer machines store their plaintext token in
  `~/.config/runpub/config.json` with mode `0600` by default.
- Do not log authorization headers, plaintext tokens, request bodies, or webhook
  contents.
- Review the published privacy, acceptable-use, and abuse-response policies
  before opening self-service signup.
