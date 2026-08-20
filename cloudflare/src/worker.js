const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_LABEL_LIMIT = 63;
const HASH_HEX_LENGTH = 32;
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const DEFAULT_MAX_PUBLIC_WEBSOCKETS = 128;
const DEFAULT_REQUESTS_PER_MINUTE = 600;
const STREAM_CHUNK_BYTES = 64 * 1024;
const ADMIN_BODY_LIMIT = 16 * 1024;
const DEFAULT_FREE_MAX_SERVICES = 10;
const GITHUB_API_VERSION = '2022-11-28';
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function envInteger(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function responseHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra,
  };
}

function json(payload, status = 200, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers: responseHeaders(extraHeaders),
  });
}

function text(message, status = 200, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: responseHeaders({
      'content-type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    }),
  });
}

function landingPage(domain) {
  const repository = 'https://github.com/hey-edison/runpublic';
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Stable public HTTPS URLs for local frontend, backend, and webhook development.">
  <title>RunPublic — localhost, publicly reachable</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f7f8fc; background: radial-gradient(circle at 20% 0%, #273063 0, #101426 38%, #080a12 78%); }
    main { width: min(760px, calc(100% - 40px)); padding: 72px 0; }
    .eyebrow { color: #9facff; font-size: 14px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 18px 0; max-width: 700px; font-size: clamp(46px, 9vw, 82px); line-height: .96; letter-spacing: -.055em; }
    p { max-width: 650px; color: #b8bed2; font-size: clamp(18px, 2.7vw, 22px); line-height: 1.55; }
    pre { margin: 34px 0; padding: 20px 22px; overflow-x: auto; border: 1px solid #333a59; border-radius: 14px; background: rgba(5, 7, 14, .78); color: #dfe3ff; font: 15px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
    nav { display: flex; flex-wrap: wrap; gap: 12px; }
    a { padding: 11px 16px; border: 1px solid #495277; border-radius: 10px; color: #f7f8fc; font-weight: 650; text-decoration: none; }
    a.primary { border-color: #8592ff; background: #6f7cff; color: #080a12; }
    .note { margin-top: 30px; color: #828aa5; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">RunPublic</div>
    <h1>localhost, publicly reachable.</h1>
    <p>Give every local frontend, API, and webhook a stable HTTPS URL. Install one CLI, sign in with GitHub, and keep your Cloudflare setup out of every developer's way.</p>
    <pre><code>npm install --global runpublic
runpublic login
runpublic expose 3000 --project my-app --service frontend</code></pre>
    <nav>
      <a class="primary" href="${repository}">View on GitHub</a>
      <a href="${repository}/#readme">Read the docs</a>
      <a href="${repository}/discussions">Share feedback</a>
    </nav>
    <div class="note">Public beta · Hosted on Cloudflare at ${domain} · No end-user Cloudflare account required</div>
  </main>
</body>
</html>`, {
    headers: responseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    }),
  });
}

function errorResponse(code, message, status) {
  return json({ error: { code, message } }, status);
}

function normalizeDomain(value) {
  const domain = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\.+|\.+$/g, '')
    .split('/')[0];
  if (!domain || domain.length > 253) throw new Error('RUNPUBLIC_DOMAIN is invalid');
  const labels = domain.split('.');
  if (labels.some((label) => !NAME_PATTERN.test(label))) {
    throw new Error('RUNPUBLIC_DOMAIN is invalid');
  }
  return domain;
}

function validateName(value, label) {
  const name = String(value || '');
  if (!NAME_PATTERN.test(name)) {
    throw new RequestError(
      'INVALID_NAME',
      `${label} must be lowercase and contain only letters, numbers, and hyphens`,
      400,
    );
  }
  return name;
}

function sanitizeDnsLabel(value, fallback) {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || fallback;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
}

export async function createServiceLabel({ project, service, account }) {
  const full = [
    sanitizeDnsLabel(project, 'project'),
    sanitizeDnsLabel(service, 'service'),
    sanitizeDnsLabel(account, 'user'),
  ].join('-');
  if (full.length <= DNS_LABEL_LIMIT) return full;
  const digest = (await sha256(full)).slice(0, HASH_HEX_LENGTH);
  const prefix = full
    .slice(0, DNS_LABEL_LIMIT - HASH_HEX_LENGTH - 1)
    .replace(/-+$/g, '');
  return `${prefix}-${digest}`;
}

export async function createHostname({ project, service, account, domain }) {
  return `${await createServiceLabel({ project, service, account })}.${normalizeDomain(domain)}`;
}

function bearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] || '';
}

async function authenticate(request, env) {
  const token = bearerToken(request);
  if (!token) throw new RequestError('UNAUTHORIZED', 'A RunPublic token is required', 401);
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT a.id, a.slug, a.status, a.max_services AS maxServices,
            t.id AS tokenId
       FROM api_tokens t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
      LIMIT 1`,
  )
    .bind(tokenHash)
    .first();
  if (!row || row.status !== 'active') {
    throw new RequestError('UNAUTHORIZED', 'The RunPublic token is invalid or revoked', 401);
  }
  return row;
}

async function reserveService(env, account, project, service, hostname) {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO services
         (id, account_id, project_slug, service_slug, hostname, status)
       SELECT ?, a.id, ?, ?, ?, 'active'
         FROM accounts a
        WHERE a.id = ?
          AND a.status = 'active'
          AND (SELECT COUNT(*) FROM services s
                WHERE s.account_id = a.id AND s.status = 'active') < a.max_services
       ON CONFLICT(account_id, project_slug, service_slug)
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(id, project, service, hostname, account.id)
      .run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || error))) {
      throw new RequestError('HOSTNAME_CONFLICT', 'That hostname is already reserved', 409);
    }
    throw error;
  }

  const reserved = await env.DB.prepare(
    `SELECT id, hostname, status
       FROM services
      WHERE account_id = ? AND project_slug = ? AND service_slug = ?
      LIMIT 1`,
  )
    .bind(account.id, project, service)
    .first();
  if (reserved?.hostname === hostname && reserved.status === 'active') return reserved;
  if (reserved && reserved.hostname !== hostname) {
    throw new RequestError('HOSTNAME_CONFLICT', 'This service has a conflicting reservation', 409);
  }

  const usage = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM services WHERE account_id = ? AND status = 'active'`,
  )
    .bind(account.id)
    .first();
  if (Number(usage?.count || 0) >= Number(account.maxServices)) {
    throw new RequestError('SERVICE_QUOTA_EXCEEDED', 'This account has reached its service quota', 429);
  }
  throw new RequestError('HOSTNAME_CONFLICT', 'That hostname is already reserved', 409);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `rp_live_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

async function parseSmallJson(request) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > ADMIN_BODY_LIMIT) {
    throw new RequestError('BODY_TOO_LARGE', 'Request body is too large', 413);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > ADMIN_BODY_LIMIT) {
    throw new RequestError('BODY_TOO_LARGE', 'Request body is too large', 413);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new RequestError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
}

async function requireAdmin(request, env) {
  if (!env.RUNPUBLIC_ADMIN_SECRET) {
    throw new RequestError('NOT_FOUND', 'Not found', 404);
  }
  const supplied = bearerToken(request);
  const [left, right] = await Promise.all([
    sha256(supplied || 'missing'),
    sha256(env.RUNPUBLIC_ADMIN_SECRET),
  ]);
  if (left !== right) throw new RequestError('UNAUTHORIZED', 'Invalid admin credential', 401);
}

async function createAccount(request, env) {
  const body = await parseSmallJson(request);
  const slug = validateName(body.account, 'account');
  const maxServices = Number(body.maxServices ?? 25);
  if (!Number.isInteger(maxServices) || maxServices < 1 || maxServices > 10_000) {
    throw new RequestError('INVALID_QUOTA', 'maxServices must be between 1 and 10000', 400);
  }
  const accountId = crypto.randomUUID();
  const tokenId = crypto.randomUUID();
  const token = randomToken();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, slug, display_name, status, max_services)
         VALUES (?, ?, ?, 'active', ?)`,
      ).bind(accountId, slug, String(body.displayName || slug).slice(0, 120), maxServices),
      env.DB.prepare(
        `INSERT INTO api_tokens (id, account_id, name, token_prefix, token_hash)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(tokenId, accountId, 'initial', token.slice(0, 16), await sha256(token)),
      env.DB.prepare(
        `INSERT INTO audit_log (id, account_id, action, metadata_json)
         VALUES (?, ?, 'account.created', ?)`,
      ).bind(crypto.randomUUID(), accountId, JSON.stringify({ slug, maxServices })),
    ]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || error))) {
      throw new RequestError('ACCOUNT_EXISTS', 'That account name is already reserved', 409);
    }
    throw error;
  }
  return json({
    account: { id: accountId, slug, maxServices },
    token: { id: tokenId, value: token, shownOnce: true },
  }, 201);
}

