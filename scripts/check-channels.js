// What is on air right now, per channel, and is any of it flagged broken?
// Reads the playlist and the transcode store only — no filesystem sweep, so it is
// quick even with tens of thousands of episodes. Run inside the container.
const fs = require('fs');
const path = require('path');
const DATA = '/app/data';
const lineup = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
const tc = JSON.parse(fs.readFileSync(path.join(DATA, 'transcodes.json'), 'utf8'));
const now = Date.now();
let onAir = 0, flagged = 0;
for (const ch of lineup.channels || []) {
  const vs = (ch.versions || []).filter((v) => v.effectiveAtMs <= now).sort((a, b) => a.v - b.v);
  if (!vs.length) { console.log((ch.dial || '?').toString().padStart(4) + ' ' + String(ch.name).slice(0, 26).padEnd(26) + ' off air'); continue; }
  const v = vs[vs.length - 1];
  const mv = JSON.parse(fs.readFileSync(path.join(DATA, v.manifest), 'utf8'));
  const items = mv.items || [];
  const eps = items.filter((i) => !i.isAd);
  const local = eps.filter((i) => /^\/(content|movies)\//.test(i.src));
  const bad = local.filter((i) => tc[i.src] && tc[i.src].status === 'bad');
  const errs = {};
  for (const b of bad) { const e = (tc[b.src].err || '?').slice(0, 30); errs[e] = (errs[e] || 0) + 1; }
  onAir += local.length; flagged += bad.length;
  console.log((ch.dial || '?').toString().padStart(4) + ' ' + String(ch.name).slice(0, 26).padEnd(26) +
    ' v' + String(v.v).padEnd(3) + ' items ' + String(items.length).padStart(5) +
    '  local ' + String(local.length).padStart(5) + '  flagged ' + String(bad.length).padStart(4) +
    (bad.length ? '  <<<  ' + Object.keys(errs).map((e) => errs[e] + ' ' + e).join(', ') : ''));
}
console.log('\nON AIR NOW: ' + onAir + ' local episodes, ' + flagged + ' of them flagged broken');
