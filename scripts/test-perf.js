// The pages were slow because every request re-parsed a 1MB lineup, every page pulled
// ~1MB of uncompressed JSON, and the library walk froze the server. These are the
// checks that keep that fixed:
//  - the viewer gets a small lineup, the admin still gets the full one
//  - text responses are compressed, video is not
//  - the cached lineup is never edited by a read route (a lost "users" key wipes
//    every account the next time anything is saved)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-perf-'));
const PORT = 3899 + (process.pid % 400);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.copyFileSync(path.join(REPO, 'media', 'test.mp4'), path.join(TMP, 'media', 'clip.mp4'));

// a lineup with a hidden channel and a user account — both used to be lost when a
// read route edited the shared lineup. The channel carries a pile of episodes, the
// way a real one does: that pile is what the viewer must not download.
const episodes = [];
for (let i = 0; i < 200; i++) episodes.push({ title: 'Episode ' + i, src: '/content/Show/Show ' + i + '.mkv', duration: 1400 + i });
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({
  channels: [
    { id: 'c1', dial: 1, emoji: '📺', name: 'Visible', versions: [{ v: 1, manifest: 'manifests/c1/v1.json', epochMs: 1, effectiveAtMs: 1, startIndex: 0 }], shows: [{ id: 's1', name: 'Show', episodes }] },
    { id: 'c2', dial: 2, emoji: '🎬', name: 'Hidden', hidden: true, versions: [], shows: [] }
  ],
  settings: { siteName: 'Dialarr' },
  users: { adam: 'salt:hash' },
  bumps: [],
  bumpMs: 2000
}));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), CONTENT_DIR: path.join(TMP, 'media'), MOVIES_DIR: path.join(TMP, 'media'), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const jget = async (p, headers) => {
  const r = await fetch(BASE + p, { headers });
  const raw = Buffer.from(await r.arrayBuffer());
  return { status: r.status, raw, json: () => JSON.parse(raw.toString('utf8')), encoding: r.headers.get('content-encoding') };
};
const jpost = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 200) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // --- the viewer gets the small lineup ---
  const slim = await jget('/broadcast/channels.json');
  const full = await jget('/broadcast/lineup.json');
  assert.equal(slim.status, 200, 'channels.json is served');
  assert.ok(slim.raw.length * 20 < full.raw.length, 'the viewer lineup is a fraction of the full one: ' + slim.raw.length + ' vs ' + full.raw.length);
  assert.deepEqual(slim.json().channels.map(c => c.id), ['c1'], 'the viewer lineup hides hidden channels');
  assert.ok(slim.json().channels[0].versions.length === 1, 'the viewer lineup keeps the versions (the guide needs them)');
  assert.ok(slim.json().bumpMs === 2000, 'the viewer lineup keeps the bump clock');
  assert.ok(!slim.raw.toString().includes('Hidden'), 'the viewer lineup carries no admin-only data');

  // --- the admin still gets the full lineup, minus the password hashes ---
  const admin = await jget('/api/admin/lineup');
  assert.equal(admin.json().channels.length, 2, 'the admin lineup still has every channel');
  assert.ok(!('users' in admin.json()), 'the admin lineup carries no password hashes');

  // --- reading must not edit the lineup that is cached and shared ---
  await jget('/broadcast/lineup.json');
  await jget('/api/lineup');
  await jget('/api/admin/lineup');
  await jpost('/api/admin/settings', { siteName: 'Dialarr' }); // this saves the lineup back to disk
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'lineup.json'), 'utf8'));
  assert.ok(onDisk.users && onDisk.users.adam, 'a read route must not cost the user accounts');
  assert.equal((onDisk.channels || []).length, 2, 'a read route must not drop channels');

  // --- text is compressed, video is not ---
  const gz = await jget('/broadcast/lineup.json', { 'accept-encoding': 'gzip' });
  assert.equal(gz.encoding, 'gzip', 'json is compressed');
  const vid = await jget('/media/clip.mp4', { 'accept-encoding': 'gzip' });
  assert.ok(!vid.encoding, 'video is not compressed, got ' + vid.encoding);

  // --- the library walk still works (it is async now) ---
  const tree = await jget('/api/media/tree');
  assert.equal(tree.status, 200, 'the media tree is served');
  assert.ok(tree.json().tree, 'the media tree has a tree');
  assert.ok(tree.json().tree.children.some(c => c.name === 'clip.mp4'), 'the media tree lists the file: ' + JSON.stringify(tree.json().tree));

  console.log('perf: all tests passed');
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
