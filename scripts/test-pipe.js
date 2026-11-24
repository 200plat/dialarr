// The live pipe: what a viewer gets, and how many encoders it costs.
// Runs a throwaway server against a temp media root and checks two things the
// picture depends on:
//   1. the stream a viewer receives is a valid fragmented MP4 — for the viewer
//      who starts the pipe AND for the one who joins it a second later
//   2. one channel, one encode — two viewers of the same file share one ffmpeg
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-pipe-'));
const PORT = 3599 + (process.pid % 400);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

// Long enough that the pipe produces a few fragments, black so that any bright
// pixel is a subtitle the encoder drew.
const made = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=640x360:rate=25:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20',
  '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
  '-map', '0:v', '-map', '1:a', '-map', '2:a',
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Stereo',
  '-metadata:s:a:1', 'language=jpn', '-metadata:s:a:1', 'title=Japanese',
  path.join(TMP, 'media', 'show.mkv')
], { encoding: 'utf8' });
if (made.status !== 0) { console.error('could not build the test file:', made.stderr); process.exit(1); }
// A second file, for the case where two viewers arrive at the same moment and
// there is no pipe yet.
fs.copyFileSync(path.join(TMP, 'media', 'show.mkv'), path.join(TMP, 'media', 'show2.mkv'));
// A file with a subtitle of its own, for the hard-subtitle burn. The line is
// said at 20 seconds, so a pipe that starts at 21 must show it right away —
// the cues are timed against the whole file and the picture's clock starts at
// zero where the pipe started.
fs.writeFileSync(path.join(TMP, 'line.srt'), '1\n00:00:20,000 --> 00:00:25,000\nTHE LINE IS SPOKEN\n');
// The same, but the way the bad releases write their songs: karaoke timing —
// a hundred one-letter cues a second, placed at the top of the picture, in a
// font as big as the screen. Burnt as-is, the letters stack into a wall down
// the middle of the show. The dialogue line is in there too, after the song.
{
  const cues = [];
  for (let i = 0; i < 32; i++) {
    const sec = 22 + Math.floor(i / 8), ms = (i % 8) * 100;
    cues.push(String(i + 1) + '\n00:00:' + sec + ',' + String(ms).padStart(3, '0') + ' --> 00:00:' + sec + ',' + String(ms + 100).padStart(3, '0') + '\n<font face="ATAmigo" size="72">{\\an8}' + 'abcd'[i % 4] + '</font>');
  }
  cues.push('33\n00:00:27,000 --> 00:00:30,000\n<font face="ATAmigo" size="24">THE DIALOGUE LINE</font>');
  fs.writeFileSync(path.join(TMP, 'kara.srt'), cues.join('\n\n') + '\n');
}
const withSubs = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=640x360:rate=25:duration=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
  '-i', path.join(TMP, 'line.srt'),
  '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-c:s', 'srt',
  '-map', '0:v', '-map', '1:a', '-map', '2:s',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Full Subtitles',
  path.join(TMP, 'media', 'subs.mkv')
], { encoding: 'utf8' });
if (withSubs.status !== 0) { console.error('could not build the subtitled file:', withSubs.stderr); process.exit(1); }
// A file whose subtitles are a song written in karaoke timing, and the dialogue
// after it.
const withKara = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=640x360:rate=25:duration=35',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=35',
  '-i', path.join(TMP, 'kara.srt'),
  '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-c:s', 'srt',
  '-map', '0:v', '-map', '1:a', '-map', '2:s',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Full Subtitles',
  path.join(TMP, 'media', 'kara.mkv')
], { encoding: 'utf8' });
if (withKara.status !== 0) { console.error('could not build the karaoke file:', withKara.stderr); process.exit(1); }
// A file nobody is converting, for the queue gate: while a pipe serves a file,
// the pre-convert must not chew the same mount on it.
fs.copyFileSync(path.join(TMP, 'media', 'show.mkv'), path.join(TMP, 'media', 'show3.mkv'));
// The same again, but for a file nobody has published: its cues are not in the
// cache, so the pipe has to get them out of the file itself.
fs.copyFileSync(path.join(TMP, 'media', 'subs.mkv'), path.join(TMP, 'media', 'cold.mkv'));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const SRC = '/content/show.mkv';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The stream, as a file on disk.
function fetchStream(ms, out, src, seek) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/stream/live?src=' + encodeURIComponent(src || SRC) + '&seek=' + (seek || 0) }, (res) => {
      const fd = fs.openSync(out, 'w');
      res.on('data', (d) => fs.writeSync(fd, d));
      const stop = setTimeout(() => { try { req.destroy(); } catch (e) {} }, ms);
      res.on('close', () => { clearTimeout(stop); try { fs.closeSync(fd); } catch (e) {} resolve(); });
    });
    req.on('error', () => resolve());
  });
}

