import { createServer } from "node:http";

const port = Number(process.env.PORT || 8000);

function sendJson(response, status, body) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/hello") {
    sendJson(response, 200, {
      message: "Hello from the local backend",
      servedAt: new Date().toISOString()
    });
    return;
  }

  if (request.method === "POST" && request.url === "/webhooks/example") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      console.log("Webhook received:", rawBody);
      sendJson(response, 202, { received: true, bytes: Buffer.byteLength(rawBody) });
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}).listen(port, "127.0.0.1", () => {
  console.log(`Example backend listening at http://127.0.0.1:${port}`);
});