async function createAccountToken(request, env, slug) {
  const body = await parseSmallJson(request);
  const account = await env.DB.prepare(
    `SELECT id, slug FROM accounts WHERE slug = ? AND status = 'active' LIMIT 1`,
  )
    .bind(validateName(slug, 'account'))
    .first();
  if (!account) throw new RequestError('ACCOUNT_NOT_FOUND', 'Account not found', 404);
  const token = randomToken();
  const tokenId = crypto.randomUUID();
  const statements = [];
  if (body.revokeExisting === true) {
    statements.push(
      env.DB.prepare(
        `UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP
          WHERE account_id = ? AND revoked_at IS NULL`,
      ).bind(account.id),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO api_tokens (id, account_id, name, token_prefix, token_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      tokenId,
      account.id,
      String(body.name || 'generated').slice(0, 80),
      token.slice(0, 16),
      await sha256(token),
    ),
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_log (id, account_id, action, metadata_json)
       VALUES (?, ?, 'token.created', ?)`,
    ).bind(crypto.randomUUID(), account.id, JSON.stringify({ tokenId })),
  );
  await env.DB.batch(statements);
  return json({ token: { id: tokenId, value: token, shownOnce: true } }, 201);
}

async function revokeAccountToken(env, slug, tokenId) {
  const result = await env.DB.prepare(
    `UPDATE api_tokens
        SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND account_id = (SELECT id FROM accounts WHERE slug = ?)`,
  )
    .bind(tokenId, validateName(slug, 'account'))
    .run();
  if (!result.meta?.changes) throw new RequestError('TOKEN_NOT_FOUND', 'Token not found', 404);
  return new Response(null, { status: 204, headers: responseHeaders() });
}

async function listAccounts(env) {
  const result = await env.DB.prepare(
    `SELECT a.id, a.slug, a.status, a.max_services AS maxServices,
            COUNT(s.id) AS serviceCount, a.created_at AS createdAt
       FROM accounts a
       LEFT JOIN services s ON s.account_id = a.id AND s.status = 'active'
      GROUP BY a.id
      ORDER BY a.created_at DESC
      LIMIT 500`,
  ).all();
  return json({ accounts: result.results || [] });
}

async function handleAdmin(request, env, path) {
  await requireAdmin(request, env);
  if (path === '/_runpublic/admin/accounts') {
    if (request.method === 'POST') return createAccount(request, env);
    if (request.method === 'GET') return listAccounts(env);
  }
  const tokenCollection = /^\/_runpublic\/admin\/accounts\/([^/]+)\/tokens$/.exec(path);
  if (tokenCollection && request.method === 'POST') {
    return createAccountToken(request, env, decodeURIComponent(tokenCollection[1]));
  }
  const tokenItem = /^\/_runpublic\/admin\/accounts\/([^/]+)\/tokens\/([^/]+)$/.exec(path);
  if (tokenItem && request.method === 'DELETE') {
    return revokeAccountToken(
      env,
      decodeURIComponent(tokenItem[1]),
      decodeURIComponent(tokenItem[2]),
    );
  }
  return errorResponse('NOT_FOUND', 'Admin endpoint not found', 404);
}

async function handleMe(request, env) {
  const account = await authenticate(request, env);
  const usage = await env.DB.prepare(
    `SELECT COUNT(*) AS serviceCount FROM services
      WHERE account_id = ? AND status = 'active'`,
  )
    .bind(account.id)
    .first();
  return json({
    account: account.slug,
    limits: { services: Number(account.maxServices) },
    usage: { services: Number(usage?.serviceCount || 0) },
  });
}

function githubAuthEnabled(env) {
  return env.RUNPUBLIC_SIGNUPS_ENABLED === 'true' && Boolean(env.RUNPUBLIC_GITHUB_CLIENT_ID);
}

async function githubFormRequest(url, fields) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'runpublic-edge',
      },
      body: new URLSearchParams(fields).toString(),
    });
  } catch {
    throw new RequestError('GITHUB_UNAVAILABLE', 'GitHub login is temporarily unavailable', 502);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RequestError('GITHUB_UNAVAILABLE', 'GitHub login is temporarily unavailable', 502);
  }
  return payload;
}

async function startGithubDeviceLogin(env) {
  if (!githubAuthEnabled(env)) {
    throw new RequestError('SIGNUP_UNAVAILABLE', 'GitHub sign-in is not configured', 503);
  }
  const payload = await githubFormRequest('https://github.com/login/device/code', {
    client_id: env.RUNPUBLIC_GITHUB_CLIENT_ID,
  });
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw new RequestError('GITHUB_UNAVAILABLE', 'GitHub returned an invalid login response', 502);
  }
  return json({
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    expiresIn: Number(payload.expires_in || 900),
    interval: Number(payload.interval || 5),
  });
}

async function githubUser(accessToken) {
  let response;
  try {
    response = await fetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'runpublic-edge',
        'x-github-api-version': GITHUB_API_VERSION,
      },
    });
  } catch {
    throw new RequestError('GITHUB_UNAVAILABLE', 'GitHub login is temporarily unavailable', 502);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id || !payload.login) {
    throw new RequestError('GITHUB_IDENTITY_INVALID', 'GitHub could not verify this identity', 401);
  }
  return payload;
}

async function accountForGithub(env, user, requestedSlug) {
  const githubUserId = String(user.id);
  let account = await env.DB.prepare(
    `SELECT id, slug, max_services AS maxServices
       FROM accounts WHERE github_user_id = ? LIMIT 1`,
  ).bind(githubUserId).first();
  if (account) return account;

  const explicitSlug = requestedSlug ? validateName(requestedSlug, 'account') : '';
  const base = explicitSlug || sanitizeDnsLabel(user.login, 'github-user').slice(0, DNS_LABEL_LIMIT);
  const suffix = (await sha256(githubUserId)).slice(0, 8);
  const candidates = explicitSlug
    ? [explicitSlug]
    : [
        base,
        `${base.slice(0, DNS_LABEL_LIMIT - suffix.length - 1).replace(/-+$/g, '')}-${suffix}`,
      ];
  const maxServices = envInteger(
    env,
    'RUNPUBLIC_FREE_MAX_SERVICES',
    DEFAULT_FREE_MAX_SERVICES,
  );

  for (const slug of candidates) {
    try {
      await env.DB.prepare(
        `INSERT INTO accounts
           (id, slug, display_name, status, max_services, github_user_id)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        slug,
        String(user.name || user.login).slice(0, 120),
        maxServices,
        githubUserId,
      ).run();
    } catch (error) {
      if (!/unique|constraint/i.test(String(error?.message || error))) throw error;
    }
    account = await env.DB.prepare(
      `SELECT id, slug, max_services AS maxServices
         FROM accounts WHERE github_user_id = ? LIMIT 1`,
    ).bind(githubUserId).first();
    if (account) return account;
  }
  throw new RequestError(
    'ACCOUNT_CONFLICT',
    explicitSlug
      ? `The RunPublic account name "${explicitSlug}" is already reserved`
      : 'Could not reserve a RunPublic account name',
    409,
  );
}

