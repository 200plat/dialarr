// The languages: which audio track plays, which subtitles are used, and whether
// the subtitles are burnt into the picture or sent beside it.
// Runs a throwaway server against a temp media root.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-langs-'));
const PORT = 3399 + (process.pid % 400);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

// A black clip with two languages of audio and two of subtitles. Black, so that
// any bright pixel in a frame is a subtitle the encoder drew.
fs.writeFileSync(path.join(TMP, 's1.srt'), '1\n00:00:00,000 --> 00:00:02,000\nhello english\n');
fs.writeFileSync(path.join(TMP, 's2.srt'), '1\n00:00:01,000 --> 00:00:03,000\nbonjour\n');
const made = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:rate=10:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
  '-i', path.join(TMP, 's1.srt'), '-i', path.join(TMP, 's2.srt'),
  '-filter_complex', '[1:a]aformat=channel_layouts=mono[a1];[2:a]aformat=channel_layouts=stereo[a2]',
  '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'srt',
  '-map', '0:v', '-map', '[a1]', '-map', '[a2]', '-map', '3:s', '-map', '4:s',
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre',
  path.join(TMP, 'media', 'base.mkv')
], { encoding: 'utf8' });
if (made.status !== 0) { console.error('could not build the test file:', made.stderr); process.exit(1); }
// Two copies of it, so each stream is its own pipe and no finished one is reused.
fs.copyFileSync(path.join(TMP, 'media', 'base.mkv'), path.join(TMP, 'media', 'soft.mkv'));
fs.copyFileSync(path.join(TMP, 'media', 'base.mkv'), path.join(TMP, 'media', 'hard.mkv'));

// The shape an anime release has: Spanish first (twice), English third,
// Japanese last. ffmpeg's own pick on a file like this is the Spanish one,
// which is how a viewer ends up watching an anime in Spanish.
const anime = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:rate=10:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=550:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
  '-c:v', 'libx264', '-c:a', 'aac',
  '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:a',
  '-metadata:s:a:0', 'language=spa', '-metadata:s:a:0', 'title=AC-3 2.0 [Selecta Visión]',
  '-metadata:s:a:1', 'language=spa', '-metadata:s:a:1', 'title=MP3 2.0 [Animax]',
  '-metadata:s:a:2', 'language=eng', '-metadata:s:a:2', 'title=AC-3 2.0 [DVD]',
  '-metadata:s:a:3', 'language=jpn', '-metadata:s:a:3', 'title=FLAC 5.1 [BD]',
  path.join(TMP, 'media', 'anime.mkv')
], { encoding: 'utf8' });
if (anime.status !== 0) { console.error('could not build the anime file:', anime.stderr); process.exit(1); }

// The shape a commentary release has: the programme first with no language
// tag at all, and a commentary track behind it tagged as English.
const comm = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:rate=10:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
  '-c:v', 'libx264', '-c:a', 'aac',
  '-map', '0:v', '-map', '1:a', '-map', '2:a',
  '-metadata:s:a:0', 'title=DTS-HD MA 5.1',
  '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Commentary by somebody famous',
  path.join(TMP, 'media', 'comm.mkv')
], { encoding: 'utf8' });
if (comm.status !== 0) { console.error('could not build the commentary file:', comm.stderr); process.exit(1); }

