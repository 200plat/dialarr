// Duration probing must never fall back to the 30-minute guess when the truth is known:
//  - a src filed under the wrong library root is found (and corrected) under the other one
//  - a cached 1800 fallback from an earlier failed probe is re-probed, not trusted
// Runs a throwaway server against temp TV/movies roots.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-dur-'));
const PORT = 3999 + (process.pid % 500);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'TV'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'Movies'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.cpSync(path.join(REPO, 'media'), path.join(TMP, 'media'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

// a movie that really lives under the movies root …
const mv = path.join(TMP, 'Movies', 'B Movie (2012)');
fs.mkdirSync(mv, { recursive: true });
fs.copyFileSync(path.join(REPO, 'media', 'tape2.mp4'), path.join(mv, 'B Movie (2012).mp4'));
// … and a show under the TV root
const tv = path.join(TMP, 'TV', 'A Show (2011)');
fs.mkdirSync(tv, { recursive: true });
fs.copyFileSync(path.join(REPO, 'media', 'test.mp4'), path.join(tv, 'A Show (2011).mp4'));
// … and a file ffprobe cannot read at all, so its probe FAILS
const broken = path.join(TMP, 'TV', 'Broken (2011)');
fs.mkdirSync(broken, { recursive: true });
fs.writeFileSync(path.join(broken, 'Broken (2011).mp4'), Buffer.alloc(200000, 0x41));

// a poisoned cache entry: an earlier failed probe frozen at the 30-minute fallback
fs.writeFileSync(path.join(TMP, 'data', 'durations.json'), JSON.stringify({
  '/content/A Show (2011)/A Show (2011).mp4': 1800
}));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'TV'), MOVIES_DIR: path.join(TMP, 'Movies'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const jget = async (p) => (await (await fetch(BASE + p)).json());
const jpost = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const made = await jpost('/api/admin/channels', { name: 'Durations' });
  const id = made.channel.id;
  // right prefix: what the generator now emits for movies
  await jpost('/api/admin/channel/shows/add', { channel: id, name: 'Movies', files: ['B Movie (2012)/B Movie (2012).mp4'], root: 'movies' });
  // legacy wrong prefix: movie filed under the TV root
  await jpost('/api/admin/channel/shows/add', { channel: id, name: 'Legacy', files: ['B Movie (2012)/B Movie (2012).mp4'] });
  // poisoned cache entry: failed probe frozen at 1800
  await jpost('/api/admin/channel/shows/add', { channel: id, name: 'Poisoned', files: ['A Show (2011)/A Show (2011).mp4'] });
  // a local file carrying a bogus 14-hour length from an earlier build (the
  // half-downloaded header the incident produced) must not keep that length when
  // the probe can't measure the file either
  await jpost('/api/admin/channel/shows/add', {
    channel: id, name: 'Bogus',
    episodes: [{ title: 'Glitched', src: '/content/Broken (2011)/Broken (2011).mp4', duration: 14 * 3600 }]
  });
  const built = await jpost('/api/admin/channel/build', { channel: id, mode: 'roundrobin', commercialEvery: 0 });
  assert.ok(built.ok, 'build ok');

  const lineup = await jget('/broadcast/lineup.json');
  const ch = lineup.channels.find(c => c.id === id);
  const show = n => ch.shows.find(s => s.name === n).episodes[0];
  const real = e => e.duration > 20 && e.duration < 60;

  assert.ok(show('Movies').src.startsWith('/movies/'), 'movies keep the movies root: ' + show('Movies').src);
  assert.ok(show('Poisoned').src.startsWith('/content/'), 'TV keeps the content root: ' + show('Poisoned').src);
  assert.ok(show('Legacy').src.startsWith('/movies/'), 'legacy wrong-root src is corrected: ' + show('Legacy').src);
  assert.ok(real(show('Movies')), 'movie duration is real, got ' + show('Movies').duration);
  assert.ok(real(show('Legacy')), 'legacy movie duration is real, got ' + show('Legacy').duration);
  assert.ok(real(show('Poisoned')), 'poisoned 1800 cache entry is re-probed, got ' + show('Poisoned').duration);
  // the probe of this file fails (ffmpeg can't read it), so it falls back to the
  // 30-minute guess — but never keeps the 14-hour length it was given
  assert.ok(show('Bogus').duration <= 1800, 'a bogus length is not kept when the probe fails, got ' + show('Bogus').duration);

  const man = await jget('/broadcast/' + ch.versions.slice(-1)[0].manifest);
  // every item except the deliberately unreadable one must be a real measurement
  const readable = man.items.filter(i => i.title !== 'Glitched');
  assert.ok(readable.every(i => real(i)), 'no 30-minute fallbacks in the manifest: ' + JSON.stringify(readable.map(i => [i.title, i.duration])));
  assert.ok(man.items.some(i => i.src.startsWith('/movies/')), 'manifest carries the corrected movie src');

  // An implausible length must never reach the guide: a 14-hour "episode" (a glitched
  // file's bogus header) once drove the player to seek past the end of the real file,
  // which made ffmpeg die instantly and the client reconnect in a tight loop.
  const bogus = await jpost('/api/admin/publish', {
    channel: id,
    items: [
      { title: 'Glitched', src: '/content/A Show (2011)/A Show (2011).mp4', duration: 14 * 3600 },
      { title: 'Fine', src: '/content/A Show (2011)/A Show (2011).mp4', duration: 45 }
    ],
    startIndex: 0
  });
  assert.ok(bogus.ok, 'publish ok');
  const lineup2 = await jget('/broadcast/lineup.json');
  const ch2 = lineup2.channels.find(c => c.id === id);
  const man2 = await jget('/broadcast/' + ch2.versions.slice(-1)[0].manifest);
  const glitched = man2.items.find(i => i.title === 'Glitched');
  assert.ok(glitched.duration <= 8 * 3600, 'implausible duration is capped, got ' + glitched.duration);
  assert.ok(man2.items.every(i => i.duration <= 8 * 3600), 'no item exceeds the ceiling');

  console.log('durations: all tests passed');
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