async function issueGithubLoginToken(env, account, user) {
  const token = randomToken();
  const tokenId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO api_tokens (id, account_id, name, token_prefix, token_hash)
       VALUES (?, ?, 'github-device', ?, ?)`,
    ).bind(tokenId, account.id, token.slice(0, 16), await sha256(token)),
    env.DB.prepare(
      `INSERT INTO audit_log (id, account_id, action, metadata_json)
       VALUES (?, ?, 'github.login', ?)`,
    ).bind(
      crypto.randomUUID(),
      account.id,
      JSON.stringify({ githubUserId: String(user.id), githubLogin: user.login, tokenId }),
    ),
  ]);
  await env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP
      WHERE account_id = ? AND revoked_at IS NULL AND id NOT IN (
        SELECT id FROM api_tokens
         WHERE account_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 10
      )`,
  ).bind(account.id, account.id).run();
  return { tokenId, token };
}

async function pollGithubDeviceLogin(request, env) {
  if (!githubAuthEnabled(env)) {
    throw new RequestError('SIGNUP_UNAVAILABLE', 'GitHub sign-in is not configured', 503);
  }
  const body = await parseSmallJson(request);
  const deviceCode = String(body.deviceCode || '');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(deviceCode)) {
    throw new RequestError('INVALID_DEVICE_CODE', 'The GitHub device code is invalid', 400);
  }
  const payload = await githubFormRequest('https://github.com/login/oauth/access_token', {
    client_id: env.RUNPUBLIC_GITHUB_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (payload.error === 'authorization_pending') {
    return json({ status: 'pending' }, 202, { 'retry-after': '5' });
  }
  if (payload.error === 'slow_down') {
    return json({ status: 'pending', slowDown: true }, 202, { 'retry-after': '10' });
  }
  if (payload.error) {
    const messages = {
      access_denied: 'GitHub sign-in was cancelled',
      expired_token: 'The GitHub device code expired; run login again',
      incorrect_device_code: 'The GitHub device code is invalid',
      device_flow_disabled: 'GitHub device login is not enabled for RunPublic',
    };
    throw new RequestError(
      'GITHUB_LOGIN_FAILED',
      messages[payload.error] || 'GitHub sign-in failed',
      400,
    );
  }
  if (!payload.access_token) {
    throw new RequestError('GITHUB_UNAVAILABLE', 'GitHub returned an invalid login response', 502);
  }

  const user = await githubUser(payload.access_token);
  const requestedAccount = body.account === undefined ? '' : String(body.account);
  const account = await accountForGithub(env, user, requestedAccount);
  const issued = await issueGithubLoginToken(env, account, user);
  return json({
    account: account.slug,
    limits: { services: Number(account.maxServices) },
    token: { id: issued.tokenId, value: issued.token, shownOnce: true },
  }, 201);
}

async function handleAgentConnect(request, env, executionContext, domain) {
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return text('WebSocket upgrade required', 426);
  }
  const url = new URL(request.url);
  const accountName = validateName(url.searchParams.get('account'), 'account');
  const project = validateName(url.searchParams.get('project'), 'project');
  const service = validateName(url.searchParams.get('service'), 'service');
  const account = await authenticate(request, env);
  if (account.slug !== accountName) {
    throw new RequestError('ACCOUNT_MISMATCH', 'Token is not authorized for this account', 403);
  }
  const hostname = await createHostname({ account: account.slug, project, service, domain });
  await reserveService(env, account, project, service, hostname);
  executionContext.waitUntil(
    env.DB.prepare(`UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(account.tokenId)
      .run()
      .catch(() => {}),
  );

  const id = env.TUNNELS.idFromName(hostname);
  const stub = env.TUNNELS.get(id);
  const headers = new Headers(request.headers);
  headers.set('x-runpublic-role', 'agent');
  headers.set('x-runpublic-account', account.slug);
  headers.set('x-runpublic-project', project);
  headers.set('x-runpublic-service', service);
  headers.set('x-runpublic-hostname', hostname);
  headers.delete('authorization');
  return stub.fetch(
    new Request('https://tunnel.internal/_runpublic/connect', {
      method: 'GET',
      headers,
    }),
  );
}

function isPublicHostname(hostname, domain) {
  return hostname.endsWith(`.${domain}`) && hostname.length > domain.length + 1;
}

export default {
  async fetch(request, env, executionContext) {
    try {
      const domain = normalizeDomain(env.RUNPUBLIC_DOMAIN);
      const url = new URL(request.url);
      const developmentHostname =
        env.RUNPUBLIC_DEV_MODE === 'true' ? request.headers.get('x-runpublic-test-host') : '';
      const developmentApiHostname =
        env.RUNPUBLIC_DEV_MODE === 'true' && url.pathname.startsWith('/_runpublic/')
          ? `edge.${domain}`
          : '';
      const hostname = String(developmentHostname || developmentApiHostname || url.hostname)
        .toLowerCase()
        .replace(/\.$/, '');
      const edgeHostname = `edge.${domain}`;

      if (hostname === domain && request.method === 'GET' && url.pathname === '/') {
        return landingPage(domain);
      }

      if (hostname === edgeHostname && (url.pathname === '/health' || url.pathname === '/healthz')) {
        return json({ status: 'ok', architecture: 'durable-objects', version: '0.2.0' });
      }
      if (hostname === edgeHostname && url.pathname === '/_runpublic/me') {
        return await handleMe(request, env);
      }
      if (
        hostname === edgeHostname &&
        request.method === 'POST' &&
        url.pathname === '/_runpublic/auth/github/device/start'
      ) {
        return await startGithubDeviceLogin(env);
      }
      if (
        hostname === edgeHostname &&
        request.method === 'POST' &&
        url.pathname === '/_runpublic/auth/github/device/poll'
      ) {
        return await pollGithubDeviceLogin(request, env);
      }
      if (hostname === edgeHostname && url.pathname.startsWith('/_runpublic/admin/')) {
        return await handleAdmin(request, env, url.pathname);
      }
      if (hostname === edgeHostname && url.pathname === '/_runpublic/connect') {
        return await handleAgentConnect(request, env, executionContext, domain);
      }
      if (!isPublicHostname(hostname, domain) || hostname === edgeHostname) {
        return errorResponse('NOT_FOUND', 'RunPublic endpoint not found', 404);
      }

      const stub = env.TUNNELS.get(env.TUNNELS.idFromName(hostname));
      return await stub.fetch(request);
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(error.code, error.message, error.status);
      }
      console.error(JSON.stringify({ event: 'worker_error', message: String(error?.message || error) }));
      return errorResponse('INTERNAL_ERROR', 'RunPublic could not process this request', 500);
    }
  },
};

class RequestError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function safeHeaders(value) {
  const result = new Headers();
  if (!value || typeof value !== 'object') return result;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName).toLowerCase();
    if (HOP_BY_HOP.has(name) || rawValue == null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const item of values) {
      try {
        result.append(name, String(item));
      } catch {
        // Invalid local response headers are omitted instead of poisoning the response.
      }
    }
  }
  result.set('x-runpublic-edge', 'cloudflare');
  return result;
}

function requestHeaders(request) {
  const result = {};
  for (const [name, value] of request.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  const url = new URL(request.url);
  result['x-forwarded-host'] = request.headers.get('host') || url.hostname;
  result['x-forwarded-proto'] = url.protocol.replace(':', '');
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) result['x-forwarded-for'] = clientIp;
  return result;
}

function base64Encode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let result = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(result);
}

function base64Decode(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function validCloseCode(value, fallback = 1000) {
  const code = Number(value);
  const standard = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code);
  const application = code >= 3000 && code <= 4999;
  return Number.isInteger(code) && (standard || application) ? code : fallback;
}

export class TunnelSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map();
    this.publicSockets = new Map();
    this.rateWindowStartedAt = Date.now();
    this.rateWindowCount = 0;
    this.agent = null;
    for (const socket of state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.role === 'agent') this.agent = socket;
      if (attachment.role === 'public' && attachment.id) {
        this.publicSockets.set(attachment.id, socket);
      }
    }
  }

  async fetch(request) {
    const role = request.headers.get('x-runpublic-role');
    if (role === 'agent') return this.acceptAgent(request);
    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return this.acceptPublicWebSocket(request);
    }
    return this.forwardHttp(request);
  }

  limits() {
    return {
      bodyBytes: envInteger(this.env, 'RUNPUBLIC_MAX_BODY_BYTES', DEFAULT_BODY_LIMIT),
      timeoutMs: envInteger(
        this.env,
        'RUNPUBLIC_REQUEST_TIMEOUT_MS',
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      pendingRequests: envInteger(
        this.env,
        'RUNPUBLIC_MAX_PENDING_REQUESTS',
        DEFAULT_MAX_PENDING_REQUESTS,
      ),
      publicWebSockets: envInteger(
        this.env,
        'RUNPUBLIC_MAX_PUBLIC_WEBSOCKETS',
        DEFAULT_MAX_PUBLIC_WEBSOCKETS,
      ),
      requestsPerMinute: envInteger(
        this.env,
        'RUNPUBLIC_REQUESTS_PER_MINUTE',
        DEFAULT_REQUESTS_PER_MINUTE,
      ),
    };
  }

  activeAgent() {
    if (this.agent?.readyState === 1) return this.agent;
    this.agent = this.state.getWebSockets('agent').find((socket) => socket.readyState === 1) || null;
    return this.agent;
  }

  acceptAgent(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const existing = this.activeAgent();
    if (existing) existing.close(1012, 'Replaced by a newer RunPublic connection');
    const attachment = {
      role: 'agent',
      account: request.headers.get('x-runpublic-account'),
      project: request.headers.get('x-runpublic-project'),
      service: request.headers.get('x-runpublic-service'),
      hostname: request.headers.get('x-runpublic-hostname'),
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, ['agent']);
    this.agent = server;
    server.send(
      JSON.stringify({
        type: 'registered',
        protocol: 2,
        hostname: attachment.hostname,
        publicUrl: `https://${attachment.hostname}`,
        limits: {
          requestBodyBytes: this.limits().bodyBytes,
          responseBodyBytes: this.limits().bodyBytes,
        },
      }),
    );
    console.log(JSON.stringify({ event: 'tunnel_online', hostname: attachment.hostname }));
    return new Response(null, { status: 101, webSocket: client });
  }

  allowRequest() {
    const now = Date.now();
    if (now - this.rateWindowStartedAt >= 60_000) {
      this.rateWindowStartedAt = now;
      this.rateWindowCount = 0;
    }
    this.rateWindowCount += 1;
    return this.rateWindowCount <= this.limits().requestsPerMinute;
  }

  async forwardHttp(request) {
    const agent = this.activeAgent();
    if (!agent) return text('No active RunPublic tunnel for this hostname', 404);
    if (!this.allowRequest()) {
      return text('RunPublic rate limit exceeded', 429, { 'retry-after': '60' });
    }
    const limits = this.limits();
    if (this.pending.size >= limits.pendingRequests) {
      return text('RunPublic tunnel is busy', 503, { 'retry-after': '1' });
    }
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > limits.bodyBytes) {
      return text('Request body exceeded the RunPublic limit', 413);
    }

    const id = crypto.randomUUID();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    let resolveStart;
    const start = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const timer = setTimeout(() => {
      this.failPending(id, 504, 'RunPublic tunnel request timed out');
      this.sendAgent({ type: 'http_cancel', id });
    }, limits.timeoutMs);
    this.pending.set(id, {
      id,
      writer,
      readable: stream.readable,
      resolveStart,
      started: false,
      totalResponseBytes: 0,
      method: request.method,
      discardBody: false,
      timer,
    });

    if (!this.sendAgent({
      type: 'http_request_start',
      id,
      method: request.method,
      path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
      headers: requestHeaders(request),
    })) {
      this.failPending(id, 502, 'RunPublic tunnel disconnected');
      return start;
    }

    const pump = this.pumpRequestBody(id, request, limits.bodyBytes);
    this.state.waitUntil(pump);
    request.signal.addEventListener(
      'abort',
      () => {
        this.cancelPending(id);
        this.sendAgent({ type: 'http_cancel', id });
      },
      { once: true },
    );
    return start;
  }

  async pumpRequestBody(id, request, maxBytes) {
    let total = 0;
    try {
      if (request.body) {
        const reader = request.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel('RunPublic body limit exceeded');
            this.failPending(id, 413, 'Request body exceeded the RunPublic limit');
            this.sendAgent({ type: 'http_cancel', id });
            return;
          }
          for (let offset = 0; offset < value.byteLength; offset += STREAM_CHUNK_BYTES) {
            if (!this.pending.has(id)) return;
            const chunk = value.subarray(offset, offset + STREAM_CHUNK_BYTES);
            if (!this.sendAgent({ type: 'http_request_chunk', id, data: base64Encode(chunk) })) {
              this.failPending(id, 502, 'RunPublic tunnel disconnected');
              return;
            }
          }
        }
      }
      if (this.pending.has(id)) this.sendAgent({ type: 'http_request_end', id });
    } catch (error) {
      this.failPending(id, 400, `Could not read request body: ${error.message}`);
      this.sendAgent({ type: 'http_cancel', id });
    }
  }

  acceptPublicWebSocket(request) {
    const agent = this.activeAgent();
    if (!agent) return text('No active RunPublic tunnel for this hostname', 404);
    if (!this.allowRequest()) return text('RunPublic rate limit exceeded', 429);
    if (this.publicSockets.size >= this.limits().publicWebSockets) {
      return text('RunPublic WebSocket limit exceeded', 503);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    server.serializeAttachment({ role: 'public', id });
    this.state.acceptWebSocket(server, ['public']);
    this.publicSockets.set(id, server);
    this.sendAgent({
      type: 'ws_open',
      id,
      path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
      headers: requestHeaders(request),
      protocols: (request.headers.get('sec-websocket-protocol') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    });
    const requestedProtocol = (request.headers.get('sec-websocket-protocol') || '')
      .split(',')
      .map((value) => value.trim())
      .find(Boolean);
    const headers = requestedProtocol ? { 'sec-websocket-protocol': requestedProtocol } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  sendAgent(message) {
    const agent = this.activeAgent();
    if (!agent) return false;
    try {
      agent.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  async webSocketMessage(socket, raw) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role === 'agent') {
      if (typeof raw !== 'string') return socket.close(1003, 'JSON messages required');
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return socket.close(1003, 'Invalid JSON');
      }
      await this.handleAgentMessage(message);
      return;
    }
    if (attachment.role === 'public') {
      const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
      if (bytes.byteLength > this.limits().bodyBytes) {
        socket.close(1009, 'Message exceeded RunPublic limit');
        return;
      }
      this.sendAgent({
        type: 'ws_data',
        id: attachment.id,
        binary: typeof raw !== 'string',
        data: base64Encode(bytes),
      });
    }
  }

  async handleAgentMessage(message) {
    const id = String(message.id || '');
    if (message.type === 'register') return;
    if (message.type === 'http_response_start') {
      const pending = this.pending.get(id);
      if (!pending || pending.started) return;
      const status = Number(message.statusCode);
      const statusCode = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
      pending.started = true;
      pending.discardBody =
        pending.method === 'HEAD' || statusCode === 204 || statusCode === 205 || statusCode === 304;
      pending.resolveStart(
        new Response(pending.discardBody ? null : pending.readable, {
          status: statusCode,
          headers: safeHeaders(message.headers),
        }),
      );
      if (pending.discardBody) pending.writer.abort('Response does not permit a body').catch(() => {});
      return;
    }
    if (message.type === 'http_response_chunk') {
      const pending = this.pending.get(id);
      if (!pending?.started) return;
      if (pending.discardBody) return;
      const chunk = base64Decode(message.data);
      pending.totalResponseBytes += chunk.byteLength;
      if (pending.totalResponseBytes > this.limits().bodyBytes) {
        this.failPending(id, 502, 'Tunnel response exceeded the RunPublic limit');
        this.sendAgent({ type: 'http_cancel', id });
        return;
      }
      await pending.writer.write(chunk);
      return;
    }
    if (message.type === 'http_response_end') {
      const pending = this.pending.get(id);
      if (!pending) return;
      if (!pending.started) {
        pending.started = true;
        pending.resolveStart(new Response(null, { status: 204, headers: responseHeaders() }));
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (!pending.discardBody) await pending.writer.close().catch(() => {});
      return;
    }
    if (message.type === 'http_response_error') {
      this.failPending(id, 502, String(message.message || 'Local response failed'));
      return;
    }
    if (message.type === 'ws_data') {
      const target = this.publicSocket(id);
      if (!target || target.readyState !== 1) return;
      const bytes = base64Decode(message.data);
      if (bytes.byteLength > this.limits().bodyBytes) {
        target.close(1009, 'Message exceeded RunPublic limit');
        return;
      }
      target.send(message.binary ? bytes.buffer : new TextDecoder().decode(bytes));
      return;
    }
    if (message.type === 'ws_error' || message.type === 'ws_closed') {
      const target = this.publicSocket(id);
      if (!target) return;
      const safeCode = validCloseCode(message.code, 1011);
      target.close(safeCode, String(message.reason || message.message || '').slice(0, 123));
      this.publicSockets.delete(id);
    }
  }

  publicSocket(id) {
    const cached = this.publicSockets.get(id);
    if (cached) return cached;
    const found = this.state.getWebSockets('public').find((socket) => {
      return socket.deserializeAttachment()?.id === id;
    });
    if (found) this.publicSockets.set(id, found);
    return found;
  }

  failPending(id, status, message) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (!pending.started) {
      pending.started = true;
      pending.resolveStart(text(message, status));
      pending.writer.abort(message).catch(() => {});
    } else {
      pending.writer.abort(message).catch(() => {});
    }
  }

  cancelPending(id) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.writer.abort('Request cancelled').catch(() => {});
  }

  webSocketClose(socket, code, reason) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role === 'agent') {
      if (socket !== this.agent) return;
      this.agent = null;
      for (const id of [...this.pending.keys()]) {
        this.failPending(id, 502, 'RunPublic tunnel disconnected');
      }
      for (const [id, publicSocket] of this.publicSockets) {
        publicSocket.close(1012, 'RunPublic tunnel disconnected');
        this.publicSockets.delete(id);
      }
      console.log(JSON.stringify({ event: 'tunnel_offline', code, reason }));
      return;
    }
    if (attachment.role === 'public') {
      this.publicSockets.delete(attachment.id);
      this.sendAgent({
        type: 'ws_close',
        id: attachment.id,
        code: validCloseCode(code),
        reason: String(reason || '').slice(0, 123),
      });
    }
  }

  webSocketError(socket) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role === 'public') {
      this.publicSockets.delete(attachment.id);
      this.sendAgent({ type: 'ws_close', id: attachment.id, code: 1011, reason: 'WebSocket error' });
    }
  }
}
