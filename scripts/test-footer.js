// The four boxes at the bottom of the TV page are editable in the admin console.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dialarr-footer-'));
const PORT = 3099 + (process.pid % 300);

fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'server.js'), path.join(TMP, 'server.js'));
fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TMP, 'node_modules'));
fs.writeFileSync(path.join(TMP, 'data', 'lineup.json'), JSON.stringify({ channels: [], settings: {}, users: [], bumps: [] }));

const server = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', d => process.stderr.write(d));

const BASE = 'http://127.0.0.1:' + PORT;
const jget = async (p) => (await (await fetch(BASE + p)).json());
const post = async (p, body) => (await (await fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
})).json());

(async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await jget('/api/health')).status === 'ok') break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  // --- the built-in four are there to start with ---
  const s0 = await jget('/api/settings');
  assert.ok(Array.isArray(s0.infoBoxes) && s0.infoBoxes.length === 4, 'four boxes by default');
  assert.ok(s0.infoBoxes[0].body.includes('{{site}}'), 'the site name is a placeholder');

  // --- they can be replaced with anything ---
  const saved = await post('/api/admin/settings', { infoBoxes: [
    { title: 'who we are', body: 'Google Gooble Dooble.' },
    { title: 'nothing else', body: 'see you at the usual time.' }
  ] });
  assert.equal(saved.settings.infoBoxes.length, 2);
  assert.equal(saved.settings.infoBoxes[0].body, 'Google Gooble Dooble.');
  const s1 = await jget('/api/settings');
  assert.equal(s1.infoBoxes[0].title, 'who we are');
  assert.equal(s1.infoBoxes[1].body, 'see you at the usual time.');

  // --- and put back ---
  const back = await post('/api/admin/settings', { infoBoxes: 'default' });
  assert.equal(back.settings.infoBoxes.length, 4, 'the built-in four come back');
  assert.equal(back.settings.infoBoxes[0].title, 'who we are');

  // --- the other settings survive a save ---
  const both = await post('/api/admin/settings', { siteName: 'DIALARR', infoBoxes: [{ title: 'one', body: 'two' }] });
  assert.equal(both.settings.siteName, 'DIALARR');
  assert.equal(both.settings.infoBoxes.length, 1);

  server.kill();
  console.log('footer: all tests passed');
  process.exit(0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
