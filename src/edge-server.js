import { timingSafeEqual, randomUUID } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

import { createForwardHeaders, stripHopByHopHeaders } from './proxy-headers.js';
import {
  createHostname,
  createPublicUrl,
  normalizeDomain,
  slugifyDnsLabel,
} from './naming.js';

const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const REGISTER_TIMEOUT_MS = 5_000;

function json(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(body);
}

function text(response, statusCode, message) {
  const body = Buffer.from(message);
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  response.end(body);
}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) return socket.destroy();
  const body = Buffer.from(message);
  const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 404 ? 'Not Found' : 'Bad Gateway';
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n\r\n` +
      message,
  );
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenEntries(tokens) {
  if (tokens instanceof Map) return [...tokens.entries()];
  if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
    return Object.entries(tokens);
  }
  throw new TypeError('tokens must map RunPub account names to bearer tokens');
}

function authenticate(tokens, suppliedToken, allowAnonymous) {
  if (allowAnonymous) return { ok: true, account: null };
  if (!suppliedToken) return { ok: false, account: null };
  const entries = tokenEntries(tokens);

  for (const [account, configuredToken] of entries) {
    const possibleTokens = Array.isArray(configuredToken) ? configuredToken : [configuredToken];
    if (possibleTokens.some((candidate) => safeEqual(candidate, suppliedToken))) {
      return { ok: true, account: account == null ? null : String(account) };
    }
  }

  return { ok: false, account: null };
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] || '';
}

function requestHostname(request) {
  const host = String(request.headers.host || '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');
    return closingBracket === -1 ? host : host.slice(1, closingBracket);
  }
  return host.replace(/:\d+$/, '').replace(/\.$/, '');
}

function parseProtocols(header) {
  if (!header) return [];
  return String(header)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function validCloseCode(value, fallback = 1000) {
  const code = Number(value);
  const standard = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code);
  const application = code >= 3000 && code <= 4999;
  return Number.isInteger(code) && (standard || application) ? code : fallback;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function createEdgeServer(options = {}) {
  const domain = normalizeDomain(options.domain || 'localhost');
  const host = options.host || '0.0.0.0';
  const port = Number.isInteger(Number(options.port)) ? Number(options.port) : 8080;
  const tokens = options.tokens || {};
  const allowAnonymous = Boolean(options.allowAnonymous);
  const publicScheme = String(options.publicScheme || 'https').replace(/:$/, '').toLowerCase();
  if (publicScheme !== 'http' && publicScheme !== 'https') {
    throw new TypeError('publicScheme must be http or https');
  }
  const configuredPublicPort =
    options.publicPort == null || options.publicPort === '' ? undefined : Number(options.publicPort);
  const requestTimeoutMs = normalizePositiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const maxRequestBodyBytes = normalizePositiveInteger(
    options.maxRequestBodyBytes ?? options.maxBodyBytes ?? options.bodyLimitBytes,
    DEFAULT_BODY_LIMIT,
  );
  const maxResponseBodyBytes = normalizePositiveInteger(
    options.maxResponseBodyBytes ?? options.maxBodyBytes ?? options.bodyLimitBytes,
    DEFAULT_BODY_LIMIT,
  );

  const events = new EventEmitter();
  const tunnels = new Map();
  const connections = new Set();
  const pendingHttp = new Map();
  const publicWebSockets = new Map();

  const agentWss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: Math.max(maxRequestBodyBytes, maxResponseBodyBytes) * 2,
  });
  const publicWss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: maxRequestBodyBytes,
    handleProtocols(protocols) {
      return protocols.values().next().value || false;
    },
  });

  function sendTunnel(tunnel, message) {
    if (tunnel.socket.readyState !== WebSocket.OPEN) return false;
    tunnel.socket.send(JSON.stringify(message));
    return true;
  }

  function failPendingRequest(id, statusCode, message) {
    const pending = pendingHttp.get(id);
    if (!pending) return;
    pendingHttp.delete(id);
    clearTimeout(pending.timer);
    if (!pending.response.headersSent && !pending.response.destroyed) {
      text(pending.response, statusCode, message);
    } else if (!pending.response.destroyed) {
      pending.response.destroy();
    }
  }

  function cleanupTunnel(tunnel) {
    connections.delete(tunnel);
    if (tunnel.hostname && tunnels.get(tunnel.hostname) === tunnel) {
      tunnels.delete(tunnel.hostname);
      events.emit('tunnelOffline', { hostname: tunnel.hostname });
    }
    for (const [id, pending] of pendingHttp) {
      if (pending.tunnel === tunnel) failPendingRequest(id, 502, 'RunPub tunnel disconnected');
    }
    for (const [id, state] of publicWebSockets) {
      if (state.tunnel !== tunnel) continue;
      publicWebSockets.delete(id);
      state.socket.close(1012, 'RunPub tunnel disconnected');
    }
  }

  function registerTunnel(tunnel, message) {
    if (tunnel.hostname) return;
    let account;
    let project;
    let service;
    try {
      account = slugifyDnsLabel(message.account);
      project = slugifyDnsLabel(message.project);
      service = slugifyDnsLabel(message.service);
    } catch {
      sendTunnel(tunnel, {
        type: 'register_error',
        code: 'INVALID_REGISTRATION',
        message: 'account, project, and service must contain DNS-safe characters',
      });
      return tunnel.socket.close(1008, 'Invalid registration');
    }
    if (!account || !project || !service) {
      sendTunnel(tunnel, {
        type: 'register_error',
        code: 'INVALID_REGISTRATION',
        message: 'account, project, and service are required',
      });
      return tunnel.socket.close(1008, 'Invalid registration');
    }
    if (tunnel.authAccount) {
      let authenticatedAccount;
      try {
        authenticatedAccount = slugifyDnsLabel(tunnel.authAccount);
      } catch {
        sendTunnel(tunnel, {
          type: 'register_error',
          code: 'INVALID_TOKEN_CONFIGURATION',
          message: 'Token account configuration is invalid',
        });
        return tunnel.socket.close(1011, 'Invalid token configuration');
      }
      if (authenticatedAccount !== account) {
        sendTunnel(tunnel, {
          type: 'register_error',
          code: 'ACCOUNT_MISMATCH',
          message: 'Token is not authorized for this account',
        });
        return tunnel.socket.close(1008, 'Account mismatch');
      }
    }

    const hostname = createHostname({ account, project, service, domain });
    const existing = tunnels.get(hostname);
    tunnel.account = account;
    tunnel.project = project;
    tunnel.service = service;
    tunnel.hostname = hostname;
    tunnels.set(hostname, tunnel);

    if (existing && existing !== tunnel) {
      existing.socket.close(1012, 'Replaced by a newer connection');
    }

    let effectivePublicPort = configuredPublicPort;
    if (configuredPublicPort === 0) {
      const address = server.address();
      effectivePublicPort = address && typeof address === 'object' ? address.port : undefined;
    }
    const publicUrl = createPublicUrl({
      account,
      project,
      service,
      domain,
      scheme: publicScheme,
      port: effectivePublicPort,
    });
    sendTunnel(tunnel, {
      type: 'registered',
      hostname,
      publicUrl,
      limits: {
        requestBodyBytes: maxRequestBodyBytes,
        responseBodyBytes: maxResponseBodyBytes,
      },
    });
    events.emit('tunnelOnline', { hostname, account, project, service });
  }

  function handleHttpResponse(tunnel, message) {
    const id = String(message.id || '');
    const pending = pendingHttp.get(id);
    if (!pending || pending.tunnel !== tunnel) return;

    let body;
    try {
      body = message.body ? Buffer.from(message.body, 'base64') : Buffer.alloc(0);
    } catch {
      return failPendingRequest(id, 502, 'Tunnel returned an invalid response body');
    }
    if (body.length > maxResponseBodyBytes) {
      return failPendingRequest(id, 502, 'Tunnel response exceeded the body limit');
    }

    pendingHttp.delete(id);
    clearTimeout(pending.timer);
    const statusCode = Number(message.statusCode);
    const safeStatus = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      ? statusCode
      : 502;
    try {
      const headers = stripHopByHopHeaders(message.headers);
      pending.response.writeHead(safeStatus, headers);
      pending.response.end(body);
    } catch {
      if (!pending.response.headersSent) text(pending.response, 502, 'Tunnel returned invalid headers');
      else pending.response.destroy();
    }
  }

  function handleAgentMessage(tunnel, raw, isBinary) {
    if (isBinary) return tunnel.socket.close(1003, 'JSON messages required');
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return tunnel.socket.close(1003, 'Invalid JSON');
    }

    switch (message.type) {
      case 'register':
        registerTunnel(tunnel, message);
        break;
      case 'http_response':
        handleHttpResponse(tunnel, message);
        break;
      case 'ws_opened': {
        const state = publicWebSockets.get(String(message.id || ''));
        if (state?.tunnel === tunnel) state.opened = true;
        break;
      }
      case 'ws_data': {
        const state = publicWebSockets.get(String(message.id || ''));
        if (state?.tunnel !== tunnel || state.socket.readyState !== WebSocket.OPEN) break;
        const data = message.data ? Buffer.from(message.data, 'base64') : Buffer.alloc(0);
        if (data.length > maxResponseBodyBytes) {
          state.socket.close(1009, 'Message exceeded tunnel limit');
          break;
        }
        state.socket.send(data, { binary: Boolean(message.binary) });
        break;
      }
      case 'ws_error': {
        const id = String(message.id || '');
        const state = publicWebSockets.get(id);
        if (state?.tunnel === tunnel) {
          publicWebSockets.delete(id);
          state.socket.close(1011, String(message.message || 'Local WebSocket failed').slice(0, 123));
        }
        break;
      }
      case 'ws_closed': {
        const id = String(message.id || '');
        const state = publicWebSockets.get(id);
        if (state?.tunnel === tunnel) {
          publicWebSockets.delete(id);
          state.socket.close(
            validCloseCode(message.code),
            String(message.reason || '').slice(0, 123),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  agentWss.on('connection', (socket, request, authentication) => {
    const tunnel = {
      socket,
      authAccount: authentication.account,
      hostname: null,
      account: null,
      project: null,
      service: null,
    };
    connections.add(tunnel);
    const registerTimer = setTimeout(() => {
      if (!tunnel.hostname) socket.close(1008, 'Registration timed out');
    }, REGISTER_TIMEOUT_MS);
    registerTimer.unref?.();

    socket.on('message', (data, isBinary) => handleAgentMessage(tunnel, data, isBinary));
    socket.on('close', () => {
      clearTimeout(registerTimer);
      cleanupTunnel(tunnel);
    });
    socket.on('error', () => {});
  });

  publicWss.on('connection', (socket, request, tunnel) => {
    const id = randomUUID();
    const state = { socket, tunnel, opened: false };
    publicWebSockets.set(id, state);
    const protocols = parseProtocols(request.headers['sec-websocket-protocol']);
    const sent = sendTunnel(tunnel, {
      type: 'ws_open',
      id,
      path: request.url || '/',
      headers: createForwardHeaders(request.headers, request, {
        scheme: publicScheme,
        websocket: true,
      }),
      protocols,
    });
    if (!sent) {
      publicWebSockets.delete(id);
      return socket.close(1012, 'Tunnel unavailable');
    }

    socket.on('message', (data, isBinary) => {
      const sentData = sendTunnel(tunnel, {
        type: 'ws_data',
        id,
        binary: Boolean(isBinary),
        data: Buffer.from(data).toString('base64'),
      });
      if (!sentData) socket.close(1012, 'Tunnel unavailable');
    });
    socket.on('close', (code, reason) => {
      publicWebSockets.delete(id);
      sendTunnel(tunnel, {
        type: 'ws_close',
        id,
        code,
        reason: Buffer.from(reason).toString('utf8'),
      });
    });
    socket.on('error', () => {});
  });

  const server = http.createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://runpub.invalid').pathname;
    if (
      path === '/health' ||
      path === '/healthz' ||
      path === '/_runpub/health' ||
      path === '/_runpublic/health' ||
      path === '/_devpublic/health'
    ) {
      return json(response, 200, {
        status: 'ok',
        architecture: 'node-single-edge',
        tunnels: tunnels.size,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }
    if (path === '/_runpub/me' || path === '/_runpublic/me') {
      const authentication = authenticate(tokens, bearerToken(request), false);
      if (!authentication.ok) {
        response.setHeader('www-authenticate', 'Bearer realm="RunPub"');
        return json(response, 401, {
          error: { code: 'UNAUTHORIZED', message: 'The RunPub token is invalid' },
        });
      }
      return json(response, 200, { account: authentication.account });
    }
    if (
      path === '/_runpub/connect' ||
      path === '/_runpublic/connect' ||
      path === '/_devpublic/connect'
    ) {
      return text(response, 426, 'WebSocket upgrade required');
    }

    const hostname = requestHostname(request);
    const tunnel = tunnels.get(hostname);
    if (!tunnel || tunnel.socket.readyState !== WebSocket.OPEN) {
      return text(response, 404, 'No active RunPub tunnel for this hostname');
    }

    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) {
      return text(response, 413, 'Request body exceeded the RunPub limit');
    }

    const chunks = [];
    let total = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxRequestBodyBytes) {
        rejected = true;
        text(response, 413, 'Request body exceeded the RunPub limit');
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected || response.destroyed) return;
      const id = randomUUID();
      const timer = setTimeout(() => {
        failPendingRequest(id, 504, 'RunPub tunnel request timed out');
        sendTunnel(tunnel, { type: 'http_cancel', id });
      }, requestTimeoutMs);
      timer.unref?.();
      pendingHttp.set(id, { response, tunnel, timer });
      const sent = sendTunnel(tunnel, {
        type: 'http_request',
        id,
        method: request.method || 'GET',
        path: request.url || '/',
        headers: createForwardHeaders(request.headers, request, { scheme: publicScheme }),
        body: Buffer.concat(chunks).toString('base64'),
      });
      if (!sent) failPendingRequest(id, 502, 'RunPub tunnel disconnected');
    });
    request.on('aborted', () => {
      for (const [id, pending] of pendingHttp) {
        if (pending.response !== response) continue;
        pendingHttp.delete(id);
        clearTimeout(pending.timer);
        sendTunnel(tunnel, { type: 'http_cancel', id });
      }
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url || '/', 'http://runpub.invalid').pathname;
    if (
      path === '/_runpub/connect' ||
      path === '/_runpublic/connect' ||
      path === '/_devpublic/connect'
    ) {
      const authentication = authenticate(tokens, bearerToken(request), allowAnonymous);
      if (!authentication.ok) return rejectUpgrade(socket, 401, 'Invalid RunPub token');
      return agentWss.handleUpgrade(request, socket, head, (webSocket) => {
        agentWss.emit('connection', webSocket, request, authentication);
      });
    }

    const tunnel = tunnels.get(requestHostname(request));
    if (!tunnel || tunnel.socket.readyState !== WebSocket.OPEN) {
      return rejectUpgrade(socket, 404, 'No active RunPub tunnel for this hostname');
    }
    publicWss.handleUpgrade(request, socket, head, (webSocket) => {
      publicWss.emit('connection', webSocket, request, tunnel);
    });
  });

  let started = false;
  const api = {
    server,
    events,
    tunnels,
    async start() {
      if (started) return server.address();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      started = true;
      return server.address();
    },
    async close() {
      for (const tunnel of connections) tunnel.socket.close(1001, 'Edge shutting down');
      for (const state of publicWebSockets.values()) state.socket.close(1001, 'Edge shutting down');
      for (const id of [...pendingHttp.keys()]) {
        failPendingRequest(id, 503, 'RunPub edge is shutting down');
      }
      agentWss.close();
      publicWss.close();
      if (!started) return;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections?.();
      });
      started = false;
    },
    address() {
      return server.address();
    },
  };
  return api;
}

export default createEdgeServer;
