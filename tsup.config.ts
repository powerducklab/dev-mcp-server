import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  // Two entry points:
  // - index: programmatic library surface for embedders and tests
  // - cli:   standalone stdio binary launched by AI coding clients
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  target: "node20",
  platform: "node",
  dts: { resolve: false },
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  external: [
    "@modelcontextprotocol/sdk",
    "@powerduck/openapi-cli",
    "@powerduck/openapi-parser",
    "@powerduck/openapi-request",
    "commander",
    "js-yaml",
  ],
  shims: true,
  banner({ format }) {
    if (format === "esm") {
      return {
        js: [
          "#!/usr/bin/env node",
          "import { createRequire as __createRequire } from 'module';",
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      };
    }
    return { js: "#!/usr/bin/env node" };
  },
  minify: "terser",
  watch: options.watch,
}));
