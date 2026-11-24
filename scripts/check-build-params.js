// What are the movie channels currently playing? Count commercials per N episodes and
// look at the order, so a rebuild reproduces the same character.
const fs = require('fs');
const path = require('path');
const DATA = '/app/data';
const lineup = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
const now = Date.now();
// the channel dials to look at come from argv: node check-build-params.js 5 6 7
const wanted = process.argv.slice(2);
for (const ch of lineup.channels || []) {
  if (!wanted.includes(String(ch.dial))) continue;
  const vs = (ch.versions || []).filter((v) => v.effectiveAtMs <= now).sort((a, b) => a.v - b.v);
  if (!vs.length) { console.log(ch.dial + ' ' + ch.name + ' — off air'); continue; }
  const v = vs[vs.length - 1];
  const mv = JSON.parse(fs.readFileSync(path.join(DATA, v.manifest), 'utf8'));
  const items = mv.items || [];
  const ads = items.filter((i) => i.isAd).length;
  const shows = (ch.shows || []).map((s) => s.name);
  // order signature: the first few episode titles, to tell roundrobin from sequential
  const first = items.filter((i) => !i.isAd).slice(0, 5).map((i) => (i.title || '').slice(0, 18));
  console.log(ch.dial + ' ' + String(ch.name).slice(0, 24).padEnd(24) +
    ' v' + v.v + '  items=' + String(items.length).padStart(4) + '  commercials=' + String(ads).padStart(4) +
    '  adsPerEpisode=' + (ads ? (items.length / ads).toFixed(2) : 'n/a') +
    '  shows=' + shows.length + ' [' + shows.slice(0, 2).join(', ') + ']');
  console.log('      first: ' + first.join(' | '));
}
