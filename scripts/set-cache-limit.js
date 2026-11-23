// Raise the transcode cache limit on the running box.
// Run inside the container: uses the container's ADMIN_PASSWORD without printing it.
// The limit is DISK space (the converted mp4s live in the data volume and are served
// as static files), not memory.
const fs = require('fs');
const B = 'http://localhost:3005';
const GB = 1024 * 1024 * 1024;
const show = (label, r, t) => console.log(label + ' -> ' + r.status + '  ' + t.slice(0, 80).replace(/\n/g, ' '));
(async () => {
  const before = (JSON.parse(fs.readFileSync('/app/data/lineup.json', 'utf8')).settings) || {};
  console.log('before: cache=' + ((before.transcodeCacheBytes || 0) / GB).toFixed(1) + 'GB  look-ahead=' + before.transcodeLookahead + '  pre-convert=' + before.preTranscode);
  const login = await fetch(B + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD })
  });
  const t = await login.text();
  show('login', login, t);
  if (!login.ok) process.exit(1);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const res = await fetch(B + '/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ transcodeCacheBytes: 12 * GB })
  });
  show('settings POST', res, await res.text());
  const after = (JSON.parse(fs.readFileSync('/app/data/lineup.json', 'utf8')).settings) || {};
  console.log('after:  cache=' + ((after.transcodeCacheBytes || 0) / GB).toFixed(1) + 'GB  look-ahead=' + after.transcodeLookahead + '  pre-convert=' + after.preTranscode);
})();
