// The production incident: a broken file made the client reconnect in a tight loop,
// and each reconnect spawned an ffmpeg — hundreds of processes, and the box died.
// This checks the two ends of that: the server refuses to keep spawning for a file
// that produces nothing, and no more than a couple of ffmpeg run at once.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-crash-'));
const PORT = 3699 + (process.pid % 300);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

// a file ffmpeg cannot read at all
fs.writeFileSync(path.join(TMP, 'media', 'broken.mp4'), Buffer.alloc(200000, 0x41));
// a file that IS readable
fs.copyFileSync(path.join(REPO, 'media', 'ad.mp4'), path.join(TMP, 'media', 'good.mp4'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const jget = async (p) => (await (await fetch(BASE + p)).json());

function ffmpegCount() {
  try {
    return parseInt(execSync("pgrep -c -f 'ffmpeg .*pipe:1' || true").toString().trim() || '0', 10);
  } catch (e) { return 0; }
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // 60 rapid reconnects against the broken file — what the browser did in a loop
  let peak = 0, served = 0, refused = 0;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(BASE + '/stream/live?src=' + encodeURIComponent('/content/broken.mp4') + '&seek=0');
    await r.arrayBuffer();
    if (r.status === 200) served++; else refused++;
    peak = Math.max(peak, ffmpegCount());
  }
  console.log('  60 reconnects on a broken file →', served, 'spawned ffmpeg,', refused, 'refused,', 'peak concurrent:', peak);
  assert.ok(served <= 5, 'the broken file stops spawning ffmpeg after a few tries, spawned ' + served);
  assert.ok(refused > 50, 'most reconnects are refused, refused ' + refused);
  assert.ok(peak <= 2, 'at most a couple of ffmpeg run at once, peak was ' + peak);

  // and the healthy file is unaffected
  const good = await fetch(BASE + '/stream/live?src=' + encodeURIComponent('/content/good.mp4') + '&seek=0');
  const goodBytes = (await good.arrayBuffer()).byteLength;
  assert.equal(good.status, 200, 'healthy file still served');
  assert.ok(goodBytes > 10000, 'healthy file still streams video, got ' + goodBytes);

  console.log('crash-loop: all tests passed');
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
