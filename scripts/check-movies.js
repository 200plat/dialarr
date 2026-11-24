// What do the movie channels actually hold? Shows, episodes, and whether their
// cached durations would let a rebuild re-probe (and fix) the wrong root.
const fs = require('fs');
const path = require('path');
const DATA = '/app/data';
const lineup = JSON.parse(fs.readFileSync(path.join(DATA, 'lineup.json'), 'utf8'));
const durs = JSON.parse(fs.readFileSync(path.join(DATA, 'durations.json'), 'utf8'));
const CONTENT_DIR = process.env.CONTENT_DIR || '/app/media';
const MOVIES_DIR = process.env.MOVIES_DIR || path.join(path.dirname(CONTENT_DIR), 'Movies');
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };
const absOf = (src) => src.startsWith('/content/') ? path.join(CONTENT_DIR, src.slice(9)) : src.startsWith('/movies/') ? path.join(MOVIES_DIR, src.slice(8)) : null;

// the channel dials to look at come from argv: node check-movies.js 5 6 7
const wanted = process.argv.slice(2);
for (const ch of lineup.channels || []) {
  if (!wanted.includes(String(ch.dial))) continue;
  const shows = ch.shows || [];
  let eps = 0, local = 0, missing = 0, cachedPositive = 0, cachedNone = 0, underMovies = 0;
  const sample = [];
  for (const s of shows) for (const e of s.episodes || []) {
    eps++;
    if (!/^\/(content|movies)\//.test(e.src)) continue;
    local++;
    const c = durs[e.src];
    if (c > 0) cachedPositive++; else cachedNone++;
    const abs = absOf(e.src);
    if (abs && !exists(abs)) {
      missing++;
      const rel = e.src.replace(/^\/(content|movies)\//, '');
      const other = e.src.startsWith('/content/') ? path.join(MOVIES_DIR, rel) : path.join(CONTENT_DIR, rel);
      if (exists(other)) { underMovies++; if (sample.length < 2) sample.push(path.basename(e.src).slice(0, 50)); }
    }
  }
  console.log(ch.dial + ' ' + String(ch.name).slice(0, 26).padEnd(26) +
    ' shows=' + String(shows.length).padStart(3) + '  episodes=' + String(eps).padStart(5) +
    '  local=' + String(local).padStart(5) + '  missing=' + String(missing).padStart(4) +
    '  found-under-movies=' + String(underMovies).padStart(4) +
    '  cached-duration=' + String(cachedPositive).padStart(5) + '  not-cached=' + String(cachedNone).padStart(4));
  if (sample.length) console.log('      e.g. ' + sample.join(' | '));
}
