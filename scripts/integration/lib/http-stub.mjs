// Temporary HTTP stub for integration tests (design part 8, section 1.3 `HttpStub`).
//   route(method, pathOrRegExp, handler)  handler(req, rawBody) → { status, json?, body?, headers? } (may be async)
//   hang(method, path)                    requests to the route get neither a response nor a close
//   requests                              every request: { method, path, headers, rawBody, receivedAt }
//   close()                               server.closeAllConnections(), then stops listening
// Unmatched requests get 404 { error: "no stub route" }.
import http from "node:http";

export async function startHttpStub({ host = "127.0.0.1" } = {}) {
  const routes = [];
  const requests = [];
  const hanging = new Set();
  const matches = (route, method, pathname) => (route.method === "*" || route.method === method) && (route.path instanceof RegExp ? route.path.test(pathname) : route.path === pathname);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const pathname = new URL(req.url, "http://stub").pathname;
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, rawBody, receivedAt: new Date() });
    const route = routes.find((candidate) => matches(candidate, req.method, pathname));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no stub route" }));
      return;
    }
    if (route.hang) {
      hanging.add(res);
      return;
    }
    try {
      const reply = (await route.handler(req, rawBody)) ?? { status: 204 };
      const headers = { ...(reply.headers ?? {}) };
      let body = reply.body ?? "";
      if (reply.json !== undefined) {
        body = JSON.stringify(reply.json);
        headers["content-type"] ??= "application/json";
      }
      res.writeHead(reply.status ?? 200, headers);
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `stub handler failed: ${error.message}` }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  let closed = false;
  return {
    baseUrl: `http://${host}:${port}`,
    port,
    requests,
    route(method, pathOrRegExp, handler) {
      routes.push({ method: String(method).toUpperCase(), path: pathOrRegExp, handler });
      return this;
    },
    hang(method, pathOrRegExp) {
      routes.push({ method: String(method).toUpperCase(), path: pathOrRegExp, hang: true });
      return this;
    },
    async close() {
      if (closed) return;
      closed = true;
      hanging.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
