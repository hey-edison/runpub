import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';

import {
  createLocalHeaders,
  createLocalWebSocketHeaders,
  stripHopByHopHeaders,
} from './proxy-headers.js';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_RECONNECT_DELAY_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const STREAM_CHUNK_BYTES = 64 * 1024;

function normalizeLocalProtocol(protocol) {
  const value = String(protocol || 'http').replace(/:$/, '').toLowerCase();
  if (value !== 'http' && value !== 'https') {
    throw new TypeError('localProtocol must be http or https');
  }
  return value;
}

function tunnelSocketUrl(server, { account, project, service }) {
  let value = String(server || '').trim();
  if (!value) throw new TypeError('A RunPublic edge server URL is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  const url = new URL(value);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('RunPublic server URL must use http, https, ws, or wss');
  }
  url.pathname = '/_runpublic/connect';
  url.search = new URLSearchParams({
    protocol: '2',
    account: String(account),
    project: String(project),
    service: String(service),
  }).toString();
  url.hash = '';
  return url.toString();
}

function decodeBody(value) {
  if (!value) return Buffer.alloc(0);
  return Buffer.from(value, 'base64');
}

function reasonText(reason) {
  return Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
}

function validCloseCode(value, fallback = 1000) {
  const code = Number(value);
  const standard = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code);
  const application = code >= 3000 && code <= 4999;
  return Number.isInteger(code) && (standard || application) ? code : fallback;
}

export class TunnelClient extends EventEmitter {
  constructor({
    server,
    token,
    account,
    project,
    service,
    localHost = '127.0.0.1',
    localPort,
    localProtocol = 'http',
  }) {
    super();
    if (!account || !project || !service) {
      throw new TypeError('account, project, and service are required');
    }
    const port = Number(localPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('localPort must be an integer between 1 and 65535');
    }

    this.account = String(account);
    this.project = String(project);
    this.service = String(service);
    this.server = server;
    this.socketUrl = tunnelSocketUrl(server, {
      account: this.account,
      project: this.project,
      service: this.service,
    });
    this.token = token == null ? '' : String(token);
    this.localHost = String(localHost || '127.0.0.1');
    this.localPort = port;
    this.localProtocol = normalizeLocalProtocol(localProtocol);

    this.socket = null;
    this.hostname = null;
    this.publicUrl = null;
    this.stopped = true;
    this.registered = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.localRequests = new Map();
    this.localWebSockets = new Map();
    this.maxResponseBodyBytes = DEFAULT_MAX_BODY_BYTES;
    this._startPromise = null;
    this._resolveStart = null;
    this._rejectStart = null;
  }

