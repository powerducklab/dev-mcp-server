import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SpecStore } from "../src/spec/store.js";
import {
  authRequirements,
  getOperation,
  getSchema,
  listOperations,
  overview,
} from "../src/spec/facts.js";
import { FactError } from "../src/types.js";

const fixturePath = fileURLToPath(
  new URL(path.join("fixtures", "petstore.yaml"), import.meta.url),
);

async function loadStore() {
  const store = new SpecStore(fixturePath);
  return store.load();
}

describe("spec overview", () => {
  it("summarizes servers, tags, protocols, schemas and security", async () => {
    const snapshot = await loadStore();
    const fact = overview(snapshot.dereferenced);
    expect(fact.title).toBe("Petstore API");
    expect(fact.version).toBe("1.4.2");
    expect(fact.openapiVersion).toMatch(/^3\./);
    expect(fact.endpointCount).toBe(4);
    expect(fact.tags).toEqual(["pets"]);
    expect(fact.protocols).toEqual(["http"]);
    expect(fact.schemaCount).toBe(3);
    expect(fact.servers[0]?.variables).toEqual([]);
    expect(fact.servers[1]?.variables).toEqual(["tenant"]);
    expect(fact.securitySchemes.map((s) => s.name).sort()).toEqual([
      "apiKeyAuth",
      "bearerAuth",
    ]);
  });

  it("reports the fixture as valid", async () => {
    const snapshot = await loadStore();
    expect(snapshot.validation.valid).toBe(true);
    expect(snapshot.validation.issues).toEqual([]);
  });
});

describe("listOperations", () => {
  it("filters by method and auth", async () => {
    const snapshot = await loadStore();
    expect(listOperations(snapshot.dereferenced).total).toBe(4);
    expect(listOperations(snapshot.dereferenced, { method: "get" }).total).toBe(2);
    // listPets opts out of the global bearer requirement; the other three do not.
    expect(listOperations(snapshot.dereferenced, { secured: true }).total).toBe(3);
    expect(listOperations(snapshot.dereferenced, { secured: false }).total).toBe(1);
  });

  it("paginates with an opaque cursor", async () => {
    const snapshot = await loadStore();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const options: { pageSize: number; cursor?: string } = { pageSize: 2 };
      if (cursor) options.cursor = cursor;
      const result = listOperations(snapshot.dereferenced, options);
      seen.push(...result.items.map((item) => item.ref));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it("rejects a malformed cursor", async () => {
    const snapshot = await loadStore();
    expect(() =>
      listOperations(snapshot.dereferenced, { cursor: "not-base64-json" }),
    ).toThrow(FactError);
  });
});

describe("getOperation", () => {
  it("inlines request and response component schemas and resolves auth", async () => {
    const snapshot = await loadStore();
    const fact = getOperation(
      snapshot.dereferenced,
      snapshot.document,
      { ref: "POST /pets" },
    );
    const json = fact.requestBody?.content["application/json"];
    expect(fact.requestBody?.required).toBe(true);
    expect(json?.schema).toMatchObject({
      type: "object",
      required: ["name"],
    });
    expect((json?.schema as { properties: Record<string, unknown> }).properties.name).toBeTruthy();
    expect(json?.example).toEqual({ name: "Rex", tag: "dog" });
    const created = fact.responses.find((response) => response.status === "201");
    const createdSchema = created?.content["application/json"]
      ?.schema as { properties?: Record<string, unknown> };
    expect(createdSchema.properties?.id).toBeTruthy();
    expect(fact.security.map((scheme) => scheme.name)).toEqual(["bearerAuth"]);
    expect(fact.security[0]?.scheme).toBe("bearer");
  });

  it("merges path-level parameters and marks path params required", async () => {
    const snapshot = await loadStore();
    const fact = getOperation(
      snapshot.dereferenced,
      snapshot.document,
      { operationId: "getPet" },
    );
    const petId = fact.parameters.find((parameter) => parameter.name === "petId");
    expect(petId?.in).toBe("path");
    expect(petId?.required).toBe(true);
    expect(petId?.schema.format).toBe("uuid");
  });

  it("throws a coded error for an unknown operation", async () => {
    const snapshot = await loadStore();
    try {
      getOperation(snapshot.dereferenced, snapshot.document, { ref: "GET /nope" });
      throw new Error("expected FactError");
    } catch (error) {
      expect(error).toBeInstanceOf(FactError);
      expect((error as FactError).code).toBe("operation_not_found");
    }
  });
});

describe("getSchema", () => {
  it("resolves by component name and by $ref pointer", async () => {
    const snapshot = await loadStore();
    const byName = getSchema(snapshot.dereferenced, snapshot.document, {
      name: "Pet",
    });
    expect(byName.name).toBe("Pet");
    expect((byName.schema as { required: string[] }).required).toEqual(["id", "name"]);
    const byRef = getSchema(snapshot.dereferenced, snapshot.document, {
      ref: "#/components/schemas/NewPet",
    });
    expect(byRef.name).toBe("NewPet");
  });
});

describe("authRequirements", () => {
  it("distinguishes global auth from an operation that opts out", async () => {
    const snapshot = await loadStore();
    const globalOnly = authRequirements(snapshot.dereferenced);
    expect(globalOnly.global.map((scheme) => scheme.name)).toEqual(["bearerAuth"]);
    const publicList = authRequirements(snapshot.dereferenced, {
      operationId: "listPets",
    });
    expect(publicList.operation).toEqual([]);
    const securedCreate = authRequirements(snapshot.dereferenced, {
      ref: "POST /pets",
    });
    expect(securedCreate.operation?.map((scheme) => scheme.name)).toEqual([
      "bearerAuth",
    ]);
  });
});
