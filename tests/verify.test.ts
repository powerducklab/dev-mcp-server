import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SpecStore } from "../src/spec/store.js";
import { pingTarget } from "../src/verify/ping.js";
import { sendOne } from "../src/verify/send.js";
import { runContractSuite } from "../src/verify/contract.js";
import { runScenarioTool, validateScenario } from "../src/verify/scenario.js";
import { startFakeBackend, type FakeBackend } from "./helpers/fakeBackend.js";

const fixturePath = fileURLToPath(
  new URL(path.join("fixtures", "petstore.yaml"), import.meta.url),
);

let backend: FakeBackend;
let store: SpecStore;

beforeAll(async () => {
  backend = await startFakeBackend();
  store = new SpecStore(fixturePath);
});

afterAll(async () => {
  await backend.close();
});

describe("ping_target", () => {
  it("reports a reachable backend", async () => {
    const result = await pingTarget(backend.url, 5000);
    expect(result.reachable).toBe(true);
    expect(result.status).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports an unreachable backend without throwing", async () => {
    const dead = await startFakeBackend();
    const url = dead.url;
    await dead.close();
    const result = await pingTarget(url, 2000);
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("send_request", () => {
  it("passes the implicit 2xx contract for a conformant handler", async () => {
    const snapshot = await store.load();
    const result = await sendOne(
      snapshot,
      { baseUrl: backend.url, timeoutMs: 10000 },
      { operationId: "listPets" },
      {},
    );
    expect(result.status).toBe("passed");
    expect(result.response?.status).toBe(200);
    expect(result.assertions?.every((a) => a.passed)).toBe(true);
  });

  it("fails when the handler returns 500", async () => {
    const snapshot = await store.load();
    const result = await sendOne(
      snapshot,
      { baseUrl: backend.url, timeoutMs: 10000 },
      { operationId: "listPets" },
      { values: { query: { fail: "1" } } },
    );
    expect(result.status).toBe("failed");
    expect(result.response?.status).toBe(500);
    expect(result.assertions?.some((a) => !a.passed)).toBe(true);
  });
});

describe("run_contract_tests", () => {
  it("passes every operation against the conformant backend", async () => {
    const snapshot = await store.load();
    const progress: number[] = [];
    const report = await runContractSuite(
      snapshot,
      { baseUrl: backend.url, timeoutMs: 10000, concurrency: 2 },
      {},
      { report: (done) => progress.push(done) },
    );
    expect(report.summary.total).toBe(4);
    expect(report.summary.passed).toBe(4);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.errors).toBe(0);
    expect(progress).toContain(4);
  });

  it("honors the operation filter", async () => {
    const snapshot = await store.load();
    const report = await runContractSuite(
      snapshot,
      { baseUrl: backend.url, timeoutMs: 10000 },
      { operationIds: ["listPets"] },
    );
    expect(report.summary.total).toBe(1);
    expect(report.results[0]?.operationId).toBe("listPets");
  });
});

describe("scenarios", () => {
  const scenario = {
    name: "create then fetch",
    steps: [
      {
        ref: "POST /pets",
        name: "create",
        request: {
          extract: [{ name: "petId", from: "body", path: "$.id" }],
          assertions: [{ name: "created", assert: "status", value: 201 }],
        },
      },
      {
        ref: "GET /pets/{petId}",
        name: "fetch",
        request: {
          values: { path: { petId: "{{petId}}" } },
          assertions: [
            { name: "ok", assert: "status", value: 200 },
            { name: "id roundtrips", assert: "jsonPath", path: "$.id", exists: true },
          ],
        },
      },
    ],
  };

  it("validates references without sending traffic", async () => {
    const snapshot = await store.load();
    expect(validateScenario(snapshot, scenario).valid).toBe(true);
    expect(
      validateScenario(snapshot, {
        name: "bad",
        steps: [{ ref: "GET /nope" }],
      }),
    ).toMatchObject({ valid: false });
  });

  it("runs the ordered flow with extraction and chaining", async () => {
    const snapshot = await store.load();
    const events: number[] = [];
    const report = await runScenarioTool(snapshot, scenario, {
      baseUrl: backend.url,
      timeoutMs: 10000,
    }, { report: (done) => events.push(done) });
    expect(report.status).toBe("passed");
    expect(report.steps).toHaveLength(2);
    expect(report.variables.petId).toBe("pet-123");
    expect(report.summary.failed).toBe(0);
    expect(events).toContain(2);
  });

  it("cancels before the first step when the signal is already aborted", async () => {
    const snapshot = await store.load();
    const controller = new AbortController();
    controller.abort();
    const report = await runScenarioTool(
      snapshot,
      scenario,
      { baseUrl: backend.url, timeoutMs: 10000 },
      { signal: controller.signal },
    );
    expect(report.status).toBe("cancelled");
  });
});
