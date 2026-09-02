import http from 'node:http';

/**
 * Admin HTTP server (design doc §7.9 task spec): `GET /healthz` only. The caller is responsible
 * for binding this to loopback (`127.0.0.1`) — see `index.ts` — so it's never reachable from the
 * `workers` network like the proxy port itself is.
 */
export function createAdminServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}
