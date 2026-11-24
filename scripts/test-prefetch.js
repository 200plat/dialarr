// The viewer waited 7-11s for a stream to start because the file was only ever
// converted while somebody was watching it. The pre-convert queue must therefore:
//   - be on by default, and actually convert the item that is on air
//   - hand back a file the browser can play
//   - keep the items the look-ahead wants when the cache is full, and throw away
//     the stale ones first — a cache that evicts what it just made just reads the
//     whole library off the mount forever
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-pre-'));
const PORT = 3799 + (process.pid % 400);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [], bumpMs: 0 }));

// three identical mkv files — same size, different cache keys
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(REPO, 'media', 'test.mp4'), '-c', 'copy', path.join(TMP, 'media', 'clip1.mkv')]);
fs.copyFileSync(path.join(TMP, 'media', 'clip1.mkv'), path.join(TMP, 'media', 'clip2.mkv'));
fs.copyFileSync(path.join(TMP, 'media', 'clip1.mkv'), path.join(TMP, 'media', 'clip3.mkv'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '', TC_BAD_RETRY_MS: '5000' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const jget = async (p) => (await (await fetch(BASE + p)).json());
const jpost = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());
const waitFor = async (fn, ms) => {
  const end = Date.now() + (ms || 60000);
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 400)); }
  return null;
};
const statusOf = async (src) => (await jget('/api/transcode/status?src=' + encodeURIComponent(src)));
const ready = (src) => waitFor(async () => { const s = await statusOf(src); return s.status === 'ready' ? s : null; }, 60000);

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // --- pre-convert is on by default ---
  const settings = await jget('/api/settings');
  assert.equal(settings.preTranscode, true, 'pre-convert is on by default');

  // --- the item that is on air gets converted without anybody watching ---
  const made = await jpost('/api/admin/channels', { name: 'Prefetch' });
  const id = made.channel.id;
  await jpost('/api/admin/publish', { channel: id, items: [{ title: 'A', src: '/content/clip1.mkv', duration: 30 }], startIndex: 0 });
  const stA = await ready('/content/clip1.mkv');
  assert.ok(stA, 'the on-air item was converted in the background');
  assert.ok(stA.out && stA.bytes > 0, 'the converted file is recorded');

  // --- and it is a file the browser can actually play ---
  const mp4 = await fetch(BASE + '/transcodes/' + stA.out);
  const buf = Buffer.from(await mp4.arrayBuffer());
  assert.equal(mp4.status, 200, 'the converted file is served');
  assert.ok(buf.length > 1000, 'the converted file has content, got ' + buf.length + ' bytes');
  assert.ok(buf.indexOf('moov') > 0, 'the converted file has a moov box (it is seekable)');

  // --- a change of settings means the file has to be made again ---
  // The languages and the subtitle mode are part of what the file looks like,
  // so changing one of them has to convert the file again.
  const firstReady = (await statusOf('/content/clip1.mkv')).readyAt;
  await jpost('/api/admin/settings', { subtitleMode: 'hard' });
  const remade = await waitFor(async () => { const s = await statusOf('/content/clip1.mkv'); return s.readyAt > firstReady ? s : null; }, 60000);
  assert.ok(remade, 'the file was converted again after the subtitle mode changed');
  assert.equal(remade.status, 'ready', 'and it is ready again');

  // --- the cache keeps what the look-ahead wants, even when it is the oldest ---
  // A is converted first, then goes stale, then comes back on air. B is newer but
  // nobody wants it. With a cache that throws away the oldest first, A (the item
  // that is on air again) is the one that goes — and then it has to be read off the
  // mount all over again, forever.
  await jpost('/api/admin/publish', { channel: id, items: [{ title: 'B', src: '/content/clip2.mkv', duration: 30 }], startIndex: 0 });
  const stB = await ready('/content/clip2.mkv');
  assert.ok(stB, 'the new on-air item was converted');
  await jpost('/api/admin/publish', { channel: id, items: [{ title: 'A again', src: '/content/clip1.mkv', duration: 30 }], startIndex: 0 });
  // the cache holds two of the three files
  await jpost('/api/admin/settings', { transcodeCacheBytes: stA.bytes * 2 + 4096 });
  const other = await jpost('/api/admin/channels', { name: 'Other' });
  await jpost('/api/admin/publish', { channel: other.channel.id, items: [{ title: 'C', src: '/content/clip3.mkv', duration: 30 }], startIndex: 0 });
  assert.ok(await ready('/content/clip3.mkv'), 'the third item was converted');
  await new Promise(r => setTimeout(r, 1000)); // let the eviction settle

  const stillA = await statusOf('/content/clip1.mkv');
  const goneB = await statusOf('/content/clip2.mkv');
  assert.equal(stillA.status, 'ready', 'the item that is on air again survived the eviction');
  assert.notEqual(goneB.status, 'ready', 'the stale item was evicted instead');
  assert.ok(fs.existsSync(path.join(TMP, 'data', 'transcodes', stA.out)), 'the wanted file is still on disk');
  assert.ok(!fs.existsSync(path.join(TMP, 'data', 'transcodes', stB.out)), 'the evicted file is gone from disk');

  // --- a failure is not final ---
  // The library is a usenet mount: a file that is still downloading reads as broken.
  // A failed conversion has to be tried again later, or the episode is condemned for
  // good over a transient hiccup.
  await jpost('/api/admin/publish', { channel: other.channel.id, items: [{ title: 'Gone', src: '/content/not-here.mkv', duration: 30 }], startIndex: 0 });
  const bad = await waitFor(async () => { const s = await statusOf('/content/not-here.mkv'); return s.status === 'bad' ? s : null; }, 30000);
  assert.ok(bad, 'a file that is not there is flagged');
  assert.ok(bad.at > 0, 'the failure is stamped with a time');
  await new Promise(r => setTimeout(r, 2000));
  const stillBad = await statusOf('/content/not-here.mkv');
  assert.equal(stillBad.at, bad.at, 'a fresh failure is left alone');
  // past the retry window, the look-ahead is refreshed (the queue runs on a timer and
  // whenever the settings change) and the failure is tried again
  await new Promise(r => setTimeout(r, 4000));
  await jpost('/api/admin/settings', { transcodeLookahead: 1 });
  const retried = await waitFor(async () => { const s = await statusOf('/content/not-here.mkv'); return s.at > bad.at ? s : null; }, 30000);
  assert.ok(retried, 'a stale failure is tried again');
  assert.equal(retried.status, 'bad', 'and it fails again, which is fine');

  console.log('prefetch: all tests passed');
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
