import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("./index.html", import.meta.url));
const port = Number(process.env.PORT || 5173);

createServer((request, response) => {
  if (request.method !== "GET" || (request.url !== "/" && request.url !== "/index.html")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(indexPath).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Example frontend listening at http://127.0.0.1:${port}`);
});
