import http from "node:http";

export interface FakeBackend {
  url: string;
  close: () => Promise<void>;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

/** A conformant Petstore backend used by verification end-to-end tests. */
export function startFakeBackend(): Promise<FakeBackend> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";

    if (url.pathname === "/v1" && method === "GET") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (url.pathname === "/v1/pets" && method === "GET") {
      if (url.searchParams.get("fail") === "1") {
        return sendJson(response, 500, { error: "boom" });
      }
      return sendJson(response, 200, [
        { id: "pet-1", name: "Rex", tag: "dog" },
      ]);
    }
    if (url.pathname === "/v1/pets" && method === "POST") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        let body: { name?: string; tag?: string } = {};
        try {
          body = raw ? (JSON.parse(raw) as typeof body) : {};
        } catch {
          body = {};
        }
        sendJson(response, 201, {
          id: "pet-123",
          name: body.name ?? "Rex",
          tag: body.tag ?? "dog",
        });
      });
      return;
    }
    const petMatch = /^\/v1\/pets\/[^/]+$/.exec(url.pathname);
    if (petMatch && method === "GET") {
      return sendJson(response, 200, { id: "pet-123", name: "Rex", tag: "dog" });
    }
    if (petMatch && method === "DELETE") {
      response.writeHead(204);
      return response.end();
    }
    return sendJson(response, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind fake backend"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