  start() {
    if (this._startPromise && !this.stopped) return this._startPromise;

    this.stopped = false;
    this.registered = false;
    this._startPromise = new Promise((resolve, reject) => {
      this._resolveStart = resolve;
      this._rejectStart = reject;
    });
    this._connect();
    return this._startPromise;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.registered = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    this._clearHeartbeat();
    for (const state of this.localRequests.values()) this._destroyLocalRequest(state);
    this.localRequests.clear();
    for (const state of this.localWebSockets.values()) state.socket.close(1001, 'Tunnel stopped');
    this.localWebSockets.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, 'Client stopped');
    }

    if (this._rejectStart) {
      this._rejectStart(new Error('Tunnel stopped before it connected'));
      this._clearStartDeferred();
    }
  }

  _clearStartDeferred() {
    this._resolveStart = null;
    this._rejectStart = null;
  }

  _connect() {
    if (this.stopped) return;

    const headers = {
      'user-agent': 'runpublic-cli',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let socket;
    try {
      socket = new WebSocket(this.socketUrl, {
        headers,
        maxPayload: this.maxResponseBodyBytes * 2,
        perMessageDeflate: false,
      });
    } catch (error) {
      this.emit('connectionError', error);
      this._scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.on('open', () => {
      if (socket !== this.socket || this.stopped) return;
      this._startHeartbeat(socket);
      this._send({
        type: 'register',
        account: this.account,
        project: this.project,
        service: this.service,
      });
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== this.socket || isBinary) return;
      this._handleTunnelMessage(data);
    });
    socket.on('error', (error) => {
      this.emit('connectionError', error);
    });
    socket.on('unexpected-response', (request, response) => {
      const error = new Error(
        `RunPublic edge rejected the connection with HTTP ${response.statusCode || 'unknown'}`,
      );
      response.resume();
      request.abort();
      this.stopped = true;
      if (this._rejectStart) {
        this._rejectStart(error);
        this._clearStartDeferred();
      }
      this.emit('connectionError', error);
    });
    socket.on('close', () => {
      if (socket !== this.socket) return;
      this._clearHeartbeat();
      this.socket = null;
      const wasRegistered = this.registered;
      this.registered = false;
      this._abortLocalWork();
      if (wasRegistered) this.emit('disconnect');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const ceiling = Math.min(250 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    const delay = Math.max(100, Math.round(ceiling * (0.75 + Math.random() * 0.5)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  _sendWithCallback(message, callback) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message), callback);
    return true;
  }

  _startHeartbeat(socket) {
    this._clearHeartbeat();
    let receivedPong = true;
    socket.on('pong', () => {
      receivedPong = true;
    });
    this.heartbeatTimer = setInterval(() => {
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
      if (!receivedPong) {
        socket.terminate();
        return;
      }
      receivedPong = false;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  _clearHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _handleTunnelMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.emit('protocolError', new Error('Edge sent invalid JSON'));
      return;
    }

    switch (message.type) {
      case 'registered':
      case 'register_ack':
        this.registered = true;
        this.reconnectAttempt = 0;
        this.hostname = message.hostname;
        this.publicUrl = message.publicUrl;
        if (message.limits?.responseBodyBytes) {
          this.maxResponseBodyBytes = Number(message.limits.responseBodyBytes);
        }
        if (this._resolveStart) {
          this._resolveStart({ hostname: this.hostname, publicUrl: this.publicUrl });
          this._clearStartDeferred();
        }
        this.emit('connected', { hostname: this.hostname, publicUrl: this.publicUrl });
        break;
      case 'register_error': {
        const error = new Error(message.message || 'Tunnel registration failed');
        if (message.code) error.code = message.code;
        if (this._rejectStart) {
          this._rejectStart(error);
          this._clearStartDeferred();
        }
        this.stopped = true;
        this.socket?.close(1008, 'Registration rejected');
        this.emit('registrationError', error);
        break;
      }
      case 'http_request':
        this._handleHttpRequest(message);
        break;
      case 'http_request_start':
        this._handleHttpRequestStart(message);
        break;
      case 'http_request_chunk':
        this._handleHttpRequestChunk(message);
        break;
      case 'http_request_end':
        this._handleHttpRequestEnd(message);
        break;
      case 'http_cancel':
        this._destroyLocalRequest(this.localRequests.get(message.id));
        this.localRequests.delete(message.id);
        break;
      case 'ws_open':
        this._openLocalWebSocket(message);
        break;
      case 'ws_data':
        this._sendLocalWebSocketData(message);
        break;
      case 'ws_close':
        this._closeLocalWebSocket(message);
        break;
      default:
        break;
    }
  }

  _handleHttpRequest(message) {
    const id = String(message.id || '');
    if (!id) return;
    const body = decodeBody(message.body);
    const transport = this.localProtocol === 'https' ? https : http;
    const localAuthority = `${this.localHost}:${this.localPort}`;
    const headers = createLocalHeaders(message.headers, localAuthority);

    let settled = false;
    const request = transport.request(
      {
        hostname: this.localHost,
        port: this.localPort,
        protocol: `${this.localProtocol}:`,
        method: message.method || 'GET',
        path: message.path || '/',
        headers,
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > this.maxResponseBodyBytes) {
            settled = true;
            response.destroy();
            this._sendHttpError(id, 502, 'Local response exceeded the tunnel body limit');
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          this.localRequests.delete(id);
          this._send({
            type: 'http_response',
            id,
            statusCode: response.statusCode || 502,
            statusMessage: response.statusMessage,
            headers: stripHopByHopHeaders(response.headers),
            body: Buffer.concat(chunks).toString('base64'),
          });
        });
        response.on('error', (error) => {
          if (settled) return;
          settled = true;
          this.localRequests.delete(id);
          this._sendHttpError(id, 502, `Local server response failed: ${error.message}`);
        });
      },
    );

    this.localRequests.set(id, request);
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      this.localRequests.delete(id);
      this._sendHttpError(id, 502, `Could not reach local service: ${error.message}`);
    });
    if (body.length) request.write(body);
    request.end();
  }

  _sendHttpError(id, statusCode, message) {
    const body = Buffer.from(message);
    this._send({
      type: 'http_response',
      id,
      statusCode,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(body.length),
      },
      body: body.toString('base64'),
    });
  }

  _handleHttpRequestStart(message) {
    const id = String(message.id || '');
    if (!id || this.localRequests.has(id)) return;
    const transport = this.localProtocol === 'https' ? https : http;
    const localAuthority = `${this.localHost}:${this.localPort}`;
    const headers = createLocalHeaders(message.headers, localAuthority);
    const state = {
      request: null,
      response: null,
      responseStarted: false,
      settled: false,
      totalResponseBytes: 0,
    };

    const request = transport.request(
      {
        hostname: this.localHost,
        port: this.localPort,
        protocol: `${this.localProtocol}:`,
        method: message.method || 'GET',
        path: message.path || '/',
        headers,
      },
      (response) => {
        state.response = response;
        state.responseStarted = true;
        this._send({
          type: 'http_response_start',
          id,
          statusCode: response.statusCode || 502,
          headers: stripHopByHopHeaders(response.headers),
        });
        response.on('data', (chunk) => {
          if (state.settled) return;
          state.totalResponseBytes += chunk.length;
          if (state.totalResponseBytes > this.maxResponseBodyBytes) {
            state.settled = true;
            response.destroy();
            this.localRequests.delete(id);
            this._send({
              type: 'http_response_error',
              id,
              message: 'Local response exceeded the tunnel body limit',
            });
            return;
          }
          response.pause();
          const sendNext = (offset) => {
            if (state.settled) return;
            if (offset >= chunk.length) {
              response.resume();
              return;
            }
            const piece = chunk.subarray(offset, offset + STREAM_CHUNK_BYTES);
            const sent = this._sendWithCallback(
              {
                type: 'http_response_chunk',
                id,
                data: piece.toString('base64'),
              },
              (error) => {
                if (error) {
                  state.settled = true;
                  response.destroy(error);
                  this.localRequests.delete(id);
                  return;
                }
                sendNext(offset + piece.length);
              },
            );
            if (!sent) {
              state.settled = true;
              response.destroy(new Error('RunPublic tunnel disconnected'));
              this.localRequests.delete(id);
            }
          };
          sendNext(0);
        });
        response.on('end', () => {
          if (state.settled) return;
          state.settled = true;
          this.localRequests.delete(id);
          this._send({ type: 'http_response_end', id });
        });
        response.on('error', (error) => {
          if (state.settled) return;
          state.settled = true;
          this.localRequests.delete(id);
          if (state.responseStarted) {
            this._send({ type: 'http_response_error', id, message: error.message });
          } else {
            this._sendStreamHttpError(id, 502, `Local server response failed: ${error.message}`);
          }
        });
      },
    );
    state.request = request;
    this.localRequests.set(id, state);
    request.on('error', (error) => {
      if (state.settled) return;
      state.settled = true;
      this.localRequests.delete(id);
      this._sendStreamHttpError(id, 502, `Could not reach local service: ${error.message}`);
    });
  }

  _handleHttpRequestChunk(message) {
    const state = this.localRequests.get(String(message.id || ''));
    if (!state?.request || state.settled) return;
    const chunk = decodeBody(message.data);
    state.request.write(chunk);
  }

  _handleHttpRequestEnd(message) {
    const state = this.localRequests.get(String(message.id || ''));
    if (!state?.request || state.settled) return;
    state.request.end();
  }

  _sendStreamHttpError(id, statusCode, message) {
    const body = Buffer.from(message);
    this._send({
      type: 'http_response_start',
      id,
      statusCode,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(body.length),
      },
    });
    if (body.length) {
      this._send({ type: 'http_response_chunk', id, data: body.toString('base64') });
    }
    this._send({ type: 'http_response_end', id });
  }

  _destroyLocalRequest(state) {
    if (!state) return;
    if (typeof state.destroy === 'function') state.destroy();
    else state.request?.destroy();
    state.response?.destroy();
  }

  _openLocalWebSocket(message) {
    const id = String(message.id || '');
    if (!id) return;
    const protocol = this.localProtocol === 'https' ? 'wss' : 'ws';
    const path = String(message.path || '/').startsWith('/') ? message.path : `/${message.path}`;
    const url = `${protocol}://${this.localHost}:${this.localPort}${path}`;
    const protocols = Array.isArray(message.protocols)
      ? message.protocols.map(String).filter(Boolean)
      : [];
    const headers = createLocalWebSocketHeaders(
      message.headers,
      `${this.localHost}:${this.localPort}`,
    );

    let socket;
    try {
      socket = new WebSocket(url, protocols, {
        headers,
        maxPayload: this.maxResponseBodyBytes,
        perMessageDeflate: false,
      });
    } catch (error) {
      this._send({ type: 'ws_error', id, message: error.message });
      return;
    }

    const state = { socket, opened: false, queue: [], queuedBytes: 0 };
    this.localWebSockets.set(id, state);
    socket.on('open', () => {
      state.opened = true;
      this._send({ type: 'ws_opened', id, protocol: socket.protocol || undefined });
      for (const item of state.queue) socket.send(item.data, { binary: item.binary });
      state.queue = [];
      state.queuedBytes = 0;
    });
    socket.on('message', (data, isBinary) => {
      this._send({
        type: 'ws_data',
        id,
        binary: Boolean(isBinary),
        data: Buffer.from(data).toString('base64'),
      });
    });
    socket.on('error', (error) => {
      if (!state.opened) this._send({ type: 'ws_error', id, message: error.message });
    });
    socket.on('close', (code, reason) => {
      this.localWebSockets.delete(id);
      this._send({ type: 'ws_closed', id, code, reason: reasonText(reason) });
    });
  }

  _sendLocalWebSocketData(message) {
    const state = this.localWebSockets.get(String(message.id || ''));
    if (!state) return;
    const data = decodeBody(message.data);
    const item = { data, binary: Boolean(message.binary) };
    if (state.opened && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(data, { binary: item.binary });
      return;
    }
    state.queuedBytes += data.length;
    if (state.queuedBytes > this.maxResponseBodyBytes) {
      state.socket.close(1009, 'Queued messages exceeded limit');
      return;
    }
    state.queue.push(item);
  }

  _closeLocalWebSocket(message) {
    const id = String(message.id || '');
    const state = this.localWebSockets.get(id);
    if (!state) return;
    const safeCode = validCloseCode(message.code);
    state.socket.close(safeCode, String(message.reason || '').slice(0, 123));
  }

  _abortLocalWork() {
    for (const state of this.localRequests.values()) this._destroyLocalRequest(state);
    this.localRequests.clear();
    for (const state of this.localWebSockets.values()) {
      state.socket.close(1012, 'Tunnel reconnecting');
    }
    this.localWebSockets.clear();
  }
}

export default TunnelClient;
