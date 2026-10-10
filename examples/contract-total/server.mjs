import http from 'node:http';
import { pathToFileURL } from 'node:url';
export function startBackend({ correct = false, port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' || req.url !== '/orders/summary') {
      res.writeHead(404); res.end(JSON.stringify({ error: 'not_found' })); return;
    }
    // The intentional implementation bug: the contract requires a number.
    res.end(JSON.stringify({ total: correct ? 42 : '42' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startBackend({ correct: process.argv.includes('--correct'), port: Number(process.env.PORT || 0) });
  console.log(`http://127.0.0.1:${server.address().port}`);
}
