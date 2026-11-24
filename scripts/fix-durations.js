// Re-probe and rebuild every channel whose durations are still wrong.
// Run inside the container: docker exec -i tv node - < scripts/fix-durations.js
// Uses the admin API only — it never edits data/lineup.json or data/manifests by hand.
const fs = require('fs'), path = require('path');
const HOST = '127.0.0.1', PORT = 3005, DATA = '/app/data';

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const r = require('http').request({ host: HOST, port: PORT, method, path: p, headers }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// how each channel was built: read the show order out of the published manifest
function detectMode(ch, srcShow) {
  const v = (ch.versions || []).slice(-1)[0];
  if (!v) return 'smartshuffle';
  const man = JSON.parse(fs.readFileSync(path.join(DATA, v.manifest), 'utf8'));
  const seq = man.items.filter(i => !i.isAd).map(i => srcShow.get(i.src)).filter(Boolean);
  const per = new Set(seq).size || 1;
  for (let i = 0; i < seq.length; i++) if (seq[i] !== seq[i % per]) return 'smartshuffle';
  return 'roundrobin';
}

(async () => {
  const l = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
  const plan = [];
  for (const ch of l.channels) {
    const srcShow = new Map();
    let bad = 0;
    for (const s of ch.shows || []) for (const e of s.episodes || []) {
      srcShow.set(e.src, s.id);
      if (e.duration === 1800) bad++;
    }
    if (bad) plan.push({ id: ch.id, name: ch.name, bad, mode: detectMode(ch, srcShow) });
  }
  console.log('channels to rebuild: ' + plan.length);
  for (const p of plan) console.log('  ' + p.name.padEnd(26) + 'at1800=' + String(p.bad).padEnd(5) + p.mode);
  if (!plan.length) { console.log('nothing to do'); return; }

  const lr = await req('POST', '/api/admin/login', { password: process.env.ADMIN_PASSWORD });
  if (lr.status !== 200) throw new Error('login failed: ' + lr.status + ' ' + lr.body);
  const cookie = (lr.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  for (const p of plan) {
    const t0 = Date.now();
    const r = await req('POST', '/api/admin/channel/build', { channel: p.id, mode: p.mode, commercialEvery: 1, commercialDuration: 15 }, cookie);
    let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
    console.log(p.id.padEnd(24), p.mode.padEnd(12), j.ok ? ('v' + j.v + '  ' + j.episodes + ' eps  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's') : ('ERR ' + (j.error || r.body.slice(0, 120))));
  }
  console.log('DONE');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
