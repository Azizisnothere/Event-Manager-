const http = require('http');

const PORT = 8081;
const FLOCI = { host: '127.0.0.1', port: 4566 };
const SITE_HOST = 'em-frontend.s3-website-us-east-1.localhost';

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === 'host' || key.startsWith('x-forwarded') || key === 'forwarded' || key.startsWith('cf-')) continue;
    headers[k] = v;
  }
  headers.host = SITE_HOST;
  const up = http.request({ ...FLOCI, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Floci is not running'); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Website helper on http://localhost:${PORT} -> Floci website ${SITE_HOST}`);
  console.log(`Now run: cloudflared tunnel --url http://localhost:${PORT}`);
});
