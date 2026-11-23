// Rebuild the movie channels so their playlists are regenerated from the (correct)
// show lists. Run inside the container.
// Same parameters the channels were built with: roundrobin, a commercial after every
// episode, 15-second commercials.
const fs = require('fs');
const path = require('path');
const B = 'http://localhost:3005';
// the channel dials to look at come from argv: node rebuild-movies.js 5 6 7
const wanted = process.argv.slice(2);

(async () => {
  const login = await fetch(B + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD })
  });
  if (!login.ok) { console.log('login failed:', login.status); process.exit(1); }
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const lineup = JSON.parse(fs.readFileSync('/app/data/lineup.json', 'utf8'));
  for (const ch of lineup.channels) {
    if (!WANT.includes(String(ch.dial))) continue;
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(B + '/api/admin/channel/build', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          channel: ch.id, mode: 'roundrobin', commercialEvery: 1, commercialDuration: 15,
          order: (ch.shows || []).map((s) => s.id), marathon: { on: false, block: 3, count: 1 }
        })
      });
      text = await res.text();
    } catch (e) {
      console.log(ch.dial + ' ' + ch.name + ' -> ERROR ' + e.message);
      continue;
    }
    let out = text;
    try { const j = JSON.parse(text); out = 'v' + j.v + ' ' + j.episodes + ' episodes, ' + j.commercials + ' commercials'; } catch (e) {}
    console.log(ch.dial + ' ' + String(ch.name).slice(0, 24).padEnd(24) + ' -> ' + res.status + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's   ' + out.slice(0, 120));
  }
})();
