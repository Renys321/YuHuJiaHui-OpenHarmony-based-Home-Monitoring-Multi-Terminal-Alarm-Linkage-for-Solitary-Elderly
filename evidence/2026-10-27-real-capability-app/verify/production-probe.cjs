const https = require('https');
function get(path) {
  return new Promise((resolve) => {
    const req = https.get({ host: 'api.luxunacc.xyz', path, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ path, status: res.statusCode, body: body.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ path, status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ path, status: 'ERROR', error: e.message }));
  });
}
(async () => {
  const out = [];
  out.push(await get('/healthz'));
  out.push(await get('/api/v1/devices'));
  out.push(await get('/api/v1/rooms'));
  out.push(await get('/api/v1/health-profile'));
  require('fs').writeFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), probes: out }, null, 2));
  console.log(JSON.stringify(out));
})();
