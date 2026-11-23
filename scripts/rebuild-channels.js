// Rebuild specific channels (ids from argv) via the admin API.
//
//   node scripts/rebuild-channels.js --mode=smartshuffle <channel-id> [...]
//
// ADMIN_PASSWORD must be set in the environment.
const http = require('http');
const MODE = { roundrobin: 'roundrobin', smartshuffle: 'smartshuffle', sequential: 'sequential' };
const modeArg = (process.argv.find(a => a.startsWith('--mode=')) || '').split('=')[1] || 'smartshuffle';
if (!MODE[modeArg]) { console.error('unknown mode: ' + modeArg); process.exit(1); }
function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: 3005, method, path: p, headers }, res => {
      let out = ''; res.on('data', d => out += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const ids = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const lr = await req('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD });
  const cookie = (lr.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  for (const id of ids) {
    const mode = modeArg;
    const t0 = Date.now();
    const r = await req('POST', '/api/admin/channel/build', { channel: id, mode, commercialEvery: 1, commercialDuration: 15 }, cookie);
    let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
    console.log(id.padEnd(18), mode.padEnd(12), j.ok ? ('v' + j.v + '  ' + j.episodes + ' eps  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's') : ('ERR ' + (j.error || r.body.slice(0, 100))));
  }
  console.log('DONE');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
