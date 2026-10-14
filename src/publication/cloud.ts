import http from "node:http";
import { randomBytes } from "node:crypto";
import { FactError } from "../types.js";
export interface CloudLink {
  documentId: string;
  organizationId: string;
  mcpEnabled: boolean;
  publicToken?: string;
}
export function validLink(value: unknown): value is CloudLink {
  if (!value || typeof value !== "object") return false;
  const link = value as CloudLink;
  return (
    [link.documentId, link.organizationId].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 512,
    ) &&
    typeof link.mcpEnabled === "boolean" &&
    (link.publicToken === undefined ||
      (typeof link.publicToken === "string" &&
        link.publicToken.length > 0 &&
        link.publicToken.length <= 4096))
  );
}
/** Same origin/nonce handoff protocol used by the Powerduck desktop client. */
export async function cloudHandoff(
  payload: { name: string; text: string; existing?: CloudLink },
  onComplete: (link: CloudLink) => Promise<void>,
  onError: (error: Error) => void,
) {
  const origin = "https://www.powerduck.com";
  const nonce = randomBytes(32).toString("hex");
  let address = "";
  let done = false;
  let completing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.host !== address || req.headers.origin !== origin) {
      reply(403, { error: "forbidden" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Private-Network": "true",
      });
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${nonce}`) {
      reply(403, { error: "forbidden" });
      return;
    }
    if (req.method === "GET" && req.url === "/payload") {
      reply(200, { ...payload, action: "publish" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/result") {
      reply(404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16384) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        let link: unknown;
        try {
          link = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reply(400, { error: "invalid_result" });
          return;
        }
        if (
          !validLink(link) ||
          !link.publicToken ||
          (payload.existing &&
            (link.documentId !== payload.existing.documentId ||
              link.organizationId !== payload.existing.organizationId))
        ) {
          reply(400, { error: "invalid_result" });
          return;
        }
        if (done || completing) {
          reply(409, { error: "closed" });
          return;
        }
        completing = true;
        try {
          await onComplete(link);
          res.once("finish", close);
          reply(200, { success: true });
        } catch {
          reply(500, { error: "publication_state_failed" });
          onError(
            new FactError(
              "publication_state_failed",
              "Cloud publication completed but its local state could not be saved.",
            ),
          );
          close();
        }
      })();
    });
  });
  server.maxConnections = 8;
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    onError(new FactError("cloud_handoff_failed", "Cloud connection failed."));
    close();
  });
  address = `127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  timer = setTimeout(() => {
    onError(
      new FactError(
        "cloud_handoff_expired",
        "Cloud authorization expired. Run publish_code_docs again.",
      ),
    );
    close();
  }, 600000);
  timer.unref();
  const url = new URL("/cloud/import-client", origin);
  url.hash = new URLSearchParams({
    desktop: `http://${address}`,
    nonce,
  }).toString();
  return { authorizationUrl: url.href, close };
}
