import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SpecStore } from "../src/spec/store.js";
import { detectDrift } from "../src/verify/drift.js";
import { startFakeBackend, type FakeBackend } from "./helpers/fakeBackend.js";

const fixturePath = fileURLToPath(
  new URL(path.join("fixtures", "petstore.yaml"), import.meta.url),
);
const store = new SpecStore(fixturePath);

let backend: FakeBackend;

beforeAll(async () => {
  backend = await startFakeBackend();
});

afterAll(async () => {
  await backend.close();
});

function statusServer(statusCode: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("detect_drift", () => {
  it("reports no drift for a conforming backend", async () => {
    const snapshot = await store.load();
    const report = await detectDrift(
      snapshot,
      { baseUrl: backend.url, timeoutMs: 10000 },
      {},
    );
    expect(report.driftLevel).toBe("none");
    expect(report.summary.conforming).toBe(report.summary.total);
    expect(report.drift).toHaveLength(0);
  });

  it("classifies every operation as missing when the server returns 404", async () => {
    const empty = await statusServer(404);
    try {
      const snapshot = await store.load();
      const report = await detectDrift(
        snapshot,
        { baseUrl: empty.url, timeoutMs: 5000 },
        {},
      );
      expect(report.driftLevel).toBe("high");
      expect(report.summary.missing).toBe(report.summary.total);
      expect(report.drift.every((item) => item.kind === "missing")).toBe(true);
    } finally {
      await empty.close();
    }
  });

  it("classifies a dead port as unreachable", async () => {
    const dead = await statusServer(200);
    const url = dead.url;
    await dead.close();
    const snapshot = await store.load();
    const report = await detectDrift(
      snapshot,
      { baseUrl: url, timeoutMs: 2000 },
      { methods: ["get"] },
    );
    expect(report.driftLevel).toBe("high");
    expect(report.summary.unreachable).toBeGreaterThan(0);
    expect(
      report.drift.every((item) => item.kind === "unreachable"),
    ).toBe(true);
  });
});