// The shape a dubbed anime has: the French dub first and the Japanese
// original behind it, with no English at all.
const orig = spawnSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:rate=10:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
  '-c:v', 'libx264', '-c:a', 'aac',
  '-map', '0:v', '-map', '1:a', '-map', '2:a',
  '-ac:a', '2', '-metadata:s:a:0', 'language=fre', '-metadata:s:a:0', 'title=VFi - LPCM 2.0',
  '-ac:a', '6', '-metadata:s:a:1', 'language=jpn', '-metadata:s:a:1', 'title=VO - DTS-HD MA 5.1',
  path.join(TMP, 'media', 'orig.mkv')
], { encoding: 'utf8' });
if (orig.status !== 0) { console.error('could not build the dubbed file:', orig.stderr); process.exit(1); }

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const SOFT = '/content/soft.mkv';
const HARD = '/content/hard.mkv';
const ANIME = '/content/anime.mkv';
const COMM = '/content/comm.mkv';
const ORIG = '/content/orig.mkv';
const jget = async (p) => (await (await fetch(BASE + p)).json());
const post = async (p, body) => (await (await fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
})).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bright pixels along the bottom of the clip — the subtitle the encoder
// burnt in, if there is one.
function brightPixels(file) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', 'crop=w=iw:h=ih/4:x=0:y=ih*3/4', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 26 }).stdout || Buffer.alloc(0);
  let n = 0;
  for (const b of out) if (b > 220) n++;
  return n;
}
// The command lines of the encoders that are running right now.
function ffmpegArgs() {
  try { return spawnSync('sh', ['-c', "ps -eo args | grep '[f]fmpeg' || true"], { encoding: 'utf8' }).stdout || ''; }
  catch (e) { return ''; }
}
// The stream, as a file on disk.
async function streamTo(src, file) {
  const r = await fetch(BASE + '/stream/live?src=' + encodeURIComponent(src) + '&seek=0');
  assert.equal(r.status, 200, 'the live stream of ' + src);
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.length > 5000, 'it streamed real video, got ' + body.length + ' bytes');
  fs.writeFileSync(file, body);
  return file;
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // --- out of the box: English audio, English subtitles, soft ---
  let t = await jget('/api/tracks?src=' + encodeURIComponent(SOFT));
  assert.equal(t.audio[0].lang, 'eng');
  assert.equal(t.audio[1].lang, 'jpn');
  assert.equal(t.subs[1].lang, 'fre');
  assert.equal(t.mode, 'soft', 'the subtitles ride beside the picture by default');
  assert.equal(t.defaultSub, 0, 'English is the default subtitle, got ' + t.defaultSub);

  // --- the language settings move the picks ---
  await post('/api/admin/settings', { audioLanguage: 'jpn', subtitleLanguage: 'fre' });
  t = await jget('/api/tracks?src=' + encodeURIComponent(SOFT));
  assert.equal(t.defaultSub, 1, 'the French subtitle is the default now, got ' + t.defaultSub);
  assert.equal(t.audioLanguage, 'jpn');
  assert.equal(t.subtitleLanguage, 'fre');

  // --- and the stream carries that audio, with no subtitle in the picture ---
  const softFile = await streamTo(SOFT, path.join(TMP, 'soft.mp4'));
  const probed = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,channels', '-of', 'json', softFile], { encoding: 'utf8' }).stdout);
  const audio = (probed.streams || []).find((s) => s.codec_type === 'audio');
  assert.equal(audio.channels, 2, 'the stereo (Japanese) track is the one playing, got ' + audio.channels + ' channels');
  assert.equal(brightPixels(softFile), 0, 'a soft subtitle is not in the picture');

  // --- hard subtitles: the encoder draws them in ---
  await post('/api/admin/settings', { subtitleMode: 'hard' });
  t = await jget('/api/tracks?src=' + encodeURIComponent(HARD));
  assert.equal(t.mode, 'hard', 'the setting is reported to the viewer');
  // The cues are a whole-file read, so the live pipe does not wait for them —
  // it plays the picture and the burn comes with the cached file.
  const live = await streamTo(HARD, path.join(TMP, 'hard.mp4'));
  assert.ok(fs.existsSync(live), 'the live stream still plays in hard mode');
  // The cached file is the one with the subtitles in the picture.
  const made3 = await post('/api/admin/channels', { name: 'BURNS' });
  const cid3 = (made3.channel || made3).id;
  await post('/api/admin/publish', { channel: cid3, items: [{ title: 'A', src: HARD, duration: 4 }], startIndex: 0 });
  let st = null;
  for (let i = 0; i < 160; i++) {
    const s = await jget('/api/transcode/status?src=' + encodeURIComponent(HARD));
    if (s.status === 'ready') { st = s; break; }
    await sleep(500);
  }
  assert.ok(st, 'the file was converted for the channel');
  const cached = path.join(TMP, 'data', 'transcodes', st.out);
  assert.ok(fs.existsSync(cached), 'the cached file is there');
  assert.ok(brightPixels(cached) > 100, 'the subtitle is burnt into the cached picture');
  // and now the cues are on disk, so the live pipe burns them in too
  const pending = fetch(BASE + '/stream/live?src=' + encodeURIComponent(HARD) + '&seek=0');
  await sleep(2500);
  assert.ok(/subtitles=/.test(ffmpegArgs()), 'the live encoder burns the subtitles in as well, the command was: ' + ffmpegArgs().slice(0, 400));
  await pending;

  // --- a channel can do the opposite of the setting ---
  const made2 = await post('/api/admin/channels', { name: 'ANIME', emoji: '📼', subtitleMode: 'soft' });
  const id = (made2.channel || made2).id;
  assert.ok(id, 'the channel was made');
  await post('/api/admin/channel/shows/add', { channel: id, name: 'Test', episodes: [{ title: 'x', src: HARD, duration: 4 }] });
  t = await jget('/api/tracks?src=' + encodeURIComponent(HARD));
  assert.equal(t.mode, 'soft', 'the channel does the opposite of the site setting, got ' + t.mode);

  // --- a file nobody has probed yet still plays in English ---
  // The bug: the stream was served without knowing what was in the file, and
  // ffmpeg's own pick on an anime like this is the Spanish track.
  await post('/api/admin/settings', { audioLanguage: 'eng', subtitleLanguage: 'eng', subtitleMode: 'soft' });
  const animeFile = await streamTo(ANIME, path.join(TMP, 'anime.mp4'));
  const animeProbe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:stream_tags=language', '-of', 'json', animeFile], { encoding: 'utf8' }).stdout);
  const animeAudio = (animeProbe.streams || []).find((s) => s.codec_type === 'audio');
  assert.equal((animeAudio.tags || {}).language, 'eng', 'the anime plays in English, not in Spanish');
  const animeTracks = await jget('/api/tracks?src=' + encodeURIComponent(ANIME));
  assert.equal(animeTracks.audioOrd, 2, 'the English track is the third one, got ' + animeTracks.audioOrd);
  assert.equal(animeTracks.audioLabel, 'AC-3 2.0 [DVD]', 'and it is the DVD one, got ' + animeTracks.audioLabel);

  // --- a commentary track is not the programme ---
  const commTracks = await jget('/api/tracks?src=' + encodeURIComponent(COMM));
  assert.equal(commTracks.audioOrd, 0, 'the programme is played, not the commentary, got ' + commTracks.audioOrd);

  // --- a file with no English at all ---
  // A dubbed anime: the French dub and the Japanese original, and nothing else.
  // English was asked for, so the original mix is what plays — not the dub.
  await post('/api/admin/settings', { audioLanguage: 'eng', audioFallback: '' });
  let origTracks = await jget('/api/tracks?src=' + encodeURIComponent(ORIG));
  assert.equal(origTracks.audio.length, 2, 'the file has two audio tracks');
  assert.equal(origTracks.audioOrd, 1, 'the original mix plays, not the French dub, got ' + origTracks.audioOrd);
  assert.equal(origTracks.audioLabel, 'VO - DTS-HD MA 5.1', 'and it is the Japanese one, got ' + origTracks.audioLabel);

  // --- and the alternate language is used when it is set ---
  await post('/api/admin/settings', { audioFallback: 'fre' });
  origTracks = await jget('/api/tracks?src=' + encodeURIComponent(ORIG));
  assert.equal(origTracks.audioOrd, 0, 'the alternate language is used when there is no English, got ' + origTracks.audioOrd);
  assert.equal(origTracks.audioLabel, 'VFi - LPCM 2.0', 'and it is the French one, got ' + origTracks.audioLabel);
  await post('/api/admin/settings', { audioFallback: '' });

  server.kill();
  console.log('langs: all tests passed');
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
