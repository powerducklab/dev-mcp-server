import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PublicationManager } from "../src/publication/manager.js";
import { cloudHandoff } from "../src/publication/cloud.js";
const managers: PublicationManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  managers.splice(0).forEach((m) => m.close());
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-docs-"));
  dirs.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { express: "4.21.0" } }),
  );
  await writeFile(
    path.join(root, "server.js"),
    "const express=require('express');const app=express(); app.get('/health',(req,res)=>res.json({ok:true}));",
  );
  return root;
}
it("serves a real viewer and updates one stable URL without executing source", async () => {
  const root = await fixture();
  const manager = new PublicationManager();
  managers.push(manager);
  const first = await manager.publish({}, root);
  expect(first.status).toBe("published");
  const page = await fetch(first.url!);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("viewer.js");
  expect((await fetch(first.url + "viewer.js")).status).toBe(200);
  expect(
    ((await (await fetch(first.url + "oas.json")).json()) as any).paths[
      "/health"
    ],
  ).toBeDefined();
  expect((await fetch(first.url!, { method: "POST" })).status).toBe(405);
  expect(
    (await fetch(first.url!, { headers: { Origin: "https://evil.example" } }))
      .status,
  ).toBe(403);
  await writeFile(
    path.join(root, "server.js"),
    "const express=require('express');const app=express();app.get('/updated',(req,res)=>res.json({ok:true}));throw new Error('never execute');",
  );
  expect((await manager.publish({}, root)).url).toBe(first.url);
  expect(
    ((await (await fetch(first.url + "oas.json")).json()) as any).paths[
      "/updated"
    ],
  ).toBeDefined();
  await expect(
    manager.publish({ directory: ".." }, root),
  ).rejects.toMatchObject({ code: "scan_path_denied" });
  expect(() => manager.status({ publicationId: "unknown" })).toThrow();
  manager.close();
  await expect(fetch(first.url!)).rejects.toThrow();
}, 30000);
it("requires trusted origin and nonce before accepting Cloud confirmation", async () => {
  let result: unknown;
  const handoff = await cloudHandoff(
    { name: "API", text: "{}" },
    async (link) => {
      result = link;
    },
    () => {},
  );
  try {
    const params = new URLSearchParams(
      new URL(handoff.authorizationUrl).hash.slice(1),
    );
    const base = params.get("desktop")!;
    const headers = {
      Origin: "https://www.powerduck.com",
      Authorization: `Bearer ${params.get("nonce")}`,
      "Content-Type": "application/json",
    };
    expect((await fetch(base + "/payload")).status).toBe(403);
    expect((await fetch(base + "/payload", { headers })).status).toBe(200);
    const body = {
      documentId: "doc",
      organizationId: "org",
      mcpEnabled: false,
      publicToken: "share",
    };
    expect(
      (
        await fetch(base + "/result", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
    expect(result).toEqual(body);
  } finally {
    handoff.close();
  }
});
it("returns pending authorization and final Cloud URL only after confirmation", async () => {
  const root = await fixture();
  const manager = new PublicationManager();
  managers.push(manager);
  const pending = await manager.publish({ target: "cloud" }, root);
  expect(pending.status).toBe("awaiting_authorization");
  expect(pending.url).toBeUndefined();
  const params = new URLSearchParams(
    new URL(pending.authorizationUrl!).hash.slice(1),
  );
  const response = await fetch(params.get("desktop") + "/result", {
    method: "POST",
    headers: {
      Origin: "https://www.powerduck.com",
      Authorization: `Bearer ${params.get("nonce")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      documentId: "d",
      organizationId: "o",
      mcpEnabled: false,
      publicToken: "t",
    }),
  });
  expect(response.status).toBe(200);
  expect(
    manager.status({ publicationId: pending.publicationId }),
  ).toMatchObject({
    status: "published",
    url: "https://www.powerduck.com/view/docs/t",
  });
}, 30000);
