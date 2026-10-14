import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeDevTool, devTools } from "../src/mcp/tools.js";
import { SpecStore } from "../src/spec/store.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-mcp-scan-")); dirs.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.21.0" } }));
  await writeFile(path.join(root, "server.js"), "const express = require('express'); const app = express(); app.get('/health', (req,res) => res.json({ok:true})); throw new Error('project code must never execute');");
  return {root,store:new SpecStore(path.join(root,"not-created.yaml"))};
}
describe("code scan tools", () => {
  it("lists capabilities without loading a spec", async () => {
    const {store} = await fixture();
    expect(devTools.map(t=>t.name)).toContain("scan_code_to_openapi");
    expect(await executeDevTool("get_code_scan_capabilities", {}, store)).toMatchObject({ readOnly:true, frameworks:expect.arrayContaining(["express","spring"]) });
  });
  it("generates a real OAS document before the spec exists", async () => {
    const {store}=await fixture();
    const result=await executeDevTool("scan_code_to_openapi", {}, store) as any;
    expect(result.document.openapi).toBe("3.2.0");
    expect(result.document.paths['/health'].get).toBeDefined();
    expect(result.report.filesScanned).toBeGreaterThan(0);
  }, 30000);
  it("rejects invalid arguments, escapes and symlink escapes", async () => {
    const {store,root}=await fixture();
    for(const args of [{directory:".."},{timeoutMs:0},{includeTests:"yes"},{frameworks:["unsupported"]},{write:true}]) {
      await expect(executeDevTool("scan_code_to_openapi",args,store)).rejects.toBeDefined();
    }
    const outside=await mkdtemp(path.join(os.tmpdir(),"pd-outside-"));dirs.push(outside);
    await symlink(outside,path.join(root,"linked"),"dir");
    await expect(executeDevTool("scan_code_to_openapi",{directory:"linked"},store)).rejects.toMatchObject({code:"scan_path_denied"});
  });
  it("honors cancellation without loading the missing spec", async () => {
    const {store}=await fixture(); const controller=new AbortController();controller.abort();
    await expect(executeDevTool("scan_code_to_openapi",{},store,{signal:controller.signal})).rejects.toMatchObject({code:"cancelled"});
  });
  it("uses a configured project root even when the spec is elsewhere", async () => {
    const {root}=await fixture();await mkdir(path.join(root,"sub"));
    const result=await executeDevTool("scan_code_to_openapi",{},new SpecStore('/missing/spec.yaml'),{},undefined,{projectRoot:root}) as any;
    expect(result.document.paths['/health']).toBeDefined();
  },30000);
});

it("terminates timed out work and permits a subsequent scan", async () => {
  const {store} = await fixture();
  await expect(executeDevTool("scan_code_to_openapi", {timeoutMs:100}, store)).rejects.toMatchObject({code:"scan_timeout"});
  const result = await executeDevTool("scan_code_to_openapi", {}, store) as any;
  expect(result.document.paths['/health']).toBeDefined();
}, 30000);

it("aborts a running worker and releases its slot", async () => {
  const {store} = await fixture();
  const controller = new AbortController();
  const pending = executeDevTool("scan_code_to_openapi", {}, store, {signal:controller.signal});
  const timer = setTimeout(() => controller.abort(), 50);
  try { await expect(pending).rejects.toMatchObject({code:"cancelled"}); }
  finally { clearTimeout(timer); }
  const result = await executeDevTool("scan_code_to_openapi", {}, store) as any;
  expect(result.document.paths['/health']).toBeDefined();
}, 30000);
