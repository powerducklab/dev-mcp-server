import { fileURLToPath } from 'node:url';
import { SpecStore, runContractSuite } from '../../dist/index.mjs';
import { startBackend } from './server.mjs';
const correct = process.argv.includes('--correct');
const server = await startBackend({ correct });
try {
  const spec = await new SpecStore(fileURLToPath(new URL('./openapi.json', import.meta.url))).load();
  const report = await runContractSuite(spec, { baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 5000 }, {});
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.summary.failed > 0 || report.summary.errors > 0 ? 1 : 0;
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
