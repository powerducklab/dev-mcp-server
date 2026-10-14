import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
await build({
  entryPoints: ["viewer/main.jsx"],
  outdir: "dist/viewer",
  entryNames: "viewer",
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  logLevel: "warning",
});

for (const name of ["viewer.js", "viewer.css"]) {
  await writeFile(
    `dist/viewer/${name}.gz`,
    gzipSync(await readFile(`dist/viewer/${name}`)),
  );
}
