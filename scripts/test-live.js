// A broken file must not be able to spawn ffmpeg in a tight loop (that took the box
// down once), and a healthy file must never be mistaken for a broken one.
// Runs a throwaway server against a temp media root.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-live-'));
const PORT = 3499 + (process.pid % 500);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

// a healthy 10-second clip
fs.copyFileSync(path.join(REPO, 'media', 'ad.mp4'), path.join(TMP, 'media', 'good.mp4'));
// an unreadable file: ffmpeg cannot open it at all
fs.writeFileSync(path.join(TMP, 'media', 'broken.mp4'), Buffer.alloc(200000, 0x41));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const jget = async (p) => (await (await fetch(BASE + p)).json());

// Pull the live stream and report status + byte count. The pipe runs at 1x now
// (so it stays in step with the broadcast clock), so read a little of it rather
// than the whole thing — a full read takes as long as the clip does.
async function live(src, seek) {
  const r = await fetch(BASE + '/stream/live?src=' + encodeURIComponent(src) + '&seek=' + (seek || 0));
  if (r.status !== 200) return { status: r.status };
  const reader = r.body.getReader();
  let bytes = 0;
  while (bytes < 20000) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  try { await reader.cancel(); } catch (e) {}
  return { status: 200, bytes };
}
// How many ffmpeg processes the server has running — one per live pipe.
function ffmpegCount() {
  try {
    return Number(execSync(`ps -eo pid,ppid,args | grep '[f]fmpeg' | grep ' ${server.pid} ' | wc -l`).toString().trim());
  } catch (e) { return -1; }
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // --- a healthy file plays, every time, and is never blocked ---
  for (let i = 0; i < 5; i++) {
    const r = await live('/content/good.mp4', 0);
    assert.equal(r.status, 200, 'healthy file request ' + i + ' got ' + r.status);
    assert.ok(r.bytes > 10000, 'healthy file streamed real video, got ' + r.bytes + ' bytes');
  }
  // a seek into the last second of a healthy file is still healthy — it must not
  // be counted as a failure (the file is fine; the tail is just short)
  const tail = await live('/content/good.mp4', 9);
  assert.equal(tail.status, 200, 'healthy tail got ' + tail.status);
  assert.ok(tail.bytes > 1000, 'healthy tail streamed video, got ' + tail.bytes + ' bytes');
  // and it still plays afterwards — a false strike would have blocked it
  const after = await live('/content/good.mp4', 0);
  assert.equal(after.status, 200, 'healthy file after a tail request got ' + after.status);

  // --- three viewers of one file share a single encode ---
  // A channel is a clock: everybody watching it is at the same place, so they can
  // all watch the same pipe. One ffmpeg for the channel, however many people are
  // watching.
  const shared = [0, 1, 2].map(() => fetch(BASE + '/stream/live?src=' + encodeURIComponent('/content/good.mp4') + '&seek=0'));
  await new Promise(r => setTimeout(r, 1500));
  const pipes = ffmpegCount();
  if (pipes >= 0) {
    assert.equal(pipes, 1, 'three viewers of one file must share a single encode, got ' + pipes + ' ffmpeg processes');
    console.log('live: three viewers, one encode');
  }
  for (const p of shared) { try { await (await p).arrayBuffer(); } catch (e) {} }

  // --- a broken file is refused after a few tries, not looped on forever ---
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const r = await live('/content/broken.mp4', 0);
    codes.push(r.status);
  }
  assert.ok(codes.includes(503), 'broken file is eventually refused, got ' + codes.join(','));
  assert.ok(codes.slice(0, 3).every(c => c === 200), 'broken file is not refused instantly, got ' + codes.join(','));

  // --- the block is per file: the healthy one still works ---
  const stillGood = await live('/content/good.mp4', 0);
  assert.equal(stillGood.status, 200, 'blocking one file must not block another, got ' + stillGood.status);

  // --- a seek past the end of a healthy file is the guide's fault, not the file's ---
  // The seek is clamped to the file's real duration, so the pipe serves the tail and
  // stays green: a manifest mismatch must not flag a healthy file as broken.
  const pastCodes = [];
  for (let i = 0; i < 5; i++) pastCodes.push((await live('/content/good.mp4', 99999)).status);
  assert.ok(pastCodes.every(c => c === 200), 'a past-EOF seek on a healthy file is served, not blocked, got ' + pastCodes.join(','));

  // --- the manifest the browser reads never shows an implausible length ---
  // A manifest published before the ceiling existed still carries the bad length,
  // and it is served straight from disk — so the ceiling has to be applied there.
  fs.mkdirSync(path.join(TMP, 'data', 'manifests', 'old'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'manifests', 'old', 'v1.json'), JSON.stringify({
    items: [{ title: 'Glitched', src: '/content/good.mp4', duration: 14 * 3600 }, { title: 'Fine', src: '/content/good.mp4', duration: 45 }],
    epochMs: Date.now(), startIndex: 0
  }));
  const mv = await (await fetch(BASE + '/broadcast/manifests/old/v1.json')).json();
  assert.ok(mv.items.every(i => i.duration <= 8 * 3600), 'the served manifest is clamped, got ' + JSON.stringify(mv.items.map(i => i.duration)));
  assert.ok(mv.items.find(i => i.title === 'Glitched').duration === 8 * 3600, 'the bad length is capped at 8h');

  console.log('live: all tests passed');
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
