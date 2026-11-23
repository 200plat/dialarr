// Audio tracks and subtitles: the server has to find the languages in a file,
// hand the subtitles over as WebVTT timed to where the player is, and pick the
// audio track the viewer asked for.
// Runs a throwaway server against a temp media root.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-tracks-'));
const PORT = 3299 + (process.pid % 400);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

// A clip with two languages of audio and two of subtitles. The English track is
// mono and the other one is stereo, so the channels of the streamed audio say
// which track was picked — and stereo is what ffmpeg picks on its own, so
// the test only passes if the English track was mapped deliberately.
fs.writeFileSync(path.join(TMP, 's1.srt'), '1\n00:00:00,000 --> 00:00:02,000\nhello english\n');
fs.writeFileSync(path.join(TMP, 's2.srt'), '1\n00:00:01,000 --> 00:00:03,000\nbonjour\n');
const made = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
  '-i', path.join(TMP, 's1.srt'), '-i', path.join(TMP, 's2.srt'),
  '-filter_complex', '[1:a]aformat=channel_layouts=mono[a1];[2:a]aformat=channel_layouts=stereo[a2]',
  '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'srt',
  '-map', '0:v', '-map', '[a1]', '-map', '[a2]', '-map', '3:s', '-map', '4:s',
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre',
  path.join(TMP, 'media', 'two.mkv')
], { encoding: 'utf8' });
if (made.status !== 0) { console.error('could not build the test file:', made.stderr); process.exit(1); }

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const SRC = '/content/two.mkv';
const jget = async (p) => (await (await fetch(BASE + p)).json());
// The sidecar is extracted in the background (reading the cues means reading the
// whole file), so the first ask comes back empty and the next one has it.
async function vttWait(src, ord, seek) {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(BASE + '/api/tracks/vtt?src=' + encodeURIComponent(src) + '&i=' + ord + '&seek=' + (seek || 0));
    if (r.status === 200) return await r.text();
    await new Promise(res => setTimeout(res, 500));
  }
  return '';
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // --- the languages in the file are found and named ---
  const t = await jget('/api/tracks?src=' + encodeURIComponent(SRC));
  assert.equal(t.audio.length, 2, 'two audio tracks, got ' + JSON.stringify(t.audio));
  assert.equal(t.subs.length, 2, 'two subtitle tracks, got ' + JSON.stringify(t.subs));
  assert.equal(t.audio[0].lang, 'eng');
  assert.equal(t.audio[1].lang, 'jpn');
  assert.equal(t.audio[0].label, 'English');
  assert.equal(t.audio[1].label, 'Japanese');
  assert.equal(t.subs[1].label, 'French');
  assert.equal(t.defaultAudio, 0, 'English is the default audio, got ' + t.defaultAudio);

  // --- the probe is cached, so the second ask is the same and cheap ---
  const again = await jget('/api/tracks?src=' + encodeURIComponent(SRC));
  assert.deepEqual(again, t, 'the cached probe is the same');

  // --- subtitles come out as WebVTT ---
  const vtt = await vttWait(SRC, 0, 0);
  assert.ok(vtt.startsWith('WEBVTT'), 'the sidecar is WebVTT, got ' + JSON.stringify(vtt.slice(0, 20)));
  assert.ok(vtt.includes('hello english'), 'the cue text is in there');
  assert.ok(/00:00\.000\s+-->\s+00:02\.000/.test(vtt), 'the cue keeps its timing, got ' + JSON.stringify(vtt));

  // --- and are moved back to where the player is ---
  const shifted = await vttWait(SRC, 0, 1);
  assert.ok(/00:00\.000\s+-->\s+00:01\.000/.test(shifted), 'the cue moves back by the seek, got ' + JSON.stringify(shifted));
  const past = await vttWait(SRC, 0, 5);
  assert.ok(!/-->/.test(past), 'a cue that is already past is dropped, got ' + JSON.stringify(past));

  // --- the stream carries the English track, not the other one ---
  // (the tracks are cached now, so the server knows which one to map)
  const r = await fetch(BASE + '/stream/live?src=' + encodeURIComponent(SRC) + '&seek=0');
  assert.equal(r.status, 200, 'the live stream');
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.length > 10000, 'it streamed real video, got ' + body.length + ' bytes');
  const streamFile = path.join(TMP, 'streamed.mp4');
  fs.writeFileSync(streamFile, body);
  const probed = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,channels', '-of', 'json', streamFile], { encoding: 'utf8' }).stdout);
  const audio = (probed.streams || []).find((s) => s.codec_type === 'audio');
  assert.ok(audio, 'the stream has audio');
  assert.equal(audio.channels, 1, 'the mono (English) track is the one playing, got ' + audio.channels + ' channels');
  assert.ok((probed.streams || []).some((s) => s.codec_type === 'video'), 'the stream still has video');

  // --- a src cannot climb out of the library ---
  const out = await jget('/api/tracks?src=' + encodeURIComponent('/content/../../etc/passwd'));
  assert.equal(out.audio.length, 0, 'nothing outside the library is probed');
  assert.equal(out.subs.length, 0);

  server.kill();
  console.log('tracks: all tests passed');
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
