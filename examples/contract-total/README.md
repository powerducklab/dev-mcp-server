# Reproduce a real contract mismatch

Requirements: Node.js >= 20.11 and npm. From a clean checkout of this repository:

```sh
npm ci
npm run build
node examples/contract-total/verify.mjs
# Exit 1: response.total is a string, but the schema requires a number.
node examples/contract-total/verify.mjs --correct
# Exit 0: the real backend now returns a number.
```

The script reads `openapi.json`, starts `server.mjs` on an OS-assigned port bound
only to 127.0.0.1, and uses the existing developer MCP contract runner to send a
real HTTP request and validate its response. All data is fictional. No model,
account, public API or Mock is involved. Dependencies must be installed before
running offline. Change the backend's `total` expression to `42` to repair it
manually; do not weaken the schema to hide the bug.

For an optional Agent workflow, start `node examples/contract-total/server.mjs`,
copy its printed local URL, connect the **developer MCP** with this spec, and ask
the Agent to read the contract and run contract tests against that URL. Review
its proposed code change before applying it, restart the backend and re-run.
Developer MCP provides contract facts and verification for coding Agents.
**API-to-MCP** instead exposes API operations as tools; it is not this verifier.
A successful Mock response does not validate a real backend implementation.
