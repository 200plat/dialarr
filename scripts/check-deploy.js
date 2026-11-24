// Deployment smoke check — run inside the container. Works on the data files
// directly, so the site password gate doesn't get in the way.
const fs = require('fs');
const path = require('path');
const DATA = '/app/data';

const lineup = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
const tc = fs.existsSync(path.join(DATA, 'transcodes.json'))
  ? JSON.parse(fs.readFileSync(path.join(DATA, 'transcodes.json'), 'utf8')) : {};

const now = Date.now();
const counts = { cached: 0, notYet: 0, bad: 0, offAir: 0 };
for (const ch of lineup.channels || []) {
  const vs = (ch.versions || []).filter((v) => v.effectiveAtMs <= now).sort((a, b) => a.v - b.v);
  if (!vs.length) { counts.offAir++; continue; }
  const v = vs[vs.length - 1];
  let mv; try { mv = JSON.parse(fs.readFileSync(path.join(DATA, v.manifest), 'utf8')); } catch (e) { counts.offAir++; continue; }
  const loop = (mv.items || []).reduce((s, i) => s + i.duration * 1000, 0) + (mv.items || []).length * (lineup.bumpMs || 0);
  const t = loop > 0 ? (((now - v.epochMs) % loop) + loop) % loop : 0;
  let acc = 0, item = (mv.items || [])[v.startIndex % Math.max(1, (mv.items || []).length)];
  for (const it of mv.items || []) {
    if (t < acc + it.duration * 1000) { item = it; break; }
    acc += it.duration * 1000 + (lineup.bumpMs || 0);
  }
  const src = (item && item.src) || '';
  const st = tc[src];
  const status = st ? st.status : 'unknown';
  if (status === 'ready') counts.cached++;
  else if (status === 'bad') counts.bad++;
  else counts.notYet++;
  const ext = (src.match(/\.[a-z0-9]{2,4}$/i) || ['?'])[0];
  console.log((ch.dial || '?') + ' ' + String(ch.name).slice(0, 22).padEnd(22) + ' ' + status.padEnd(8) + ext.padEnd(6) + src.slice(0, 110));
}
console.log('\non air now: cached=' + counts.cached + '  converting=' + counts.notYet + '  flagged-bad=' + counts.bad + '  off-air=' + counts.offAir);
const byStatus = {};
for (const k in tc) byStatus[tc[k].status] = (byStatus[tc[k].status] || 0) + 1;
console.log('cache store:', JSON.stringify(byStatus));
let bytes = 0; for (const k in tc) if (tc[k].status === 'ready') bytes += tc[k].bytes || 0;
console.log('cached bytes:', (bytes / 1024 / 1024 / 1024).toFixed(2), 'GB');
