import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { createEdgeServer } from "../src/edge-server.js";
import { TunnelClient } from "../src/tunnel-client.js";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });

const closeServer = (server) =>
  new Promise((resolve) => server.close(() => resolve()));

const request = ({ port, hostname, path = "/", method = "GET", body = "" }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host: hostname,
          "content-type": "text/plain",
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.once("error", reject);
    req.end(body);
  });

test("forwards HTTP and WebSocket traffic to a local service", async (t) => {
  const localServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
          forwardedHost: req.headers["x-forwarded-host"],
          forwardedProto: req.headers["x-forwarded-proto"]
        })
      );
    });
  });
  const localWebSockets = new WebSocketServer({ server: localServer });
  let resolveLocalSocketClosed;
  const localSocketClosed = new Promise((resolve) => {
    resolveLocalSocketClosed = resolve;
  });
  localWebSockets.on("connection", (socket) => {
    socket.on("message", (message, isBinary) => {
      socket.send(message, { binary: isBinary });
    });
    socket.once("close", resolveLocalSocketClosed);
  });
  const localAddress = await listen(localServer);

  const edge = createEdgeServer({
    host: "127.0.0.1",
    port: 0,
    domain: "devpublic.test",
    tokens: { keshavmac: "test-secret" },
    publicScheme: "http",
    requestTimeoutMs: 5_000
  });
  await edge.start();
  const edgeAddress = edge.address();

  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${edgeAddress.port}`,
    token: "test-secret",
    account: "keshavmac",
    project: "ai-native-ats",
    service: "frontend",
    localHost: "127.0.0.1",
    localPort: localAddress.port,
    localProtocol: "http"
  });

  t.after(async () => {
    tunnel.stop();
    await edge.close();
    localWebSockets.close();
    await closeServer(localServer);
  });

  const registration = await tunnel.start();
  assert.equal(
    registration.hostname,
    "ai-native-ats-frontend-keshavmac.devpublic.test"
  );

  const response = await request({
    port: edgeAddress.port,
    hostname: registration.hostname,
    path: "/api/echo?source=e2e",
    method: "POST",
    body: "hello tunnel"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    method: "POST",
    url: "/api/echo?source=e2e",
    body: "hello tunnel",
    forwardedHost: registration.hostname,
    forwardedProto: "http"
  });

  const publicSocket = new WebSocket(
    `ws://127.0.0.1:${edgeAddress.port}/socket`,
    { headers: { host: registration.hostname } }
  );
  await new Promise((resolve, reject) => {
    publicSocket.once("open", resolve);
    publicSocket.once("error", reject);
  });
  const echoed = new Promise((resolve, reject) => {
    publicSocket.once("message", (message) => resolve(message.toString()));
    publicSocket.once("error", reject);
  });
  publicSocket.send("hello websocket");
  assert.equal(await echoed, "hello websocket");
  const publicSocketClosed = new Promise((resolve) => publicSocket.once("close", resolve));
  publicSocket.close();
  await publicSocketClosed;
  await localSocketClosed;
});

test("does not route unknown hostnames", async (t) => {
  const edge = createEdgeServer({
    host: "127.0.0.1",
    port: 0,
    domain: "devpublic.test",
    allowAnonymous: true,
    publicScheme: "http"
  });
  await edge.start();
  t.after(() => edge.close());

  const response = await request({
    port: edge.address().port,
    hostname: "missing.devpublic.test"
  });
  assert.equal(response.status, 404);
});

test("rejects an invalid tunnel credential without retrying forever", async (t) => {
  const edge = createEdgeServer({
    host: "127.0.0.1",
    port: 0,
    domain: "devpublic.test",
    tokens: { keshavmac: "correct-secret" },
    publicScheme: "http"
  });
  await edge.start();
  t.after(() => edge.close());

  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${edge.address().port}`,
    token: "incorrect-secret",
    account: "keshavmac",
    project: "fullstack-demo",
    service: "backend",
    localHost: "127.0.0.1",
    localPort: 8000,
    localProtocol: "http"
  });
  t.after(() => tunnel.stop());

  await assert.rejects(tunnel.start(), /HTTP 401/);
});

test("prevents a valid token from claiming another account namespace", async (t) => {
  const edge = createEdgeServer({
    host: "127.0.0.1",
    port: 0,
    domain: "devpublic.test",
    tokens: { keshavmac: "correct-secret" },
    publicScheme: "http"
  });
  await edge.start();
  t.after(() => edge.close());

  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${edge.address().port}`,
    token: "correct-secret",
    account: "another-user",
    project: "fullstack-demo",
    service: "backend",
    localHost: "127.0.0.1",
    localPort: 8000,
    localProtocol: "http"
  });
  t.after(() => tunnel.stop());

  await assert.rejects(tunnel.start(), /not authorized/i);
});

test("streams protocol v2 HTTP requests and responses in bounded chunks", async (t) => {
  const localServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "text/plain", "x-local": "yes" });
      res.write("streamed:");
      res.end(Buffer.concat(chunks));
    });
  });
  const localAddress = await listen(localServer);
  const fakeEdge = http.createServer();
  const edgeSockets = new WebSocketServer({ server: fakeEdge });
  const fakeEdgeAddress = await listen(fakeEdge);

  const responseResult = new Promise((resolve, reject) => {
    edgeSockets.once("connection", (socket, request) => {
      const url = new URL(request.url, "http://edge.test");
      assert.equal(url.searchParams.get("protocol"), "2");
      assert.equal(url.searchParams.get("account"), "keshavmac");
      socket.send(
        JSON.stringify({
          type: "registered",
          protocol: 2,
          hostname: "stream-api-keshavmac.runpub.test",
          publicUrl: "https://stream-api-keshavmac.runpub.test",
          limits: { requestBodyBytes: 10_000_000, responseBodyBytes: 10_000_000 }
        })
      );

      const responseChunks = [];
      let responseStart;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "register") {
          socket.send(
            JSON.stringify({
              type: "http_request_start",
              id: "request-1",
              method: "POST",
              path: "/stream",
              headers: { "content-type": "text/plain" }
            })
          );
          socket.send(
            JSON.stringify({
              type: "http_request_chunk",
              id: "request-1",
              data: Buffer.from("hello ").toString("base64")
            })
          );
          socket.send(
            JSON.stringify({
              type: "http_request_chunk",
              id: "request-1",
              data: Buffer.from("world").toString("base64")
            })
          );
          socket.send(JSON.stringify({ type: "http_request_end", id: "request-1" }));
        }
        if (message.type === "http_response_start") responseStart = message;
        if (message.type === "http_response_chunk") {
          responseChunks.push(Buffer.from(message.data, "base64"));
        }
        if (message.type === "http_response_end") {
          resolve({ start: responseStart, body: Buffer.concat(responseChunks).toString("utf8") });
        }
      });
      socket.on("error", reject);
    });
  });

  const tunnel = new TunnelClient({
    server: `http://127.0.0.1:${fakeEdgeAddress.port}`,
    token: "test-secret",
    account: "keshavmac",
    project: "stream",
    service: "api",
    localHost: "127.0.0.1",
    localPort: localAddress.port,
    localProtocol: "http"
  });

  t.after(async () => {
    tunnel.stop();
    edgeSockets.close();
    await closeServer(fakeEdge);
    await closeServer(localServer);
  });

  await tunnel.start();
  const result = await responseResult;
  assert.equal(result.start.statusCode, 201);
  assert.equal(result.start.headers["x-local"], "yes");
  assert.equal(result.body, "streamed:hello world");
});
