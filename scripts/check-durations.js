// Are the movie episodes' probe failures old enough to be retried?
// Run inside the container. The build only re-probes a file whose cached failure is
// older than 6 hours — a recent failure is skipped and the root is never corrected.
const fs = require('fs');
const path = require('path');
const DATA = '/app/data';
const durs = JSON.parse(fs.readFileSync(path.join(DATA, 'durations.json'), 'utf8'));
const lineup = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
const RETRY = 6 * 3600 * 1000;
const now = Date.now();

const counts = { measured: 0, failedOld: 0, failedRecent: 0, unknown: 0 };
const rows = [];
for (const ch of lineup.channels || []) {
  let failedRecent = 0, failedOld = 0, measured = 0, unknown = 0, total = 0;
  for (const s of ch.shows || []) for (const e of s.episodes || []) {
    if (!e.src || !/^\/(content|movies)\//.test(e.src)) continue;
    total++;
    const c = durs[e.src];
    if (c > 0) measured++;
    else if (c < 0) { if (now + c < RETRY) failedRecent++; else failedOld++; }
    else unknown++;
  }
  if (!total) continue;
  counts.measured += measured; counts.failedOld += failedOld; counts.failedRecent += failedRecent; counts.unknown += unknown;
  if (failedRecent || failedOld) rows.push([ch.dial, ch.name, total, measured, failedOld, failedRecent, unknown]);
}
console.log('local episodes across all channels: measured=' + counts.measured + '  failed>6h ago=' + counts.failedOld + '  failed<6h ago=' + counts.failedRecent + '  never probed=' + counts.unknown);
console.log('\nper channel (local episodes):');
console.log('  ch   name                       total  measured  failed>6h  failed<6h  never');
for (const r of rows) console.log('  ' + String(r[0]).padStart(4) + ' ' + String(r[1]).slice(0, 24).padEnd(24) + String(r[2]).padStart(6) + String(r[3]).padStart(9) + String(r[4]).padStart(10) + String(r[5]).padStart(11) + String(r[6]).padStart(7));
