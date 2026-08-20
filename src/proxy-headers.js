const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
]);

function appendForwardedValue(existing, value) {
  if (!value) return existing;
  return existing ? `${existing}, ${value}` : value;
}

export function stripHopByHopHeaders(headers, { websocket = false } = {}) {
  const result = {};
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (websocket && WEBSOCKET_HANDSHAKE_HEADERS.has(name)) continue;
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export function createForwardHeaders(headers, request, { scheme = 'https', websocket = false } = {}) {
  const result = stripHopByHopHeaders(headers, { websocket });
  const remoteAddress = request?.socket?.remoteAddress;
  const originalHost = request?.headers?.host;

  if (originalHost) result['x-forwarded-host'] = originalHost;
  result['x-forwarded-proto'] = scheme;
  if (remoteAddress) {
    result['x-forwarded-for'] = appendForwardedValue(
      result['x-forwarded-for'],
      remoteAddress.replace(/^::ffff:/, ''),
    );
  }

  return result;
}

export function createLocalHeaders(headers, localAuthority) {
  const result = stripHopByHopHeaders(headers);
  result.host = localAuthority;
  return result;
}

export function createLocalWebSocketHeaders(headers, localAuthority) {
  const result = stripHopByHopHeaders(headers, { websocket: true });
  result.host = localAuthority;
  return result;
}