// The chain of boxes at the top of the file. A valid fragmented MP4 is
// ftyp, moov, and then moof/mdat pairs.
function topBoxes(buf) {
  const out = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > buf.length) { out.push('BROKEN:' + type); break; }
    out.push(type);
    p += size;
  }
  return out;
}
// The bright pixels in a horizontal band of the clip (fractions of the height)
// — the clip is black, so anything bright is text the encoder burnt in.
function bandPixels(file, y0, y1) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', 'crop=w=iw:h=' + (y1 - y0) + '*ih:x=0:y=' + y0 + '*ih', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 26 }).stdout || Buffer.alloc(0);
  let n = 0;
  for (const b of out) if (b > 220) n++;
  return n;
}
const brightPixels = (file) => bandPixels(file, 0.75, 1);
// The pre-convert of one file, if any: the queue's ffmpeg (veryfast, writing a
// file) as opposed to the live pipe's (ultrafast, writing pipe:1).
function tcWorkCount(file) {
  try {
    return Number(spawnSync('sh', ['-c', `ps -eo args | grep '[f]fmpeg' | grep ' ${file}' | grep -c veryfast || true`], { encoding: 'utf8' }).stdout.trim()) || 0;
  } catch (e) { return -1; }
}
// The encoders the server has running for one file — one per live pipe.
function ffmpegCount(marker) {
  try {
    const cmd = marker
      ? `ps -eo pid,ppid,args | grep '[f]fmpeg' | grep ' ${server.pid} ' | grep -c '${marker}' || true`
      : `ps -eo pid,ppid,args | grep '[f]fmpeg' | grep ' ${server.pid} ' | wc -l`;
    return Number(spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).stdout.trim()) || 0;
  } catch (e) { return -1; }
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const ok = await new Promise(res => http.get({ host: '127.0.0.1', port: PORT, path: '/api/health' }, r => { r.resume(); r.on('end', () => res(r.statusCode === 200)); }).on('error', () => res(false)));
      if (ok) break;
    } catch (e) {}
    await sleep(250);
  }

  // --- the viewer who starts the pipe ---
  await fetchStream(9000, path.join(TMP, 'first.mp4'));
  const first = fs.readFileSync(path.join(TMP, 'first.mp4'));
  const firstBoxes = topBoxes(first);
  console.log('first viewer boxes:', firstBoxes.join(' '));
  assert.ok(first.length > 20000, 'the first viewer got a real stream, ' + first.length + ' bytes');
  assert.equal(firstBoxes[0], 'ftyp', 'the stream starts with ftyp, got ' + firstBoxes[0]);
  assert.equal(firstBoxes[1], 'moov', 'then moov, got ' + firstBoxes[1]);
  assert.ok(!firstBoxes.some(b => b.startsWith('BROKEN')), 'the box chain is not cut short: ' + firstBoxes.join(' '));

  // --- the viewer who joins it a second later ---
  await fetchStream(9000, path.join(TMP, 'late.mp4'));
  const late = fs.readFileSync(path.join(TMP, 'late.mp4'));
  const lateBoxes = topBoxes(late);
  console.log('late joiner boxes:', lateBoxes.join(' '));
  assert.ok(late.length > 20000, 'the late joiner got a real stream, ' + late.length + ' bytes');
  assert.equal(lateBoxes[0], 'ftyp', 'the late joiner starts with ftyp, got ' + lateBoxes[0]);
  assert.equal(lateBoxes[1], 'moov', 'then moov, got ' + lateBoxes[1]);
  assert.ok(!lateBoxes.some(b => b.startsWith('BROKEN')), 'the late joiner box chain is whole: ' + lateBoxes.join(' '));

  // and both of them actually decode
  for (const [name, file] of [['first', 'first.mp4'], ['late', 'late.mp4']]) {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(TMP, file)], { encoding: 'utf8' });
    console.log(name, 'viewer decodes:', (probe.stdout || '').trim() || 'NOTHING');
    assert.ok(parseFloat(probe.stdout) > 0.5, "the " + name + " viewer's stream decodes, got: " + (probe.stderr || probe.stdout));
  }

  // --- one channel, one encode ---
  // Two viewers arriving at the same moment, on a file with no pipe yet: the
  // pipe takes a moment to start, and both of them want it.
  const before = ffmpegCount('show2.mkv');
  await Promise.all([
    fetchStream(6000, path.join(TMP, 'a.mp4'), '/content/show2.mkv'),
    fetchStream(6000, path.join(TMP, 'b.mp4'), '/content/show2.mkv')
  ]);
  const during = ffmpegCount('show2.mkv');
  console.log('encoders for the file: before', before, 'during two viewers', during);
  assert.equal(during, 1, 'two viewers of one channel share one encode, ' + during + ' encoders appeared');

  // --- the hard subtitles: burnt into the picture, and burnt at the right moment ---
  const post = async (p, body) => (await (await fetch('http://127.0.0.1:' + PORT + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  })).json());
  await post('/api/admin/settings', { subtitleMode: 'hard' });
  const made = await post('/api/admin/channels', { name: 'TEST' });
  const cid = (made.channel || made).id;
  await post('/api/admin/publish', { channel: cid, items: [{ title: 'x', src: '/content/subs.mkv', duration: 30 }], startIndex: 0 });
  // the cues are pulled out of the file by the pre-convert
  const srtDir = path.join(TMP, 'data', 'subs', 'hard');
  let srt = null;
  for (let i = 0; i < 120; i++) {
    const f = fs.existsSync(srtDir) ? fs.readdirSync(srtDir).filter(n => n.endsWith('.srt')) : [];
    if (f.length) { srt = path.join(srtDir, f[0]); break; }
    await sleep(500);
  }
  assert.ok(srt, 'the cues came out of the file');
  // the pipe starts a second before the line is said
  await fetchStream(6000, path.join(TMP, 'hard.mp4'), '/content/subs.mkv', 21);
  const bright = brightPixels(path.join(TMP, 'hard.mp4'));
  console.log('bright pixels in the live picture:', bright);
  assert.ok(bright > 50, 'the subtitle is burnt into the live picture, ' + bright + ' bright pixels');

  // --- and the same for a file whose cues are not in the cache yet: the pipe
  // has to get them out of the file itself ---
  await fetchStream(6000, path.join(TMP, 'cold.mp4'), '/content/cold.mkv', 21);
  const coldBright = brightPixels(path.join(TMP, 'cold.mp4'));
  console.log('bright pixels with no cues cached:', coldBright);
  assert.ok(coldBright > 50, 'the subtitle is burnt in even when the cues had to be fetched, ' + coldBright + ' bright pixels');

  // --- the song written in karaoke timing: dropped, and the dialogue kept ---
  const made2 = await post('/api/admin/channels', { name: 'TEST2' });
  const cid2 = (made2.channel || made2).id;
  await post('/api/admin/publish', { channel: cid2, items: [{ title: 'x', src: '/content/kara.mkv', duration: 35 }], startIndex: 0 });
  const karaSrtDir = path.join(TMP, 'data', 'subs', 'hard');
  let karaSrt = null;
  for (let i = 0; i < 120; i++) {
    const f = fs.existsSync(karaSrtDir) ? fs.readdirSync(karaSrtDir).filter((n) => n.endsWith('.srt')) : [];
    // The cleaned file keeps the dialogue line and none of the karaoke letters.
    if (f.some((n) => {
      const t = fs.readFileSync(path.join(karaSrtDir, n), 'utf8');
      return t.includes('THE DIALOGUE LINE') && !t.includes('an8');
    })) { karaSrt = true; break; }
    await sleep(500);
  }
  assert.ok(karaSrt, 'the cues came out of the file with the karaoke dropped and the dialogue kept');
  // The pipe covers file time 21-30s: the song (22-26s) and the dialogue (27-30s).
  await fetchStream(9000, path.join(TMP, 'kara.mp4'), '/content/kara.mkv', 21);
  const karaBottom = brightPixels(path.join(TMP, 'kara.mp4'));
  const karaMiddle = bandPixels(path.join(TMP, 'kara.mp4'), 0.15, 0.85);
  console.log('karaoke file — bottom band:', karaBottom, 'middle band:', karaMiddle);
  assert.ok(karaBottom > 50, 'the dialogue line is burnt in at the bottom, ' + karaBottom + ' bright pixels');
  assert.equal(karaMiddle, 0, 'the karaoke letters are not stacked down the middle of the picture, ' + karaMiddle + ' bright pixels in the middle band');

  // --- the queue gate: while the pipe serves a file, no pre-convert of it ---
  await fetchStream(9000, path.join(TMP, 'gate.mp4'), '/content/show3.mkv');
  const tcCount = tcWorkCount('show3.mkv');
  console.log('pre-converts of the file while the pipe served it:', tcCount);
  assert.equal(tcCount, 0, 'the pre-convert queue does not chew the same file while the pipe serves it');

  server.kill();
  console.log('pipe: all tests passed');
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
