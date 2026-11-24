// Queue/throughput check — run inside the container.
const fs = require('fs');
const path = require('path');
const DATA = '/app/data';
const tc = JSON.parse(fs.readFileSync(path.join(DATA, 'transcodes.json'), 'utf8'));
const lineup = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
const s = lineup.settings || {};
console.log('settings: preTranscode=' + s.preTranscode + ' cacheGB=' + ((s.transcodeCacheBytes || 0) / 1024 ** 3).toFixed(1) + ' lookahead=' + s.transcodeLookahead);
const now = Date.now();
const working = [], ready = [];
for (const k in tc) {
  const e = tc[k];
  if (e.status === 'working') working.push({ k, mins: ((now - (e.startedAt || now)) / 60000).toFixed(1), mb: ((e.bytes || 0) / 1e6).toFixed(0) });
  if (e.status === 'ready') ready.push({ k, minsAgo: ((now - (e.readyAt || now)) / 60000).toFixed(0), mb: ((e.bytes || 0) / 1e6).toFixed(0) });
}
console.log('\nworking (' + working.length + '):');
for (const w of working) console.log('  running ' + w.mins + ' min   ' + w.mb + ' MB   ' + w.k.split('/').pop().slice(0, 60));
console.log('\nready (' + ready.length + '), most recent first:');
ready.sort((a, b) => a.minsAgo - b.minsAgo);
for (const r of ready.slice(0, 6)) console.log('  ' + r.minsAgo + ' min ago   ' + r.mb + ' MB   ' + r.k.split('/').pop().slice(0, 60));
let bytes = 0; for (const k in tc) if (tc[k].status === 'ready') bytes += tc[k].bytes || 0;
console.log('\ntotal ready bytes: ' + (bytes / 1024 ** 3).toFixed(2) + ' GB');
