const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3005;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const MEDIA = path.join(ROOT, 'media');
// Where the user's real TV library lives. Point CONTENT_DIR at it (e.g. /data/tv);
// defaults to media/ so the demo works out of the box.
const CONTENT_DIR = process.env.CONTENT_DIR ? path.resolve(process.env.CONTENT_DIR) : MEDIA;
// movies library (optional): sibling "Movies" of the TV root by default (e.g. /mnt/plex/Movies)
const MOVIES_DIR = process.env.MOVIES_DIR ? path.resolve(process.env.MOVIES_DIR) : path.join(path.dirname(CONTENT_DIR), 'Movies');
// src → absolute path: /content/… → TV root, /movies/… → movies root (null if not local)
function srcToAbs(src) {
  if (typeof src !== 'string') return null;
  if (src.includes('..')) return null; // never let a src climb out of the library
  if (src.startsWith('/content/')) return path.join(CONTENT_DIR, src.slice('/content/'.length));
  if (src.startsWith('/movies/')) return path.join(MOVIES_DIR, src.slice('/movies/'.length));
  return null;
}
// mkv/avi → cached, browser-playable mp4. Transcoded once, served to every viewer.
const TRANSCODE_DIR = path.join(DATA, 'transcodes');
const TRANSCODE_STORE = path.join(DATA, 'transcodes.json');
const TRANSCODE_SRC = /\.(mkv|avi|mov|flv|wmv|mpg|mpeg|ts)$/i; // browsers can't play these

// First run: no data/ yet — seed it from sample/ so a fresh clone has a working
// channel. This happens before the backup schedule below, so the seeded lineup
// is backed up like any other.
(function seedSample() {
  const sample = path.join(ROOT, 'sample');
  try {
    if (fs.existsSync(path.join(DATA, 'lineup.json'))) return;
    fs.mkdirSync(DATA, { recursive: true });
    if (fs.existsSync(sample)) {
      fs.cpSync(sample, DATA, { recursive: true });
      console.log('seeded data/ from sample/');
    } else {
      // No sample to copy — an empty channel list is still a server that runs.
      fs.writeFileSync(path.join(DATA, 'lineup.json'), JSON.stringify({ channels: [], settings: {} }, null, 2));
      console.log('no data/ and no sample/ — started with an empty channel list');
    }
  } catch (e) { console.error('could not seed data/:', e.message); }
})();

// Everything the browser downloads is text: a 1MB lineup, 130KB manifests, 200KB of
// javascript. Compressing it cuts the page to ~10% of its size. Video is left alone —
// the filter only lets text-ish content types through.
const compression = require('compression');
app.use(compression({
  filter: (req, res) => /^(text\/|application\/(json|javascript|xml))/i.test(String(res.getHeader('Content-Type') || ''))
}));

app.use(express.json({ limit: '50mb' })); // import can carry the whole manifest set

// --- basic auth: admin password from env + optional site password from settings ---
const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_MS = 12 * 3600 * 1000;
const adminTokens = new Map(); // token -> expiry ms
const siteTokens = new Map();
function newToken(store) { const t = crypto.randomBytes(24).toString('hex'); store.set(t, Date.now() + SESSION_MS); return t; }
function liveToken(store, t) {
  const exp = store.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { store.delete(t); return false; }
  return true;
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').split(';').map((p) => p.trim()).find((p) => p.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function setCookie(res, name, token, clear) {
  res.setHeader('Set-Cookie', name + '=' + (clear ? '' : token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (clear ? '0' : Math.floor(SESSION_MS / 1000)));
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored || typeof pw !== 'string' || !pw) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return test.length === want.length && crypto.timingSafeEqual(test, want);
}
function siteGated() { return !!(loadLineup().settings || {}).sitePasswordHash; }
const GATE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>password required</title>
<style>body{background:#1C0A57;color:#f5f0ff;font-family:"Courier New",monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
form{background:#12063a;border:3px solid #ff6f00;padding:2rem;width:min(90vw,380px);text-align:center}
h1{font-size:1rem;letter-spacing:.2em;color:#ffff00;margin:0 0 1rem}
input{width:100%;box-sizing:border-box;background:#000;color:#f5f0ff;border:1px solid #ff6f00;padding:.5rem;font-family:inherit}
button{margin-top:.8rem;width:100%;background:#12063a;color:#f5f0ff;border:2px solid #ff6f00;padding:.5rem;font-family:inherit;cursor:pointer}
button:hover{background:#ff6f00;color:#000}
.err{color:#ff7f7f;font-size:.8rem;min-height:1.2em;margin-top:.6rem}</style></head>
<body><form><h1>🔒 PASSWORD REQUIRED</h1><input id="pw" type="password" placeholder="site password" autocomplete="current-password"><button>unlock</button><div class="err" id="err"></div>
<script>var f=document.querySelector('form');f.onsubmit=function(e){e.preventDefault();fetch('/api/site/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})}).then(function(r){if(r.ok){location.reload();return;}return r.json().then(function(j){document.getElementById('err').textContent=j.error||'wrong password';});}).catch(function(){document.getElementById('err').textContent='offline';});};document.getElementById('pw').focus();</script></form></body></html>`;
function siteGate(req, res, next) {
  // The admin console has its OWN password gate (ADMIN_PASSWORD), so it's exempt from the
  // viewer-facing site password — otherwise you'd have to pass the site password before
  // you could even reach the admin password, and the two blur together. Its stylesheet
  // has to come through too, or the console arrives unstyled.
  const isAdmin = req.path === '/admin.html' || req.path === '/admin.htm' || req.path.startsWith('/api/admin/');
  if (req.path === '/api/site/login' || req.path === '/api/health' || req.path === '/style.css' || isAdmin) return next();
  if (!siteGated()) return next();
  if (liveToken(siteTokens, cookie(req, 'site'))) return next();
  if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) return res.type('html').send(GATE_HTML);
  res.status(401).json({ error: 'site password required' });
}
app.use(siteGate);
// the console used to live at /admin.htm while it was being built; the old URL still works
app.get('/admin.htm', (req, res) => res.redirect(301, '/admin.html'));
app.use(express.static(path.join(ROOT, 'public')));
// The lineup is cached and shared, so a route that filters it must copy it first —
// editing it in place would drop hidden channels and user hashes for everybody.
function publicLineup() {
  const raw = loadLineup();
  const l = Object.assign({}, raw);
  l.channels = (raw.channels || []).filter((c) => !c.hidden);
  delete l.users; // the password hashes never leave the server
  return l;
}
// lineup.json without the user password hashes (the static mount would serve them)
app.get('/broadcast/lineup.json', (req, res) => { res.json(publicLineup()); });
// The viewer only draws the dial, the guide and the bump clock — the shows and their
// episodes are admin data, and they are most of the megabyte. This is the viewer-sized
// slice of the lineup.
app.get('/broadcast/channels.json', (req, res) => {
  const l = publicLineup();
  res.json({
    channels: l.channels.map((c) => ({ id: c.id, dial: c.dial, emoji: c.emoji, name: c.name, versions: c.versions || [] })),
    bumps: l.bumps || [],
    bumpMs: l.bumpMs || 0
  });
});
// Manifests are served through here, not as static files, so a manifest published
// before the duration ceiling existed still gets clamped on the way out.
app.get('/broadcast/manifests/:channel/:file', manifestRoute);
function manifestRoute(req, res) {
  const file = path.join(DATA, 'manifests', req.params.channel, req.params.file);
  if (!file.startsWith(path.join(DATA, 'manifests') + path.sep)) return res.status(400).json({ error: 'bad path' });
  // The usual v<N>.json goes through the shared mtime cache — a big manifest is 650KB
  // of JSON, and re-parsing it on every channel switch is not free.
  const vm = /^v(\d+)\.json$/.exec(req.params.file);
  const cached = vm ? loadManifest(req.params.channel, Number(vm[1])) : null;
  if (cached) return res.json(cached);
  let mv;
  try { mv = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return res.status(404).json({ error: 'not found' }); }
  for (const it of mv.items || []) it.duration = clampDuration(it.duration) || 1;
  res.json(mv);
}
app.use('/broadcast', express.static(DATA));
app.use('/media', express.static(MEDIA));
app.use('/content', express.static(CONTENT_DIR));
app.use('/movies', express.static(MOVIES_DIR));

app.get('/api/admin/state', (req, res) => res.json({ authEnabled: !!ADMIN_PASSWORD, authed: !!(ADMIN_PASSWORD && liveToken(adminTokens, cookie(req, 'admin'))) }));
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(400).json({ error: 'ADMIN_PASSWORD is not set' });
  if (String((req.body && req.body.password) || '') === ADMIN_PASSWORD) { setCookie(res, 'admin', newToken(adminTokens), false); return res.json({ ok: true }); }
  res.status(401).json({ error: 'wrong password' });
});
app.post('/api/admin/logout', (req, res) => {
  const t = cookie(req, 'admin');
  if (t) adminTokens.delete(t);
  setCookie(res, 'admin', '', true);
  res.json({ ok: true });
});
app.post('/api/site/login', (req, res) => {
  const s = loadLineup().settings || {};
  if (!s.sitePasswordHash) return res.status(400).json({ error: 'no site password is set' });
  if (checkPassword(String((req.body && req.body.password) || ''), s.sitePasswordHash)) { setCookie(res, 'site', newToken(siteTokens), false); return res.json({ ok: true }); }
  res.status(401).json({ error: 'wrong password' });
});
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  if (req.originalUrl === '/api/admin/login' || req.originalUrl === '/api/admin/state' || req.originalUrl === '/api/admin/logout') return next();
  if (liveToken(adminTokens, cookie(req, 'admin'))) return next();
  res.status(401).json({ error: 'admin password required' });
}
app.use('/api/admin', adminAuth);

// --- chat users: admin-created accounts; when settings.chatMode === 'users' only
//     signed-in users can send chat. Users live in lineup.json.users (name -> hash).
const userTokens = new Map(); // token -> { username, exp }
const USERNAME_RE = /^[a-z0-9_-]{2,20}$/i;
function userName(req) {
  const t = cookie(req, 'user');
  const u = t ? userTokens.get(t) : null;
  if (!u) return null;
  if (u.exp < Date.now()) { userTokens.delete(t); return null; }
  return u.username;
}
function newUserToken(username) {
  const t = crypto.randomBytes(24).toString('hex');
  userTokens.set(t, { username, exp: Date.now() + SESSION_MS });
  return t;
}
app.post('/api/user/login', (req, res) => {
  const l = loadLineup();
  const name = String((req.body && req.body.username) || '').trim();
  const pw = String((req.body && req.body.password) || '');
  const users = l.users || {};
  if (!name || !checkPassword(pw, users[name.toLowerCase()])) return res.status(401).json({ error: 'wrong username or password' });
  setCookie(res, 'user', newUserToken(name), false);
  res.json({ ok: true, username: name });
});
app.post('/api/user/logout', (req, res) => {
  const t = cookie(req, 'user');
  if (t) userTokens.delete(t);
  setCookie(res, 'user', '', true);
  res.json({ ok: true });
});
app.get('/api/user/me', (req, res) => {
  const name = userName(req);
  if (name) return res.json({ username: name });
  res.status(401).json({ username: null });
});
app.get('/api/admin/users', (req, res) => {
  res.json({ users: Object.keys((loadLineup().users) || {}).sort() });
});
// Names nobody may have. The list is free text — one per line, or separated by
// commas or semicolons — and * stands for any run of characters, so "fuc*"
// refuses everything from there on.
function blockedName(name) {
  const list = String(getSettings().blockedUsernames || '');
  for (const raw of list.split(/[,;\n]+/)) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    const rx = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (rx.test(String(name).toLowerCase())) return p;
  }
  return '';
}
app.post('/api/admin/users', (req, res, next) => {
  try {
    const name = String((req.body && req.body.username) || '').trim();
    const pw = String((req.body && req.body.password) || '');
    if (!USERNAME_RE.test(name)) throw Object.assign(new Error('username: 2-20 letters, numbers, - or _'), { status: 400 });
    const blocked = blockedName(name);
    if (blocked) throw Object.assign(new Error(`“${name}” is not an allowed name`), { status: 400 });
    if (pw.length < 4) throw Object.assign(new Error('password: at least 4 characters'), { status: 400 });
    const l = loadLineup();
    l.users = l.users || {};
    l.users[name.toLowerCase()] = hashPassword(pw);
    saveLineup(l);
    res.json({ ok: true, users: Object.keys(l.users).sort() });
  } catch (e) { next(e); }
});
app.post('/api/admin/users/delete', (req, res, next) => {
  try {
    const name = String((req.body && req.body.username) || '').trim().toLowerCase();
    const l = loadLineup();
    if (!l.users || !l.users[name]) throw Object.assign(new Error('no such user: ' + name), { status: 404 });
    delete l.users[name];
    saveLineup(l);
    res.json({ ok: true, users: Object.keys(l.users).sort() });
  } catch (e) { next(e); }
});

// --- backup: export / import the whole "database" (lineup + manifests) ------
// Media files (the video library) are NOT part of this; they're referenced by
// path and stay on the machine. This moves the channels, schedule, users, etc.
const manifestRoot = path.join(DATA, 'manifests');
function collectManifests() {
  const out = {};
  if (!fs.existsSync(manifestRoot)) return out;
  for (const ch of fs.readdirSync(manifestRoot)) {
    const chDir = path.join(manifestRoot, ch);
    if (!fs.statSync(chDir).isDirectory()) continue;
    for (const f of fs.readdirSync(chDir)) {
      if (!f.endsWith('.json')) continue;
      try { out[`${ch}/${f}`] = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8')); } catch (e) { /* skip unreadable */ }
    }
  }
  return out;
}
app.get('/api/admin/export', (req, res, next) => {
  try {
    res.json({
      app: 'dialarr',
      format: 1,
      exportedAt: new Date().toISOString(),
      lineup: loadLineup(),
      manifests: collectManifests()
    });
  } catch (e) { next(e); }
});
app.post('/api/admin/import', (req, res, next) => {
  try {
    const body = req.body || {};
    const l = body.lineup;
    if (!l || !Array.isArray(l.channels)) throw Object.assign(new Error('not a valid dialarr backup (missing lineup.channels)'), { status: 400 });
    backupData('pre-import'); // snapshot the current state so a bad import is always recoverable
    // save lineup (channels, bumps, settings, users all come along)
    l.channels = l.channels.map((c) => ({ ...c }));
    saveLineup(l);
    // write manifests
    let manifestCount = 0;
    const manifests = body.manifests || {};
    for (const key of Object.keys(manifests)) {
      const [ch, file] = key.split('/');
      if (!ch || !file || ch.includes('..') || file.includes('..')) continue;
      const dir = path.join(manifestRoot, ch);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), JSON.stringify(manifests[key], null, 2));
      manifestCount++;
    }
    io.emit('lineup:update', { imported: true });
    res.json({ ok: true, channels: l.channels.length, manifestCount });
  } catch (e) { next(e); }
});

// --- backups: snapshot data/ (lineup + manifests + small indexes, NOT the transcode
// video cache) into data/backups/<stamp>-<tag>/, keep ~7 days, so an update or a bad
// import can never take out a site's library.
const BACKUP_DIR = path.join(DATA, 'backups');
function backupData(tag) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(BACKUP_DIR, stamp + '-' + tag);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(DATA, 'lineup.json'), path.join(dir, 'lineup.json'));
    const mf = path.join(DATA, 'manifests');
    if (fs.existsSync(mf)) fs.cpSync(mf, path.join(dir, 'manifests'), { recursive: true });
    for (const f of ['transcodes.json', 'durations.json']) {
      const s = path.join(DATA, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, f));
    }
    const cutoff = Date.now() - 7 * 86400000;
    for (const d of fs.readdirSync(BACKUP_DIR)) {
      try { if (fs.statSync(path.join(BACKUP_DIR, d)).mtimeMs < cutoff) fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true }); } catch (e) { /* keep it */ }
    }
    return { ok: true, at: dir, tag };
  } catch (e) { return { ok: false, tag, err: e.message }; }
}
(function scheduleDailyBackup() {
  const runIfStale = () => {
    try {
      const dirs = fs.readdirSync(BACKUP_DIR).filter((d) => d.endsWith('-daily')).sort();
      if (dirs.length && fs.statSync(path.join(BACKUP_DIR, dirs[dirs.length - 1])).mtimeMs > Date.now() - 20 * 3600000) return;
    } catch (e) { /* first run — no backups dir yet */ }
    const r = backupData('daily');
    if (!r.ok) console.error('daily backup failed:', r.err);
  };
  runIfStale();
  setInterval(runIfStale, 6 * 3600000);
})();
app.post('/api/admin/backup', (req, res, next) => {
  try { res.json(backupData('manual')); } catch (e) { next(e); }
});

// --- lineup helpers -------------------------------------------------------
const lineupPath = path.join(DATA, 'lineup.json');
// The lineup is ~1MB of JSON and it is read on every single request (the site gate
// checks the site password), so re-parsing it each time blocked the event loop for
// milliseconds per request. Cache it and re-read only when the file changes.
let lineupCache = null; // { mtime, data }
function loadLineup() {
  let mtime = 0;
  try { mtime = fs.statSync(lineupPath).mtimeMs; } catch (e) { mtime = 0; }
  if (lineupCache && lineupCache.mtime === mtime) return lineupCache.data;
  let data;
  try { data = JSON.parse(fs.readFileSync(lineupPath, 'utf8')); }
  catch (e) {
    // A missing file is nothing to lose (the seed writes one); a broken one is
    // worth shouting about rather than quietly replacing.
    if (e.code !== 'ENOENT') throw e;
    data = { channels: [], settings: {} };
  }
  lineupCache = { mtime, data };
  return data;
}
function saveLineup(l) {
  fs.writeFileSync(lineupPath, JSON.stringify(l, null, 2));
  lineupCache = null; // the file changed — read it again next time
}
// A fresh clone has no data/ — seed it from sample/ so the TV works on the first run.
// data/ is deliberately not in version control (it holds whatever you actually watch),
// so this is what a clone gets instead.
function channelById(l, id) { return l.channels.find(c => c.id === id); }

// --- site settings (stored in lineup.json.settings) ------------------------
const DEFAULT_SITE_NAME = 'DIALARR';
const THEME_KEYS = ['bg', 'panel', 'yellow', 'orange', 'text'];
const isColor = (v) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
function cleanTheme(t) {
  const out = {};
  if (t && typeof t === 'object') for (const k of THEME_KEYS) if (isColor(t[k])) out[k] = String(t[k]).toLowerCase();
  return out;
}

// The boxes at the bottom of the TV page: a heading and a paragraph of plain text.
// Editable in the admin console — {{site}} is replaced with the site name.
const DEFAULT_INFO_BOXES = [
  { title: 'who we are', body: '{{site}} is a little corner of the internet where old-school cable TV still exists — channel guide, channel surfing, and yes, commercials. I mostly built this for me and my friends to kick back and enjoy old cable-TV style television together. It\'s all free: no sign-ups, no subscriptions, no strings.' },
  { title: 'where the shows come from', body: 'Most of what streams here comes from archive.org — the internet\'s shared public archive of recordings. We pull the streams and play them back the way a TV station would. If it\'s up there, it\'s probably on here too.' },
  { title: 'ads & your info', body: 'The only ads you\'ll see are the ones already baked into the old VHS recordings — we don\'t add any. No trackers, no ad networks, nothing sneaky. We don\'t collect anything about you and we will never sell your information. That\'s the whole deal.' },
  { title: 'chat decorum', body: 'Chat is a shared couch, so act like it: be respectful and kind. No hate, no slurs, no harassment, no spam, no doxxing — assume the couch next door is listening. Real people are on the other end of every message. Be the person you\'d want to watch TV with; if it isn\'t fun, it isn\'t on.' }
];
function cleanInfoBoxes(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 6).map((b) => ({
    title: String((b && b.title) || '').trim().slice(0, 80),
    body: String((b && b.body) || '').trim().slice(0, 1200)
  })).filter((b) => b.title || b.body);
}
function getSettings() {
  const s = loadLineup().settings || {};
  let rate = (typeof s.chatRateLimit === 'number' && isFinite(s.chatRateLimit) && s.chatRateLimit >= 0) ? Math.floor(s.chatRateLimit) : 560;
  if (rate > 0 && rate < 280) rate = 560; // a small non-zero value is a legacy messages/min setting; keep 0 = unlimited
  const vMin = (typeof s.viewerCountMin === 'number' && isFinite(s.viewerCountMin) && s.viewerCountMin >= 0) ? Math.floor(s.viewerCountMin) : 50;
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.floor(v) : d;
  return {
    siteName: (typeof s.siteName === 'string' && s.siteName.trim()) || DEFAULT_SITE_NAME,
    infoBoxes: Array.isArray(s.infoBoxes) ? cleanInfoBoxes(s.infoBoxes) : DEFAULT_INFO_BOXES,
    theme: cleanTheme(s.theme),
    chatEffects: s.chatEffects !== false,
    chatRateLimit: rate,
    chatMode: s.chatMode === 'users' ? 'users' : 'open',
    showViewerCount: s.showViewerCount !== false,
    viewerCountMin: vMin,
    // transcode: output height (downscale-only, 0 = original), skip sources taller than
    // maxSourceHeight (4K costs too much CPU), keep the cache under cacheBytes (LRU),
    // pre-transcode `lookahead` episodes ahead of what's playing on each channel.
    transcodeHeight: num(s.transcodeHeight, 480),
    transcodeMaxSourceHeight: num(s.transcodeMaxSourceHeight, 1080),
    transcodeCacheBytes: num(s.transcodeCacheBytes, 12 * 1024 * 1024 * 1024),
    transcodeLookahead: num(s.transcodeLookahead, 2),
    liveStreamMax: num(s.liveStreamMax, 8),
    // Which language the audio track is picked from, and which language the
    // subtitles are in. English by default, but a channel can be in whatever
    // language its viewers want.
    audioLanguage: String(s.audioLanguage || 'eng').trim().slice(0, 12),
    // What to play when the file has no track in the language above — an anime
    // with a French dub and a Japanese original has no English at all.
    audioFallback: String(s.audioFallback || '').trim().slice(0, 12),
    subtitleLanguage: String(s.subtitleLanguage || 'eng').trim().slice(0, 12),
    // soft = the subtitles ride along beside the picture and the viewer picks;
    // hard = they are burnt into the picture by the encoder; off = none.
    subtitleMode: ['soft', 'hard', 'off'].includes(s.subtitleMode) ? s.subtitleMode : 'soft',
    // Pre-convert by default: the viewer waited 7-11s for a stream to start because
    // the file was only ever converted while somebody was watching it. Converting
    // ahead of time moves that wait into the background.
    preTranscode: s.preTranscode !== false,
    coffeeLink: typeof s.coffeeLink === 'string' ? s.coffeeLink.trim() : '',
    patreonLink: typeof s.patreonLink === 'string' ? s.patreonLink.trim() : '',
    discordUrl: typeof s.discordUrl === 'string' ? s.discordUrl.trim().slice(0, 200) : '',
    blockedUsernames: typeof s.blockedUsernames === 'string' ? s.blockedUsernames.slice(0, 4000) : '',
    sitePassword: !!s.sitePasswordHash
  };
}
function saveSettings(body) {
  const l = loadLineup();
  l.settings = l.settings || {};
  if (body && body.siteName !== undefined) l.settings.siteName = String(body.siteName).trim().slice(0, 40) || DEFAULT_SITE_NAME;
  if (body && body.infoBoxes !== undefined) {
    // 'default' puts the built-in four back; an array is what the admin typed.
    l.settings.infoBoxes = body.infoBoxes === 'default' ? DEFAULT_INFO_BOXES : (cleanInfoBoxes(body.infoBoxes) || []);
  }
  if (body && body.theme !== undefined) l.settings.theme = cleanTheme(body.theme);
  if (body && body.chatEffects !== undefined) l.settings.chatEffects = !!body.chatEffects;
  if (body && body.chatRateLimit !== undefined) l.settings.chatRateLimit = Math.max(0, Math.floor(Number(body.chatRateLimit)) || 0);
  if (body && body.chatMode !== undefined) l.settings.chatMode = body.chatMode === 'users' ? 'users' : 'open';
  if (body && body.showViewerCount !== undefined) l.settings.showViewerCount = !!body.showViewerCount;
  if (body && body.viewerCountMin !== undefined) l.settings.viewerCountMin = Math.max(0, Math.floor(Number(body.viewerCountMin)) || 0);
  if (body && body.transcodeHeight !== undefined) l.settings.transcodeHeight = Math.max(0, Math.floor(Number(body.transcodeHeight)) || 0);
  if (body && body.transcodeMaxSourceHeight !== undefined) l.settings.transcodeMaxSourceHeight = Math.max(0, Math.floor(Number(body.transcodeMaxSourceHeight)) || 0);
  if (body && body.transcodeCacheBytes !== undefined) l.settings.transcodeCacheBytes = Math.max(0, Math.floor(Number(body.transcodeCacheBytes)) || 0);
  if (body && body.transcodeLookahead !== undefined) l.settings.transcodeLookahead = Math.max(0, Math.floor(Number(body.transcodeLookahead)) || 0);
  if (body && body.liveStreamMax !== undefined) l.settings.liveStreamMax = Math.max(1, Math.floor(Number(body.liveStreamMax)) || 8);
  if (body && body.preTranscode !== undefined) l.settings.preTranscode = !!body.preTranscode;
  if (body && body.audioLanguage !== undefined) l.settings.audioLanguage = String(body.audioLanguage || 'eng').trim().slice(0, 12) || 'eng';
  if (body && body.audioFallback !== undefined) l.settings.audioFallback = String(body.audioFallback || '').trim().slice(0, 12);
  if (body && body.subtitleLanguage !== undefined) l.settings.subtitleLanguage = String(body.subtitleLanguage || 'eng').trim().slice(0, 12) || 'eng';
  if (body && body.subtitleMode !== undefined) l.settings.subtitleMode = ['soft', 'hard', 'off'].includes(body.subtitleMode) ? body.subtitleMode : 'soft';
  for (const k of ['coffeeLink', 'patreonLink', 'discordUrl']) {
    if (body && body[k] !== undefined) {
      const v = String(body[k] || '').trim().slice(0, 300);
      if (v) l.settings[k] = v; else delete l.settings[k];
    }
  }
  if (body && body.blockedUsernames !== undefined) {
    l.settings.blockedUsernames = String(body.blockedUsernames || '').slice(0, 4000);
  }
  if (body && body.sitePassword !== undefined) {
    const pw = String(body.sitePassword || '').trim();
    if (pw) l.settings.sitePasswordHash = hashPassword(pw);
    else delete l.settings.sitePasswordHash;
  }
  saveLineup(l);
  io.emit('settings:update', getSettings());
  tcTick(); // the pre-convert toggle should take effect now, not in a minute
  return getSettings();
}

// --- chat pop-up effects (one-shot reactions, broadcast to the channel) ---
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}️?‍?)+$/u;
const NAMED_EFFECT = { fireworks: 'fireworks', '🎆': 'fireworks', '🎇': 'fireworks', confetti: 'confetti', '🎉': 'confetti' };
function effectFor(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const named = NAMED_EFFECT[t] || NAMED_EFFECT[t.toLowerCase()];
  if (named) return { kind: named };
  if (EMOJI_ONLY.test(t)) return { kind: 'emoji', value: t.split(/\s+/)[0] };
  return null;
}

function nextVersion(channel) {
  const vs = channel.versions || [];
  return vs.length ? Math.max(...vs.map(v => v.v)) + 1 : 1;
}

// Publish a manifest file and point the channel's newest version at it.
function publishChannel(channelId, { items, startIndex = 0, epochMs = Date.now(), effectiveAtMs = Date.now() }) {
  const l = loadLineup();
  const ch = channelById(l, channelId);
  if (!ch) throw Object.assign(new Error('channel not found: ' + channelId), { status: 404 });
  const v = nextVersion(ch);
  const dir = path.join(DATA, 'manifests', channelId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    engine: 1,
    channel: channelId,
    version: v,
    build: new Date().toISOString(),
    items: items.map(it => ({
      id: it.id || `${channelId}-item-${v}-${Math.random().toString(36).slice(2, 8)}`,
      src: it.src || '',
      title: it.title || '',
      year: it.year || '',
      duration: clampDuration(it.duration) || 1,
      isAd: !!it.isAd,
      // generated commercial (on-screen quips + music), no video
      adSlides: Array.isArray(it.adSlides) ? it.adSlides.map(s => String(s).slice(0, 120)).slice(0, 12) : undefined,
      music: typeof it.music === 'string' && it.music ? it.music.slice(0, 300) : undefined
    }))
  };
  if (!manifest.items.length) throw Object.assign(new Error('no items to publish'), { status: 400 });
  fs.writeFileSync(path.join(dir, `v${v}.json`), JSON.stringify(manifest, null, 2));
  manifestCache.set(channelId + ':' + v, { manifest, mtime: Date.now() });

  ch.versions = ch.versions || [];
  ch.versions.push({
    v,
    manifest: `manifests/${channelId}/v${v}.json`,
    epochMs,
    effectiveAtMs,
    startIndex: startIndex % manifest.items.length
  });
  saveLineup(l);
  io.emit('broadcast:update', { channelId, v });
  tcTick(); // what is on air now should start converting straight away
  return { v, epochMs, effectiveAtMs, count: manifest.items.length };
}

// Time-shift: re-anchor the broadcast by deltaMs without changing items.
// Positive delta = fast-forward (broadcast jumps ahead), negative = rewind.
// position = (now - epoch) mod loop, so advancing D means epoch -= D.
function shiftChannel(channelId, deltaMs) {
  const l = loadLineup();
  const ch = channelById(l, channelId);
  if (!ch) throw Object.assign(new Error('channel not found: ' + channelId), { status: 404 });
  const vs = ch.versions || [];
  if (!vs.length) throw Object.assign(new Error('channel has no versions'), { status: 400 });
  const last = vs[vs.length - 1];
  const mv = JSON.parse(fs.readFileSync(path.join(DATA, last.manifest), 'utf8'));
  const now = Date.now();
  const newEpoch = last.epochMs - deltaMs;
  publishChannel(channelId, {
    items: mv.items,
    startIndex: last.startIndex,
    epochMs: newEpoch,
    effectiveAtMs: now // active immediately, even if the anchor moved
  });
  return { channelId, deltaMs, newEpoch, now };
}

// Where we are in the broadcast loop for the channel's active version.
// Same walk as public/engine.js positionAt, plus each item's start offset
// (for episode jumping) and draft-lineup numbers (index + 1).
function onairInfo(channelId, now = Date.now()) {
  const l = loadLineup();
  const ch = channelById(l, channelId);
  if (!ch) throw Object.assign(new Error('channel not found: ' + channelId), { status: 404 });
  const active = (ch.versions || []).filter(v => v.effectiveAtMs <= now).sort((a, b) => a.v - b.v);
  const ver = active[active.length - 1];
  if (!ver) return { offAir: true, channelId };
  const mv = JSON.parse(fs.readFileSync(path.join(DATA, ver.manifest), 'utf8'));
  const items = mv.items || [];
  for (const it of items) it.duration = clampDuration(it.duration) || 1;  // same ceiling the guide uses
  const n = items.length;
  const bumpMs = l.bumpMs || 0;
  const loop = items.reduce((s, i) => s + i.duration * 1000, 0) + n * bumpMs;
  if (!n || loop <= 0) return { offAir: true, channelId, v: ver.v };
  const t = ((now - ver.epochMs) % loop + loop) % loop;
  let acc = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const idx = (ver.startIndex + i) % n, durMs = items[idx].duration * 1000;
    if (t < acc + durMs) { k = i; break; }
    acc += durMs + bumpMs;
  }
  const pos = (i) => (ver.startIndex + i) % n;
  const startOf = (i) => { let s = 0; for (let j = 0; j < i; j++) s += items[pos(j)].duration * 1000 + bumpMs; return s; };
  const item = (i) => ({ n: i + 1, title: items[pos(i)].title || items[pos(i)].id, dur: items[pos(i)].duration, startMs: startOf(i), isAd: !!items[pos(i)].isAd });
  return { offAir: false, channelId, v: ver.v, t, loop, current: item(k), prev: item((k - 1 + n) % n), next: item((k + 1) % n) };
}

// Re-anchor so the given item is at the very top: 'start' (current), 'next', 'prev'.
// prev of loop item 1 wraps to the last item of the loop (a forward jump).
function jumpChannel(channelId, where) {
  const info = onairInfo(channelId);
  if (info.offAir) throw Object.assign(new Error('channel is off air'), { status: 400 });
  const target = (where === 'start' ? info.current : info[where]).startMs;
  let delta = ((target - info.t) % info.loop + info.loop) % info.loop;
  if (delta === 0) delta = info.loop; // already on the boundary; full-loop re-anchor keeps it there
  return shiftChannel(channelId, delta);
}

// --- admin API ------------------------------------------------------------
app.get('/api/lineup', (req, res) => { res.json(publicLineup()); });
// Guide blocks for a time window — returns only the items intersecting [now-backMs, now+fwdMs].
// ~50KB response instead of the browser fetching ~100MB of full manifests.
// The window follows the content: a channel that loops every few minutes does not need
// five hours of guide, and in a window that long the same handful of items repeat until
// the row is unreadable. Channels with loops of hours are unaffected.
const GUIDE_MIN_WINDOW = 5 * 60 * 1000;
app.get('/api/guide/blocks', (req, res) => {
  const now = Date.now();
  let backMs = Math.min(3600000, Math.max(0, parseInt(req.query.backMs) || 3600000));
  let fwdMs = Math.min(12 * 3600000, Math.max(0, parseInt(req.query.fwdMs) || 5 * 3600000));
  let l; try { l = loadLineup(); } catch (e) { return res.status(500).json({ err: 'lineup unavailable' }); }
  const bump = l.bumpMs || 0;
  // first pass: what is on, and how long the longest loop is
  const live = [];
  let longest = 0;
  for (const ch of (l.channels || []).filter((c) => !c.hidden)) {
    const v = E.activeVersion(ch, now);
    const mv = v ? loadManifest(ch.id, v.v) : null;
    if (!v || !mv || !(mv.items || []).length) { live.push({ ch, offAir: true }); continue; }
    const loop = mv.items.reduce((s, i) => s + i.duration * 1000, 0) + mv.items.length * bump;
    if (loop <= 0) { live.push({ ch, offAir: true }); continue; }
    live.push({ ch, v, mv, loop });
    if (loop > longest) longest = loop;
  }
  if (longest > 0) {
    const want = Math.min(backMs + fwdMs, Math.max(GUIDE_MIN_WINDOW, longest * 2));
    const ratio = fwdMs / ((backMs + fwdMs) || 1);
    fwdMs = Math.round(want * ratio);
    backMs = want - fwdMs;
  }
  const W0 = now - backMs, W1 = now + fwdMs;
  const out = [];
  for (const e of live) {
    const ch = e.ch;
    if (e.offAir) { out.push({ id: ch.id, dial: ch.dial, emoji: ch.emoji, name: ch.name, offAir: true }); continue; }
    const v = e.v, mv = e.mv, loop = e.loop;
    const items = mv.items, n = items.length;
    const iter = Math.floor((now - v.epochMs) / loop);
    const iterStart = v.epochMs + iter * loop;
    const t = now - iterStart;
    let acc = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const idx = (v.startIndex + i) % n, durMs = items[idx].duration * 1000;
      if (t < acc + durMs) { k = i; break; }
      acc += durMs + bump;
    }
    let s = 0;
    for (let i = 0; i < k; i++) s += items[(v.startIndex + i) % n].duration * 1000 + bump;
    const startK = iterStart + s;
    const blocks = [];
    let cur = k, st = startK, guard = 0;
    while (st < W1 && guard++ < 2000) {
      const idx = (v.startIndex + cur) % n, durMs = items[idx].duration * 1000;
      blocks.push({ title: items[idx].title || '', year: items[idx].year || '', isAd: !!items[idx].isAd, start: st, end: st + durMs });
      st += durMs + bump; cur = (cur + 1) % n;
    }
    cur = (k - 1 + n) % n; let en = startK; guard = 0;
    while (en > W0 && guard++ < 2000) {
      const idx = (v.startIndex + cur) % n, durMs = items[idx].duration * 1000;
      const bstart = en - durMs;
      blocks.push({ title: items[idx].title || '', year: items[idx].year || '', isAd: !!items[idx].isAd, start: bstart, end: en });
      en = bstart; cur = (cur - 1 + n) % n;
    }
    blocks.sort((a, b) => a.start - b.start);
    out.push({ id: ch.id, dial: ch.dial, emoji: ch.emoji, name: ch.name, offAir: false, blocks });
  }
  res.json({ now, backMs, fwdMs, channels: out });
});
app.get('/api/admin/lineup', (req, res) => { const l = Object.assign({}, loadLineup()); delete l.users; res.json(l); });
// --- the info tab: what this box is, what it is holding, how it is doing ----
let PKG = null;
function pkg() {
  if (!PKG) { try { PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { PKG = {}; } }
  return PKG;
}
function diskOf(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path: p, total, free, used: Math.max(0, total - free) };
  } catch (e) { return null; }
}
app.get('/api/admin/info', (req, res) => {
  const l = loadLineup();
  const channels = l.channels || [];
  let shows = 0, episodes = 0, versions = 0;
  for (const ch of channels) {
    shows += (ch.shows || []).length;
    for (const s of ch.shows || []) episodes += (s.episodes || []).length;
    versions += (ch.versions || []).length;
  }
  const seen = new Set();
  const mounts = [];
  for (const [label, p] of [['media', MEDIA], ['content', CONTENT_DIR], ['movies', MOVIES_DIR], ['data', DATA], ['cache', TRANSCODE_DIR]]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const d = diskOf(p);
    if (d) mounts.push(Object.assign({ label }, d));
  }
  const mem = process.memoryUsage();
  const p = pkg();
  res.json({
    name: p.name || 'dialarr', version: p.version || '0.0.0',
    node: process.version, platform: process.platform + ' ' + process.arch,
    uptime: Math.floor(process.uptime() / 60) + ' min',
    channels: channels.length, shows, episodes, versions,
    rss: mem.rss, memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem(),
    mounts, discordUrl: getSettings().discordUrl || ''
  });
});
// The console reads a channel's published manifest to seed its draft. The viewer
// route for the same file sits behind the site password, so it needs one of its
// own — behind the admin password instead.
app.get('/api/admin/manifests/:channel/:file', manifestRoute);
app.get('/api/settings', (req, res) => res.json(getSettings()));
// The console reads the settings from here: it is behind the admin password
// rather than the site password, so the console still works when the site is
// locked. The language list rides along so the console can offer them.
app.get('/api/admin/settings', (req, res) => {
  res.json(Object.assign({}, getSettings(), { langList: LANG_LIST }));
});
app.post('/api/admin/settings', (req, res, next) => {
  try { res.json({ ok: true, settings: saveSettings(req.body || {}) }); } catch (e) { next(e); }
});

app.post('/api/admin/publish', (req, res, next) => {
  try { res.json({ ok: true, ...publishChannel(req.body.channel, req.body) }); }
  catch (e) { next(e); }
});

app.post('/api/admin/shift', (req, res, next) => {
  try {
    const deltaMs = Number(req.body.deltaMs) || 0;
    res.json({ ok: true, ...shiftChannel(req.body.channel, deltaMs) });
  } catch (e) { next(e); }
});

app.post('/api/admin/jump', (req, res, next) => {
  try {
    const where = String((req.body && req.body.where) || '');
    if (!['start', 'prev', 'next'].includes(where)) throw Object.assign(new Error('where must be start, prev, or next'), { status: 400 });
    res.json({ ok: true, ...jumpChannel(req.body.channel, where) });
  } catch (e) { next(e); }
});

// ON AIR status for every channel: current/next episode + draft numbers.
app.get('/api/admin/onair', (req, res, next) => {
  try {
    const l = loadLineup();
    const channels = l.channels.map((c) => {
      try { return { dial: c.dial, name: c.name, channelId: c.id, ...onairInfo(c.id) }; }
      catch (e) { return { dial: c.dial, name: c.name, channelId: c.id, offAir: true, error: e.message }; }
    });
    res.json({ channels });
  } catch (e) { next(e); }
});

app.post('/api/admin/shuffle', (req, res, next) => {
  try {
    const l = loadLineup();
    const ch = channelById(l, req.body.channel);
    if (!ch) throw Object.assign(new Error('channel not found'), { status: 404 });
    const last = (ch.versions || [])[ch.versions.length - 1];
    if (!last) throw Object.assign(new Error('no versions'), { status: 400 });
    const mv = JSON.parse(fs.readFileSync(path.join(DATA, last.manifest), 'utf8'));
    // Fisher-Yates
    for (let i = mv.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mv.items[i], mv.items[j]] = [mv.items[j], mv.items[i]];
    }
    const out = publishChannel(req.body.channel, { items: mv.items, startIndex: 0, epochMs: Date.now() });
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

// --- channel management -----------------------------------------------------
function slugId(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'channel';
}
function addChannel(body) {
  const l = loadLineup();
  const name = String((body && body.name) || '').trim();
  if (!name) throw Object.assign(new Error('channel name required'), { status: 400 });
  let id = String((body && body.id) || slugId(name)).slice(0, 40).replace(/[^a-z0-9_-]/g, '');
  let n = 2;
  while (l.channels.some(c => c.id === id)) { id = String((body && body.id) || slugId(name)).slice(0, 36) + '-' + n; n++; }
  const dial = Number(body.dial) > 0 ? Math.round(Number(body.dial)) : l.channels.reduce((m, c) => Math.max(m, c.dial || 1), 0) + 1;
  const ch = {
    id, name: name.slice(0, 40),
    emoji: String((body.emoji) || '📺').slice(0, 8),
    dial, color: String((body.color) || '#FF6F00').slice(0, 12),
    description: String((body.description) || '').slice(0, 200),
    hidden: !!(body && body.hidden),
    subtitleMode: ['soft', 'hard', 'off'].includes(body.subtitleMode) ? body.subtitleMode : '',
    versions: []
  };
  l.channels.push(ch);
  saveLineup(l);
  io.emit('lineup:update', { added: ch.id });
  return ch;
}
function updateChannel(body) {
  const l = loadLineup();
  const ch = l.channels.find(c => c.id === String((body && body.id) || ''));
  if (!ch) throw Object.assign(new Error('channel not found'), { status: 404 });
  if (body.name !== undefined && String(body.name).trim()) ch.name = String(body.name).trim().slice(0, 40);
  if (body.emoji !== undefined && String(body.emoji).trim()) ch.emoji = String(body.emoji).slice(0, 8);
  if (body.dial !== undefined && Number(body.dial) > 0) ch.dial = Math.round(Number(body.dial));
  if (body.color !== undefined && String(body.color)) ch.color = String(body.color).slice(0, 12);
  if (body.description !== undefined) ch.description = String(body.description).slice(0, 200);
  if (body.hidden !== undefined) ch.hidden = !!body.hidden;
  if (body.subtitleMode !== undefined) ch.subtitleMode = ['soft', 'hard', 'off', ''].includes(body.subtitleMode) ? body.subtitleMode : '';
  saveLineup(l);
  io.emit('lineup:update', { updated: ch.id });
  return ch;
}
function deleteChannel(id) {
  const l = loadLineup();
  const ch = l.channels.find(c => c.id === String(id));
  if (!ch) throw Object.assign(new Error('channel not found'), { status: 404 });
  if ((ch.versions || []).length) throw Object.assign(new Error('channel has published content — it can’t be deleted yet'), { status: 400 });
  if (l.channels.length <= 1) throw Object.assign(new Error('cannot delete the last channel'), { status: 400 });
  l.channels = l.channels.filter(c => c.id !== String(id));
  saveLineup(l);
  io.emit('lineup:update', { removed: id });
  return { ok: true };
}
app.post('/api/admin/channels', (req, res, next) => {
  try { res.json({ ok: true, channel: addChannel(req.body || {}) }); } catch (e) { next(e); }
});
app.post('/api/admin/channels/update', (req, res, next) => {
  try { res.json({ ok: true, channel: updateChannel(req.body || {}) }); } catch (e) { next(e); }
});
app.post('/api/admin/channels/delete', (req, res, next) => {
  try { res.json(deleteChannel(req.body && req.body.id)); } catch (e) { next(e); }
});
app.post('/api/admin/channels/reorder', (req, res, next) => {
  try {
    const l = loadLineup();
    const order = req.body && req.body.order;
    const byId = new Map(l.channels.map((c) => [c.id, c]));
    if (!Array.isArray(order) || new Set(order).size !== order.length || order.length !== l.channels.length || order.some((id) => !byId.has(id))) {
      throw Object.assign(new Error('order must list every channel exactly once'), { status: 400 });
    }
    l.channels = order.map((id) => byId.get(id));
    saveLineup(l);
    io.emit('lineup:update', { reordered: true });
    res.json({ ok: true, count: l.channels.length });
  } catch (e) { next(e); }
});

// --- duration probing -------------------------------------------------------
// PROBE_TIMEOUT: how long to wait for ffprobe. The library is a usenet-backed rclone
// mount, so a file that isn't downloaded yet stalls the read for minutes — raise this
// for a slow overnight pass over the library, lower it to keep builds snappy.
const PROBE_TIMEOUT = Math.max(1000, Number(process.env.PROBE_TIMEOUT) || 30000);
// The longest length the guide will ever show. Nothing in a library is really this
// long: movies run 2-3h, episodes 20-60min, a 2h special at the outside. A longer
// number is a glitched file's bogus header or a mistyped admin entry, not a length.
const MAX_ITEM_SECONDS = 8 * 3600;
// Above this, ffprobe didn't measure the file — it read a header off a half-downloaded
// file (the usenet mount can hand back a bogus header), so the measurement is
// untrustworthy and we treat it as unmeasured: a 130-hour guide entry is worse than
// a 30-minute one.
const MAX_PROBE_SECONDS = 6 * 3600;
// Clamp a length to what the guide may show. 0 = unknown.
function clampDuration(sec) {
  const n = Math.round(Number(sec) || 0);
  if (n <= 0) return 0;
  return Math.min(n, MAX_ITEM_SECONDS);
}
function runFfprobe(absPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let cmd;
    try { cmd = require('child_process').spawn('ffprobe', args); }
    catch (e) { return reject(Object.assign(new Error('ffprobe not available'), { status: 503 })); }
    const t = setTimeout(() => { try { cmd.kill(); } catch (e) {} reject(Object.assign(new Error('probe timed out'), { status: 503, timedOut: true })); }, timeoutMs);
    let out = '';
    cmd.on('error', () => { clearTimeout(t); reject(Object.assign(new Error('ffprobe failed'), { status: 503 })); });
    cmd.stdout.on('data', (d) => { out += d; });
    cmd.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(Object.assign(new Error('ffprobe failed'), { status: 503 }));
      try { const j = JSON.parse(out); const d = Math.round(Number(j && j.format && j.format.duration) || 0);
        if (!d) throw new Error('no duration');
        if (d > MAX_PROBE_SECONDS) throw new Error('implausible duration');
        resolve(d); }
      catch (e) { reject(Object.assign(new Error('could not read duration'), { status: 503 })); }
    });
  });
}
function ffprobeDuration(absPath) {
  // Bounded probe FIRST: it stops after 16MB, which is where the container's duration
  // lives. A plain probe walks on into the attachments/cluster, and on this library every
  // byte past the header has to be pulled from usenet first — so it stalls where the
  // bounded one is already done. The plain probe stays as the fallback for files whose
  // length isn't in the header (AVI keeps its index at the very end).
  return runFfprobe(absPath, ['-v', 'error', '-analyzeduration', '3000000', '-probesize', '16000000', '-show_entries', 'format=duration', '-of', 'json', absPath], PROBE_TIMEOUT)
    .catch(err => {
      if (!err.timedOut) throw err;
      return runFfprobe(absPath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', absPath], PROBE_TIMEOUT * 2);
    });
}
function probeDuration(src) {
  if (src.startsWith('/media/')) return ffprobeDuration(path.join(MEDIA, src.replace(/^\/media\//, '')));
  const a = srcToAbs(src);
  if (a) return ffprobeDuration(a);
  if (/^https?:\/\//.test(src)) return ffprobeDuration(src);
  return Promise.reject(Object.assign(new Error('src must be /media/…, /content/…, /movies/…, or an http(s) URL'), { status: 400 }));
}
app.post('/api/admin/probe', (req, res, next) => {
  const src = String(req.body && req.body.src || '').slice(0, 800);
  if (!src) return res.status(400).json({ error: 'need src' });
  probeDuration(src).then((d) => res.json({ duration: d })).catch(next);
});

// --- tracks: the languages inside a file (audio + subtitles) -----------------
// An mkv can carry several languages of both. The browser plays one audio track
// and cannot read mkv subtitles at all, so we probe the file once, let the viewer
// pick a language, map the chosen audio into the stream, and hand the subtitles
// over as a WebVTT sidecar.
const TRACK_STORE = path.join(DATA, 'tracks.json');
const SUB_DIR = path.join(DATA, 'subs');
let TRACKS = null;
function trackStore() {
  if (!TRACKS) { let s = {}; try { s = JSON.parse(fs.readFileSync(TRACK_STORE, 'utf8')); } catch (e) { s = {}; } TRACKS = s; }
  return TRACKS;
}
function trackStoreSave() {
  try { fs.mkdirSync(path.dirname(TRACK_STORE), { recursive: true }); fs.writeFileSync(TRACK_STORE, JSON.stringify(TRACKS, null, 2)); }
  catch (e) { console.error('track store save failed:', e.message); }
}
const LANG_NAMES = {
  eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese',
  kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', rus: 'Russian', ru: 'Russian',
  por: 'Portuguese', pt: 'Portuguese', swe: 'Swedish', sv: 'Swedish', nor: 'Norwegian', no: 'Norwegian',
  dan: 'Danish', da: 'Danish', fin: 'Finnish', fi: 'Finnish', dut: 'Dutch', nl: 'Dutch', pol: 'Polish',
  pl: 'Polish', tur: 'Turkish', tr: 'Turkish', ara: 'Arabic', ar: 'Arabic', hin: 'Hindi', hi: 'Hindi',
  cze: 'Czech', cs: 'Czech', ces: 'Czech', gre: 'Greek', el: 'Greek', ell: 'Greek', heb: 'Hebrew', he: 'Hebrew',
  und: 'Undetermined', nld: 'Dutch', tha: 'Thai', vie: 'Vietnamese', ind: 'Indonesian', ron: 'Romanian',
  hun: 'Hungarian', ukr: 'Ukrainian', cat: 'Catalan', msa: 'Malay'
};
// The same language is written two ways — "en" and "eng", "fre" and "fra" — and
// the files use both. Every spelling is mapped to one code so a setting of
// "spa" still finds the track an old rip tagged "es".
const LANG_CANON = {
  en: 'eng', es: 'spa', fr: 'fra', fre: 'fra', de: 'deu', ger: 'deu', it: 'ita', pt: 'por',
  nl: 'nld', dut: 'nld', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pol', cs: 'ces',
  cze: 'ces', tr: 'tur', ru: 'rus', ar: 'ara', he: 'heb', hi: 'hin', el: 'ell', gre: 'ell',
  ja: 'jpn', ko: 'kor', zh: 'chi', zho: 'chi', th: 'tha', vi: 'vie', id: 'ind', ro: 'ron',
  rum: 'ron', hu: 'hun', uk: 'ukr', ca: 'cat', ms: 'msa', may: 'msa'
};
function canonLang(l) {
  const s = String(l || '').toLowerCase();
  return LANG_CANON[s] || s;
}
// The languages the console offers — one per language, with the code the files
// are usually tagged with.
const LANG_LIST = (() => {
  const seen = new Map();
  for (const code of Object.keys(LANG_NAMES)) {
    const name = LANG_NAMES[code];
    if (name === 'Undetermined' || seen.has(name)) continue;
    seen.set(name, LANG_CANON[code] || code);
  }
  return [...seen].map(([name, code]) => ({ name, code }));
})();
// Picture subtitles (PGS, VobSub) need OCR to become text — they are left out.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd',
  'mpl2', 'sami', 'stl', 'subviewer', 'subviewer1', 'vplayer', 'realtext', 'pjs', 'jacosub', 'vtt']);
function localAbs(src) {
  if (typeof src !== 'string') return null;
  if (src.includes('..')) return null;
  if (src.startsWith('/media/')) return path.join(MEDIA, src.slice('/media/'.length));
  return srcToAbs(src);
}
function probeTracks(absPath) {
  return new Promise((resolve, reject) => {
    let cmd;
    // Bounded like the duration probe: the stream list lives in the container header,
    // so stopping after 16MB saves pulling the whole file across a slow mount.
    const args = ['-v', 'error', '-analyzeduration', '3000000', '-probesize', '16000000',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,channels,disposition:stream_tags=language,title', '-of', 'json', absPath];
    try { cmd = require('child_process').spawn('ffprobe', args); }
    catch (e) { return reject(new Error('ffprobe not available')); }
    const t = setTimeout(() => { try { cmd.kill(); } catch (e) {} reject(new Error('probe timed out')); }, PROBE_TIMEOUT);
    let out = '';
    cmd.on('error', () => { clearTimeout(t); reject(new Error('ffprobe failed')); });
    cmd.stdout.on('data', (d) => { out += d; });
    cmd.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        const audio = [], subs = [], video = [];
        let subOrd = 0;
        for (const s of (j.streams || [])) {
          const tags = s.tags || {};
          const lang = String(tags.language || tags.LANGUAGE || '').toLowerCase().slice(0, 12);
          const title = String(tags.title || tags.TITLE || '').slice(0, 80);
          const label = title || LANG_NAMES[lang] || (lang ? lang.toUpperCase() : '');
          if (s.codec_type === 'video') {
            video.push({ ord: video.length, w: Number(s.width) || 0, h: Number(s.height) || 0, pic: /attached_pic/.test(String(s.disposition || '')) });
          } else if (s.codec_type === 'audio') {
            audio.push({ ord: audio.length, lang, title, ch: Number(s.channels) || 0, label: label || 'audio ' + (audio.length + 1) });
          } else if (s.codec_type === 'subtitle') {
            const ord = subOrd++; // the ord counts every subtitle stream, so ffmpeg's 0:s:N still matches
            if (!TEXT_SUBS.has(String(s.codec_name || '').toLowerCase())) continue;
            subs.push({ ord, lang, title, label: label || 'subtitle ' + (ord + 1) });
          }
        }
        resolve({ audio, subs, video });
      } catch (e) { reject(new Error('could not read streams')); }
    });
  });
}
async function tracksFor(src, force) {
  const abs = localAbs(src);
  const empty = { audio: [], subs: [], defaultAudio: 0, videoOrd: 0 };
  if (!abs) return empty;
  const st = trackStore();
  const hit = st[src];
  // a good probe is worth keeping; a failed one is retried in a few minutes —
  // unless we are told to try again now, which the live stream does: it cannot
  // wait five minutes for the right language.
  if (hit && !force && (hit.bad ? Date.now() - hit.at < 5 * 60000 : true)) return hit.tracks;
  try {
    const t = await probeTracks(abs);
    const tracks = { audio: t.audio, subs: t.subs, defaultAudio: 0, videoOrd: 0 };
    // English is what everybody gets: the tag is usually 'eng' or 'en', sometimes
    // it is only in the title ('English (US)').
    const en = t.audio.find((a) => a.lang.startsWith('en')) ||
      t.audio.find((a) => /english/i.test(a.title || ''));
    if (en) tracks.defaultAudio = en.ord;
    // ffmpeg's own default is the biggest video stream — the same one, so mapping
    // the audio by hand does not quietly change which picture we show.
    const vids = t.video.filter((v) => !v.pic);
    const best = (vids.length ? vids : t.video).sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    if (best) tracks.videoOrd = best.ord;
    st[src] = { at: Date.now(), tracks };
    trackStoreSave();
    return tracks;
  } catch (e) {
    st[src] = { at: Date.now(), bad: true, tracks: empty };
    trackStoreSave();
    return empty;
  }
}
// The stored tracks, without probing — the live stream uses this so it never
// waits on a slow mount to find out which audio to play.
function tracksCached(src) {
  const hit = trackStore()[src];
  return hit && !hit.bad ? hit.tracks : null;
}
function probeTracksLater(src) {
  tracksFor(src).catch(() => {});
}
// Pick a track by language: exact first, then a prefix either way ("en" matches
// "eng"), then nothing.
function pickLang(list, lang) {
  const l = canonLang(lang);
  if (!l || !Array.isArray(list)) return null;
  let t = list.find((x) => x.lang && canonLang(x.lang) === l);
  if (!t) t = list.find((x) => x.lang && (canonLang(x.lang).startsWith(l) || l.startsWith(canonLang(x.lang))));
  return t || null;
}
// The commentary is somebody else talking over the programme. It is never the
// one to play, whatever language it is tagged with.
const NOT_THE_PROGRAMME = /commentary|commentaire|description|descriptive|alternate audio|secondary audio|audio description/i;
// The name a language goes by, so a track that only says it in its title is found.
function langName(code) {
  const c = canonLang(code);
  return LANG_NAMES[c] || LANG_NAMES[String(code || '').toLowerCase()] || '';
}
// The original mix: the one the makers made. "VO" in the title says so, and
// failing that the big one is it — a 5.1 remix is the original, a 2.0 dub is not.
function originalTrack(pool) {
  const vo = pool.find((a) => /\bVO\b|version originale|\boriginal\b/i.test(a.title || ''));
  if (vo) return vo;
  let best = null;
  for (const a of pool) if (!best || (a.ch || 0) > (best.ch || 0)) best = a;
  return best && best.ch ? best : null;
}
// The audio track to play: the language that was asked for, then the one that
// was asked for second, then the original mix, then English, then whatever is
// there. The language is a setting, so it is worked out at the moment of use
// rather than baked into the probe cache.
function audioOrd(tracks, lang, fallback) {
  const all = (tracks && tracks.audio) || [];
  if (!all.length) return 0;
  // The programme first — a commentary track is not it, whatever it is tagged.
  const list = all.filter((a) => !NOT_THE_PROGRAMME.test(a.title || ''));
  const pool = list.length ? list : all;
  const byLanguage = (code) => {
    if (!code) return null;
    let t = pickLang(pool, code);
    if (!t) {
      // Some files only name the language in the title ('English (AC3 Stereo)').
      const nm = langName(code);
      if (nm) t = pool.find((a) => nm && String(a.title || '').toLowerCase().includes(nm.toLowerCase()));
    }
    return t;
  };
  const t = byLanguage(canonLang(lang) || 'eng') ||
    byLanguage(canonLang(fallback || '')) ||
    originalTrack(pool) ||
    byLanguage('eng') ||
    pool[0];
  return t ? t.ord : 0;
}
// The subtitle track to use, in the preferred language. A file can carry
// several tracks in the same language: "Signs & Songs" is the opening and the
// ending, "Full Subtitles" is the programme. The dialogue is the one wanted.
const NOT_DIALOGUE = /sign|song|lyric|karaoke|opening|ending|commentary/i;
function subOrd(tracks, lang) {
  const list = (tracks && tracks.subs) || [];
  if (!list.length) return -1;
  const l = canonLang(lang);
  let pool = list.filter((x) => x.lang && canonLang(x.lang) === l);
  if (!pool.length) pool = list.filter((x) => x.lang && (canonLang(x.lang).startsWith(l) || l.startsWith(canonLang(x.lang))));
  if (!pool.length) pool = list;
  const dialogue = pool.filter((x) => !NOT_DIALOGUE.test(x.title || ''));
  const t = (dialogue.length ? dialogue : pool)[0];
  return t ? t.ord : -1;
}
// Are the subtitles soft (a sidecar the viewer picks), hard (burnt into the
// picture) or off? A channel can override the setting for itself.
function subtitleModeFor(src) {
  const g = getSettings().subtitleMode;
  if (!src) return g;
  try {
    const l = loadLineup();
    for (const ch of l.channels || []) {
      if (!ch.subtitleMode) continue;
      for (const show of ch.shows || []) {
        for (const ep of show.episodes || []) {
          if (ep.src === src) return ch.subtitleMode;
        }
      }
    }
  } catch (e) { /* the lineup is unreadable — the setting it is */ }
  return g;
}
app.get('/api/tracks', async (req, res, next) => {
  const src = String(req.query.src || '').slice(0, 800);
  if (!src) return res.status(400).json({ error: 'need src' });
  try {
    const t = await tracksFor(src);
    const s = getSettings();
    const ord = audioOrd(t, s.audioLanguage, s.audioFallback);
    res.json(Object.assign({}, t, {
      mode: subtitleModeFor(src),
      audioLanguage: s.audioLanguage,
      audioFallback: s.audioFallback,
      subtitleLanguage: s.subtitleLanguage,
      audioOrd: ord,
      audioLabel: (t.audio[ord] && (t.audio[ord].label || t.audio[ord].lang)) || '',
      defaultSub: subOrd(t, s.subtitleLanguage) // the track the setting picks; the viewer can still change it
    }));
  } catch (e) { next(e); }
});

// WebVTT sidecar: the subtitle cues of one stream, moved to where the player is.
function runFfmpegCapture(args, timeoutMs) {
  return new Promise((resolve) => {
    let cmd;
    try { cmd = require('child_process').spawn('ffmpeg', args); }
    catch (e) { return resolve(''); }
    const t = setTimeout(() => { try { cmd.kill(); } catch (e) {} resolve(''); }, timeoutMs || 120000);
    let out = '';
    cmd.stdout.on('data', (d) => { out += d; });
    cmd.on('error', () => { clearTimeout(t); resolve(''); });
    cmd.on('close', () => { clearTimeout(t); resolve(out); });
  });
}
function vttPath(src, ord) {
  const key = crypto.createHash('md5').update(src + '#' + ord).digest('hex');
  return path.join(SUB_DIR, key + '.vtt');
}
function vttSeconds(t) {
  const p = String(t).split(':').map(Number);
  if (p.some((n) => !isFinite(n))) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}
function vttStamp(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const ms = Math.round((ss - Math.floor(ss)) * 1000);
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' +
    String(Math.floor(ss)).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}
// The cues are timed against the whole file; the player starts partway into it, so
// every cue moves back by that much (and cues already past are dropped).
function shiftVtt(text, seekSec) {
  if (!seekSec) return text;
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^(.*?)((?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d{1,2}:)?\d{1,2}:\d{2}\.\d{3})(.*)$/.exec(line);
    if (!m) { out.push(line); continue; }
    const end = vttSeconds(m[3]) - seekSec;
    if (end <= 0) { out.push(''); continue; }
    out.push(m[1] + vttStamp(vttSeconds(m[2]) - seekSec) + ' --> ' + vttStamp(end) + m[4]);
  }
  return out.join('\n');
}
// Extracting the cues means reading the whole file, so it happens in the
// background and the viewer is not kept waiting: the sidecar is asked for
// again until it is there.
const vttBusy = new Map(); // src#ord -> promise
function vttExtract(src, ord) {
  const key = src + '#' + ord;
  if (vttBusy.has(key)) return vttBusy.get(key);
  // A live pipe for this file is reading the same mount at 1x: a whole-file
  // extraction alongside it is the chop the viewer sees on soft-subtitle
  // channels, and the cues never arrive either. Hold the extraction — the
  // client asks again every five seconds, and once the pipe is down it goes
  // ahead. (A cached file never gets here: its sidecar was made with it.)
  if (livePipes.has(src) || liveStarting.has(src)) return null;
  const p = (async () => {
    const abs = localAbs(src);
    if (!abs) return null;
    const out = await runFfmpegCapture(['-v', 'error', '-i', abs, '-map', '0:s:' + ord, '-f', 'webvtt', '-']);
    if (!out) return null;
    try { fs.mkdirSync(SUB_DIR, { recursive: true }); fs.writeFileSync(vttPath(src, ord), out); }
    catch (e) { /* the cache is optional */ }
    return out;
  })();
  vttBusy.set(key, p);
  p.then(() => vttBusy.delete(key), () => vttBusy.delete(key));
  return p;
}
// Hard subtitles: the cues are pulled out of the file as a subtitle file, and the
// encoder burns them into the picture. ffmpeg's subtitles filter wants a file on
// disk, so that is what this makes — one per file, kept.
const HARD_DIR = path.join(DATA, 'subs', 'hard');
// A cue file that is there but empty is no use: the extraction failed, and an
// empty file would look like "the subtitles are ready".
function hasCues(file) {
  try { return fs.statSync(file).size > 8; } catch (e) { return false; }
}
function srtPath(src, ord) {
  const key = crypto.createHash('md5').update(src + '#' + ord).digest('hex');
  return path.join(HARD_DIR, key + '.srt');
}
// The source cues are ASS in disguise: font tags, {\an8} placement, and — the
// bad one — song sections written with karaoke timing, which come out as a
// hundred one-character cues per second. Burnt, the characters stack into a
// wall of letters down the middle of the screen (and each one is drawn every
// frame, which chews the encoder). So a cue only survives if it reads like
// speech: few per second, placed at the bottom, and longer than a fragment.
function cleanSrt(text) {
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const parse = (b) => {
    const l = b.split('\n').find((x) => x.includes('-->'));
    if (!l) return null;
    const m = /^(\d+):(\d+):(\d+),/.exec(l);
    if (!m) return null;
    return { sec: (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) };
  };
  const per = new Map(); // second the cue starts in -> how many cues start there
  for (const b of blocks) { const p = parse(b); if (p) per.set(p.sec, (per.get(p.sec) || 0) + 1); }
  const keep = blocks.filter((b) => {
    const p = parse(b);
    if (!p) return false;
    if ((per.get(p.sec) || 0) > 4) return false;      // karaoke density: not speech
    if (/\{\\an[578]\}/.test(b)) return false;        // placed at the top of the picture
    const body = b.split('\n').slice(2).join(' ')
      .replace(/<\/?font[^>]*>/gi, '').replace(/\{[^}]*\}/g, '').trim();
    return body.length >= 3;                          // a wall of single letters
  });
  // The kept cues go out plain: the font tags carry faces that are not here
  // and sizes that are not wanted, and the {\...} overrides would do the same
  // thing in ASS syntax — the burn gets one size, from force_style.
  return keep.map((b, i) => (i + 1) + '\n' + b.replace(/^\d+\n/, '')
    .replace(/<\/?font[^>]*>/gi, '').replace(/\{[^}]*\}/g, '')).join('\n\n');
}
// The cues are timed against the whole file, but a live pipe starts partway
// into it and the picture's clock starts at zero there. So the cues move back
// by that much — the ones already past are dropped.
function srtStamp(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const ms = Math.round((ss - Math.floor(ss)) * 1000);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
    String(Math.floor(ss)).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}
function shiftSrt(text, seekSec) {
  if (!seekSec) return text;
  const out = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.indexOf('-->') >= 0);
    if (at < 0) { if (block.trim()) out.push(block); continue; }
    const m = /^(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)(.*)$/.exec(lines[at]);
    if (!m) { out.push(lines.join('\n')); continue; }
    const from = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 - seekSec;
    const to = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000 - seekSec;
    if (to <= 0) continue; // the line was said before the pipe started
    lines[at] = srtStamp(from) + ' --> ' + srtStamp(to) + (m[9] || '');
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}
// The shifted cues, kept beside the original.
function srtShiftPath(src, ord, tag) {
  const key = crypto.createHash('md5').update(src + '#' + ord + '#' + tag).digest('hex');
  return path.join(HARD_DIR, key + '.srt');
}
// How long the pipe waits for the cues before it plays without them.
const HARD_CUE_WAIT = 25000;
// The cues for the burn, as a file the subtitles filter can read. The pipe
// starts partway into the file, so the cues have to move to where it started —
// burn them as they are and the wrong line is on the picture.
// Returns the file to burn, or null when the cues are not there yet: they are
// then pulled out of the file in the background, and `late` is called when they
// land (so the pipe can be dropped and the viewers come back to one that has
// them burnt in).
async function hardCues(src, ord, seekSec, tracks, late) {
  const whole = srtPath(src, ord);
  if (hasCues(whole)) return shiftCues(src, ord, seekSec, whole, 'w');
  const p = extractSubs(src, (tracks || []).slice(0, 16), ord).then(() => (hasCues(whole) ? whole : null));
  if (late) p.then((f) => { if (f) late(); });
  const got = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), HARD_CUE_WAIT))]);
  return got ? shiftCues(src, ord, seekSec, whole, 'w') : null;
}
// A cleaned copy of the cues, kept beside them. The burn always reads this one:
// files written before the cleaning exist, and burned as-is they are the wall
// of letters on the screen.
function cleanCopy(src, ord, from) {
  const out = srtShiftPath(src, ord, 'c');
  if (!fs.existsSync(out)) {
    try {
      fs.mkdirSync(HARD_DIR, { recursive: true });
      fs.writeFileSync(out, cleanSrt(fs.readFileSync(from, 'utf8')));
    } catch (e) { return from; }
  }
  return out;
}
// The cues moved by so many seconds, in a file of their own.
function shiftCues(src, ord, by, from, tag) {
  const clean = cleanCopy(src, ord, from);
  if (!by) return clean;
  const out = srtShiftPath(src, ord, Math.round(by) + tag);
  if (!fs.existsSync(out)) {
    try {
      fs.mkdirSync(HARD_DIR, { recursive: true });
      fs.writeFileSync(out, shiftSrt(fs.readFileSync(clean, 'utf8'), by));
    } catch (e) { return from; }
  }
  return out;
}
// All the cues in one pass over the file: a WebVTT sidecar for each track (the
// viewer picks one) and an SRT for the burn when the subtitles are hard.
// Extracting them one at a time read the file once per track — an episode with
// six subtitle tracks was read six times over, which is what made the box crawl.
const subBusy = new Map();
function extractSubs(src, tracks, burnOrd) {
  const key = src + '#all';
  if (subBusy.has(key)) return subBusy.get(key);
  const p = (async () => {
    const abs = localAbs(src);
    if (!abs) return null;
    const args = ['-y', '-v', 'error', '-i', abs];
    let any = false;
    for (const t of tracks || []) {
      const vtt = vttPath(src, t.ord);
      if (fs.existsSync(vtt)) continue;
      args.push('-map', '0:s:' + t.ord, '-f', 'webvtt', vtt);
      any = true;
    }
    if (burnOrd >= 0 && !hasCues(srtPath(src, burnOrd))) {
      args.push('-map', '0:s:' + burnOrd, '-f', 'srt', srtPath(src, burnOrd));
      any = true;
    }
    if (!any) return null;
    try { fs.mkdirSync(SUB_DIR, { recursive: true }); fs.mkdirSync(HARD_DIR, { recursive: true }); } catch (e) {}
    const code = await runFfmpeg(args);
    // An extraction that got nothing leaves an empty file behind, and an empty
    // file looks like "the subtitles are there" to everything that comes after.
    if (burnOrd >= 0 && !hasCues(srtPath(src, burnOrd))) { try { fs.unlinkSync(srtPath(src, burnOrd)); } catch (e) {} }
    // The muxer copies the source's font tags into the SRT — strip them, or
    // the burn is gigantic (see cleanSrt).
    if (burnOrd >= 0 && hasCues(srtPath(src, burnOrd))) {
      const p = srtPath(src, burnOrd);
      try {
        const t = fs.readFileSync(p, 'utf8');
        const c = cleanSrt(t);
        if (c !== t) fs.writeFileSync(p, c);
      } catch (e) { /* the cues are a bonus */ }
    }
    return code === 0 ? true : null;
  })();
  subBusy.set(key, p);
  p.then(() => subBusy.delete(key), () => subBusy.delete(key));
  return p;
}
// The subtitles filter wants an ordinary path, and a colon in a path means
// something else to a filter graph.
function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
app.get('/api/tracks/vtt', (req, res) => {
  const src = String(req.query.src || '').slice(0, 800);
  const ord = parseInt(req.query.i, 10);
  const seek = Math.max(0, parseFloat(req.query.seek) || 0);
  if (!src || !isFinite(ord)) return res.status(400).type('text/plain').send('');
  let vtt = null;
  try { vtt = fs.readFileSync(vttPath(src, ord), 'utf8'); } catch (e) { /* not extracted yet */ }
  if (!vtt) {
    vttExtract(src, ord); // in the background — the viewer asks again in a moment
    return res.status(404).type('text/plain').send('');
  }
  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(shiftVtt(vtt, seek));
});

// --- mkv/avi → cached 480p mp4 (transcode once, serve to everyone) --------
// Browsers can't play mkv/avi, so we convert each local source ONCE to an H.264/AAC
// mp4 (downscaled to transcodeHeight) and stream that cached file to all viewers.
// A look-ahead ticker pre-transcodes the next few episodes of each channel; a byte
// budget evicts the oldest cached files (LRU) so disk stays bounded. Sources taller
// than transcodeMaxSourceHeight are skipped (decoding 4K is too costly) and bad /
// missing files are flagged so the admin can fix or remove them.
const E = require(path.join(__dirname, 'public', 'engine.js'));
let TC = null; // src -> { status, out, height, bytes, err, lastUsed, ... }
function tc() {
  if (!TC) { let s = {}; try { s = JSON.parse(fs.readFileSync(TRANSCODE_STORE, 'utf8')); } catch (e) { s = {}; } TC = s; }
  return TC;
}
function tcPersist() {
  try { fs.mkdirSync(path.dirname(TRANSCODE_STORE), { recursive: true }); fs.writeFileSync(TRANSCODE_STORE, JSON.stringify(TC, null, 2)); }
  catch (e) { console.error('transcode store save failed:', e.message); }
}
function tcEntry(src, patch) { TC = tc(); TC[src] = Object.assign({}, TC[src], patch, { at: Date.now() }); tcPersist(); return TC[src]; }
function needsTranscode(src) { return !!src && (src.startsWith('/content/') || src.startsWith('/movies/')) && TRANSCODE_SRC.test(src); }

function ffprobeMeta(absPath) {
  return new Promise((resolve, reject) => {
    let cmd;
    try { cmd = require('child_process').spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height,width', '-show_entries', 'format=duration', '-of', 'json', absPath]); }
    catch (e) { return reject(new Error('ffprobe not available')); }
    const t = setTimeout(() => { try { cmd.kill(); } catch (e) {} reject(new Error('probe timed out')); }, 15000);
    let out = '';
    cmd.on('error', () => { clearTimeout(t); reject(new Error('ffprobe failed')); });
    cmd.stdout.on('data', (d) => { out += d; });
    cmd.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const j = JSON.parse(out);
        const h = (j && j.streams && j.streams[0] && Number(j.streams[0].height)) || 0;
        const dur = Math.round(Number(j && j.format && j.format.duration) || 0);
        if (!h) throw new Error('no video stream');
        resolve({ duration: dur, height: h });
      } catch (e) { reject(new Error('could not read file: ' + e.message)); }
    });
  });
}
function runFfmpeg(args, onSpawn) {
  return new Promise((resolve) => {
    let cmd;
    try { cmd = require('child_process').spawn('ffmpeg', args); } catch (e) { return resolve(-1); }
    if (onSpawn) onSpawn(cmd);
    // Background work — the conversions and the cue extraction — runs at a low
    // priority. The live encodes are what people are watching, and they have to
    // keep up with the clock: when a conversion takes the cores, the picture
    // arrives late and the browser's two-second buffer runs dry.
    try { os.setPriority(cmd.pid, 19); } catch (e) { /* not permitted here */ }
    let stderr = '';
    cmd.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    const t = setTimeout(() => { try { cmd.kill('SIGKILL'); } catch (e) {} }, 6 * 3600 * 1000); // long marathons get hours
    cmd.on('error', () => { clearTimeout(t); resolve(-1); });
    cmd.on('close', (code) => { clearTimeout(t); if (code !== 0 && stderr) console.error('ffmpeg:', stderr.trim().split('\n').slice(-3).join(' | ')); resolve(code); });
  });
}

const manifestCache = new Map(); // key: channelId:v -> { manifest, mtime }
function loadManifest(channelId, v) {
  const key = channelId + ':' + v;
  const file = path.join(DATA, 'manifests', channelId, 'v' + v + '.json');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = manifestCache.get(key);
    if (hit && hit.mtime === mtime) return hit.manifest;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Clamp on read as well as on publish: a manifest published before the ceiling
    // existed still carries the bad length, and the guide is drawn from it.
    for (const it of manifest.items || []) it.duration = clampDuration(it.duration) || 1;
    manifestCache.set(key, { manifest, mtime });
    return manifest;
  } catch (e) { return null; }
}
function invalidateManifestCache() { manifestCache.clear(); }

// Transcode queue: priority queue sorted by "airs soonest first".
// Each entry: { src, airAt } — lower airAt = higher priority.
const tcQueue = new Map(); // src -> airAt
const tcCmds = new Map();  // src -> the ffmpeg converting it, so a live pipe can make it yield
// A src whose conversion was killed because a live pipe took over: its exit is
// a handoff, not a failure, so it is not marked bad.
const tcYielded = new Set();
// The source read is the bottleneck, not the encoder — so the conversions are
// done one at a time by default. Two at once was fine when the box was only
// running this, but a box that also runs Radarr, Sonarr and a usenet mount
// cannot spare the cores: the live encodes (which is what people are actually
// watching) fell behind the clock and the picture stuttered. TC_PARALLEL=2
// builds the cache faster and only ever runs while no pipe is up (see tcPump).
const TC_PARALLEL = Number(process.env.TC_PARALLEL) || 1;
// How long a failed conversion is left alone before it is tried again.
const TC_BAD_RETRY_MS = Math.max(0, Number(process.env.TC_BAD_RETRY_MS) || 60 * 60 * 1000);
let tcActive = 0;
// The settings that change what the converted file looks like: the language of
// the audio and of the subtitles, and whether the subtitles are burnt in. When
// they change, the file that was made with the old ones is not what is wanted
// any more, so it has to be made again.
function tcRecipe(src) {
  const s = getSettings();
  return [s.audioLanguage, s.audioFallback, s.subtitleLanguage, subtitleModeFor(src)].join('|');
}
function tcEnqueue(src, airAt) {
  if (!needsTranscode(src)) return;
  const st = tc()[src];
  // 'working' = an ffmpeg is on it right now; re-enqueuing spawns a duplicate process
  // writing the same .part (each tcTick re-adds in-flight items, which burned whole transcodes)
  if (st && (st.status === 'too_large' || st.status === 'working')) return;
  if (st && st.status === 'ready') {
    // A file made before these settings existed has no recipe, and was made with
    // the defaults — so it counts as a match and is not thrown away.
    if ((st.recipe || tcRecipe(src)) === tcRecipe(src)) return;
  }
  // A failure is not always final: the library is a usenet mount, and a file that is
  // still downloading reads as broken. Try it again after a while instead of
  // condemning the episode for good.
  if (st && st.status === 'bad' && Date.now() - (st.at || 0) < TC_BAD_RETRY_MS) return;
  // priority: lower airAt = sooner = higher priority. keep the best (earliest) airAt known.
  const prev = tcQueue.get(src);
  if (prev === undefined || (airAt !== undefined && airAt < prev)) tcQueue.set(src, airAt !== undefined ? airAt : Infinity);
  tcPump();
}
function tcPump() {
  // The queue reads the usenet mount at full speed, and the live pipe reads the
  // same mount at 1x. A pipe that stalls on the mount cannot catch up (-re paces
  // it to the clock), so while a pipe is up the queue holds — the 60-second tick
  // starts it again once the pipe is gone.
  if (livePipes.size || liveStarting.size) return;
  while (tcActive < TC_PARALLEL && tcQueue.size > 0) {
    // pick the queued src with the earliest airAt
    let bestSrc = null, bestAt = Infinity;
    for (const [src, at] of tcQueue) { if (at < bestAt) { bestAt = at; bestSrc = src; } }
    if (!bestSrc) break;
    tcQueue.delete(bestSrc);
    tcActive++;
    tcEntry(bestSrc, { status: 'working', startedAt: Date.now() });
    tcWork(bestSrc).finally(() => { tcActive--; tcEvict(); tcPump(); });
  }
}
async function tcWork(src) {
  const s = getSettings();
  const abs = srcToAbs(src);
  if (!abs) return tcEntry(src, { status: 'bad', err: 'unknown src (not under /content/ or /movies/)' });
  let st;
  try { st = fs.statSync(abs); } catch (e) { return tcEntry(src, { status: 'bad', err: 'file not found on disk' }); }
  if (!st.isFile()) { return tcEntry(src, { status: 'bad', err: 'not a readable file' }); }
  let meta;
  try { meta = await ffprobeMeta(abs); } catch (e) { return tcEntry(src, { status: 'bad', err: e.message }); }
  if (s.transcodeMaxSourceHeight > 0 && meta.height > s.transcodeMaxSourceHeight) {
    return tcEntry(src, { status: 'too_large', height: meta.height, err: 'source is ' + meta.height + 'p — over the ' + s.transcodeMaxSourceHeight + 'p limit, so it is not transcoded (raise the limit to stream it)' });
  }
  fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
  const key = crypto.createHash('md5').update(src).digest('hex');
  const final = path.join(TRANSCODE_DIR, key + '.mp4');
  const part = final + '.part';
  try { fs.unlinkSync(part); } catch (e) {}
  // The old file stays where it is until the new one is finished — the rename
  // below replaces it. Throwing it away first meant that a file being rebuilt
  // was not there for the viewers, and they fell back to the live encode.
  // Bounded threads for the same reason as the live pipe: this is background work
  // and must not take the box away from the web server (2.1 cores instead of 6+).
  const args = ['-y', '-v', 'error', '-threads', '2', '-i', abs, '-threads', '1', '-filter_threads', '1'];
  // Carry English if the file has it — that is what the viewer gets by default, and
  // what the cached mp4 is built from. Only when there is a choice to make. (An
  // explicit -map turns ffmpeg's automatic selection off, so the video is named too.)
  let subs = [];
  let tracks = null;
  try {
    tracks = await tracksFor(src);
    if (tracks.audio.length > 1) args.push('-map', '0:v:' + tracks.videoOrd, '-map', '0:a:' + audioOrd(tracks, s.audioLanguage, s.audioFallback));
    subs = tracks.subs || [];
  } catch (e) { /* no track info — ffmpeg picks the streams itself */ }
  const mode = subtitleModeFor(src);
  const vf = [];
  if (s.transcodeHeight > 0) vf.push('scale=-2:min(ih\\,' + s.transcodeHeight + ')');
  // The burn needs the cues before the encode starts, so they come out first —
  // and all of them in one pass over the file, because reading a five-gigabyte
  // episode once per subtitle track is what made the box crawl.
  const burnOrd = (mode === 'hard' && tracks) ? subOrd(tracks, s.subtitleLanguage) : -1;
  if (tracks && burnOrd >= 0) {
    try { await extractSubs(src, subs.slice(0, 16), burnOrd); }
    catch (e) { /* the subtitles are a bonus */ }
  }
  // The cleaned copy is what the burn reads — see cleanCopy. When the cleaning
  // leaves nothing (a track that was a song, not speech), the file is simply
  // not burnt: a clean picture beats a wall of letters.
  const burnFile = burnOrd >= 0 ? cleanCopy(src, burnOrd, srtPath(src, burnOrd)) : null;
  if (burnFile && hasCues(burnFile)) {
    // The size comes from here, one value: 30 renders to about 23px at 480p,
    // a normal line at the bottom.
    vf.push('subtitles=' + filterPath(burnFile) + ':force_style=Fontsize=30');
  }
  if (vf.length) args.push('-vf', vf.join(','));
  // -f mp4: the .part suffix would otherwise make ffmpeg guess the muxer from the extension
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', part);
  const code = await runFfmpeg(args, (cmd) => {
    tcCmds.set(src, cmd);
    cmd.once('close', () => tcCmds.delete(src));
  });
  if (tcYielded.has(src)) {
    // The live pipe for this file took over: the conversion gives way, and the
    // queue picks it up again once the pipe is gone. Not a failure.
    tcYielded.delete(src);
    tcEntry(src, { status: 'pending' });
    tcEnqueue(src, Date.now() - 60000);
    return;
  }
  if (code !== 0) { try { fs.unlinkSync(part); } catch (e) {} return tcEntry(src, { status: 'bad', err: 'transcode failed — file may be corrupt' }); }
  fs.renameSync(part, final);
  let bytes = 0; try { bytes = fs.statSync(final).size; } catch (e) {}
  tcEntry(src, { status: 'ready', out: key + '.mp4', height: meta.height, bytes, recipe: tcRecipe(src), readyAt: Date.now(), lastUsed: Date.now() });
  // The sidecars the viewer picks between come out in one pass, after the file
  // is made — the picture matters more than the subtitles.
  if (tracks && burnOrd < 0) {
    try { await extractSubs(src, subs.slice(0, 16), -1); }
    catch (e) { /* the subtitles are a bonus */ }
  }
}
// The items the look-ahead wants converted, and when each airs. The eviction keeps
// these longest: throwing one away means reading it from the usenet mount again,
// which is the slow wait we are trying to hide in the first place.
const tcWanted = new Map(); // src -> airAt (ms)
// Evict cached mp4s until under the byte budget. Evicted files re-transcode on demand
// if they come back around, so this is safe.
function tcEvict() {
  const budget = getSettings().transcodeCacheBytes;
  if (!budget) return;
  const s = tc();
  let total = 0;
  for (const k in s) if (s[k].status === 'ready') total += s[k].bytes || 0;
  if (total <= budget) return;
  // Throw away what nobody asked for first (oldest first), and only then the items
  // that air furthest in the future — the cache must not thrash itself, or it reads
  // the whole library off the mount forever.
  const unwanted = Object.keys(s).filter((k) => s[k].status === 'ready' && !tcWanted.has(k)).sort((a, b) => (s[a].lastUsed || 0) - (s[b].lastUsed || 0));
  const wanted = Object.keys(s).filter((k) => s[k].status === 'ready' && tcWanted.has(k)).sort((a, b) => (tcWanted.get(b) || 0) - (tcWanted.get(a) || 0));
  for (const k of unwanted.concat(wanted)) {
    if (total <= budget) break;
    try { fs.unlinkSync(path.join(TRANSCODE_DIR, s[k].out)); } catch (e) {}
    total -= s[k].bytes || 0;
    delete s[k];
  }
  tcPersist();
}
// Look-ahead: for each channel, enqueue the current + next `lookahead` items so the
// one about to air is already a streamable mp4. Only local mkv/avi get enqueued.
function tcTick() {
  tcWanted.clear();
  // Live streaming handles playback on demand, so the pre-transcode look-ahead queue
  // only runs when explicitly enabled (opt-in — off by default to spare CPU/disk).
  if (!getSettings().preTranscode) return;
  const look = getSettings().transcodeLookahead;
  const now = Date.now();
  let l; try { l = loadLineup(); } catch (e) { return; }
  const bump = l.bumpMs || 0;
  for (const ch of l.channels || []) {
    const v = E.activeVersion(ch, now);
    if (!v) continue;
    const mv = loadManifest(ch.id, v.v);
    if (!mv) continue;
    const items = mv.items || [];
    if (!items.length) continue;
    const pos = E.positionAt(mv, v, now, bump);
    const idx = (pos && (pos.index !== undefined)) ? pos.index : ((v.startIndex != null) ? v.startIndex : 0);
    const count = look + 1; // current + look ahead
    // compute airAt for each item so the queue prioritizes what's airing soonest
    let airAt = now;
    for (let k = 0; k < count; k++) {
      const it = items[(idx + k) % items.length];
      if (it && it.src) { tcWanted.set(it.src, airAt); tcEnqueue(it.src, airAt); }
      airAt += (it ? it.duration : 0) * 1000 + bump;
    }
  }
  // A queue entry for a file no channel wants any more would otherwise sit in
  // the queue with an old airAt — and the pump picks the earliest airAt first,
  // so those stale files burn whole mount reads and encodes AHEAD of what is
  // actually about to air. Drop them. (One tick late at worst: the pump only
  // runs while no pipe is up, and the next tick re-drops anything new.)
  for (const src of [...tcQueue.keys()]) {
    if (tcWanted.has(src)) continue;
    const st = tc()[src];
    if (st && st.status === 'working') continue; // an ffmpeg is on it: let it finish
    if (livePipes.has(src) || liveStarting.has(src)) continue;
    tcQueue.delete(src);
  }
}
function tcStartup() {
  fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
  for (const f of fs.readdirSync(TRANSCODE_DIR)) if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(TRANSCODE_DIR, f)); } catch (e) {} }
  TC = tc();
  for (const k in TC) if (TC[k].status === 'working') TC[k].status = 'pending'; // interrupted by a restart
  tcPersist();
  tcTick();
}
// player: is this source ready to stream, and where? (public — the TV needs it)
function transcodeStatus(req, res) {
  const s = tc();
  const one = String(req.query.src || '');
  if (one) { const e = s[one]; return res.json(e ? { src: one, ...e } : { src: one, status: 'unknown' }); }
  const many = String(req.query.srcs || '').split('|').filter(Boolean).slice(0, 300);
  const out = {};
  for (const src of many) out[src] = s[src] ? { ...s[src] } : { status: 'unknown' };
  res.json(out);
}
app.get('/api/transcode/status', transcodeStatus);
// The console asks for the same thing, and it is behind the admin password.
app.get('/api/admin/transcode/status', transcodeStatus);
// admin: what the transcode cache is doing right now — the store, summarised.
// Read-only; it changes nothing about how transcoding works.
app.get('/api/admin/transcodes', (req, res) => {
  const s = tc();
  const settings = getSettings();
  const items = [];
  let bytes = 0;
  const counts = { ready: 0, working: 0, pending: 0, bad: 0, too_large: 0, unknown: 0 };
  for (const src in s) {
    const e = s[src] || {};
    const st = e.status || 'unknown';
    counts[st] = (counts[st] || 0) + 1;
    if (e.bytes) bytes += e.bytes;
    items.push({
      src, status: st, bytes: e.bytes || 0, height: e.height || 0,
      err: e.err || '', at: e.at || 0, startedAt: e.startedAt || 0, lastUsed: e.lastUsed || 0
    });
  }
  // the recent ones and anything flagged — a full list of thousands is no use on a screen
  const flagged = items.filter((i) => i.status === 'bad' || i.status === 'too_large');
  const recent = items.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 60);
  const seen = new Set();
  const list = flagged.concat(recent).filter((i) => (seen.has(i.src) ? false : (seen.add(i.src), true)));
  // the real size of the folder, which also counts the in-flight .part files and any
  // orphans the store no longer lists — the store sum alone would over-report the room left
  let diskBytes = 0, orphanBytes = 0, partBytes = 0, orphanN = 0;
  const outs = new Set();
  for (const k in s) if (s[k] && s[k].out) outs.add(s[k].out);
  try {
    for (const f of fs.readdirSync(TRANSCODE_DIR)) {
      try {
        const sz = fs.statSync(path.join(TRANSCODE_DIR, f)).size;
        diskBytes += sz;
        if (f.endsWith('.part')) partBytes += sz;
        else if (!outs.has(f)) { orphanBytes += sz; orphanN++; }
      } catch (e) {}
    }
  } catch (e) { /* no cache folder yet */ }
  // what's on air or about to be, and what is only being kept because eviction
  // hasn't got round to it — that is the space worth giving back
  let wanted = 0, wantedBytes = 0, spare = 0, spareBytes = 0;
  for (const k in s) {
    if (s[k].status !== 'ready') continue;
    if (tcWanted.has(k)) { wanted++; wantedBytes += s[k].bytes || 0; }
    else { spare++; spareBytes += s[k].bytes || 0; }
  }
  const biggest = items.filter((i) => i.status === 'ready').sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 8);
  res.json({
    counts, bytes, diskBytes, cacheBytes: settings.transcodeCacheBytes || 0,
    queue: tcQueue.size, active: tcActive, total: items.length, list: list.slice(0, 200),
    wanted, wantedBytes, spare, spareBytes, orphanBytes, orphanN, partBytes, biggest
  });
});
// Give the disk back: drop the cached mp4s nobody is waiting for. Eviction only runs
// once the cache is over its limit, so a cache sitting just under the line keeps
// files that played weeks ago. This throws the idle ones out now.
// minAgeMs keeps the files that have just aired — somebody rewinding wants them.
function tcPrune(keepAll, minAgeMs) {
  const s = tc();
  const now = Date.now();
  let freed = 0, removed = 0;
  for (const k of Object.keys(s)) {
    if (s[k].status !== 'ready') continue;
    if (!keepAll && tcWanted.has(k)) continue;
    if (minAgeMs && now - (s[k].lastUsed || s[k].at || 0) < minAgeMs) continue;
    if (s[k].out) { try { fs.unlinkSync(path.join(TRANSCODE_DIR, s[k].out)); } catch (e) {} }
    freed += s[k].bytes || 0;
    delete s[k];
    removed++;
  }
  if (removed) tcPersist();
  return { removed, freed };
}
app.post('/api/admin/transcodes/prune', (req, res, next) => {
  try {
    const keepAll = !!(req.body && req.body.all);
    res.json(Object.assign({ ok: true }, tcPrune(keepAll, 0)));
  } catch (e) { next(e); }
});
// ...and do it on a timer, so the cache does not quietly fill with old episodes.
const TC_PRUNE_MS = Math.max(60000, Number(process.env.TC_PRUNE_MS) || 15 * 60 * 1000);
setInterval(() => { try { tcPrune(false, 30 * 60 * 1000); } catch (e) { console.error('cache prune failed:', e.message); } }, TC_PRUNE_MS).unref();
app.post('/api/admin/transcode/recheck', (req, res, next) => {
  try {
    const l = loadLineup();
    const ch = l.channels.find((c) => c.id === String(req.body && req.body.channel));
    if (!ch) throw Object.assign(new Error('channel not found'), { status: 404 });
    const show = (ch.shows || []).find((s2) => s2.id === String(req.body && req.body.showId));
    if (!show) throw Object.assign(new Error('show not found'), { status: 404 });
    const only = req.body && req.body.src ? String(req.body.src) : '';
    let n = 0;
    for (const e of show.episodes || []) {
      if (!e.src) continue;
      if (only && e.src !== only) continue;
      const st = tc()[e.src];
      if (st && (st.status === 'bad' || st.status === 'too_large')) { tcEntry(e.src, { status: 'pending', err: null }); tcEnqueue(e.src); n++; }
    }
    tcPump();
    res.json({ ok: true, requeued: n });
  } catch (e) { next(e); }
});

// --- the flags: every file the cache has given up on, and where it lives ----
// One list across every channel, so a broken file can be found and fixed from
// one place instead of by hunting through each channel's shows.
app.get('/api/admin/flags', (req, res) => {
  const l = loadLineup();
  const s = tc();
  const out = [];
  for (const ch of l.channels || []) {
    for (const show of ch.shows || []) {
      for (const ep of show.episodes || []) {
        if (!ep.src) continue;
        const st = s[ep.src] || null;
        const status = st ? st.status : '';
        if (status !== 'bad' && status !== 'too_large') continue;
        out.push({
          channel: ch.id, channelName: ch.name, dial: ch.dial,
          showId: show.id, showName: show.name,
          title: ep.title || '', src: ep.src, status,
          err: (st && st.err) || '', height: (st && st.height) || 0
        });
      }
    }
  }
  res.json({ total: out.length, list: out.slice(0, 300) });
});

// --- the removal log: what was taken out of the library, and why -------------
const REMOVED_STORE = path.join(DATA, 'removed.json');
let REMOVED = null;
function removedLog() {
  if (!REMOVED) { try { REMOVED = JSON.parse(fs.readFileSync(REMOVED_STORE, 'utf8')); } catch (e) { REMOVED = []; } }
  return REMOVED;
}
function removedAdd(entry) {
  const log = removedLog();
  log.unshift(Object.assign({ at: Date.now() }, entry));
  if (log.length > 500) log.length = 500;
  try { fs.writeFileSync(REMOVED_STORE, JSON.stringify(log)); } catch (e) { console.error('removed log save failed:', e.message); }
}
app.get('/api/admin/flags/removed', (req, res) => {
  res.json({ log: removedLog().slice(0, 100) });
});
// Take the unplayable files out for good: out of the queue, out of the cache
// store, and out of the shows that carry them — with the reason kept on record.
app.post('/api/admin/flags/purge', (req, res, next) => {
  try {
    const { src, all } = req.body || {};
    const s = tc();
    const targets = [];
    if (all) {
      for (const k in s) if (s[k].status === 'bad' || s[k].status === 'too_large') targets.push(k);
    } else if (src) targets.push(String(src));
    if (!targets.length) return res.json({ ok: true, removed: 0, episodes: 0, freed: 0, log: removedLog().slice(0, 100) });
    const set = new Set(targets);
    const l = loadLineup();
    const touched = new Set();
    let episodes = 0;
    const fromBySrc = new Map();
    for (const ch of l.channels || []) {
      for (const show of ch.shows || []) {
        const before = (show.episodes || []).length;
        const keep = [];
        for (const e of show.episodes || []) {
          if (set.has(e.src)) {
            episodes++;
            if (!fromBySrc.has(e.src)) fromBySrc.set(e.src, []);
            fromBySrc.get(e.src).push({ channel: ch.name, show: show.name });
          } else keep.push(e);
        }
        if (keep.length === before) continue;
        show.episodes = keep;
        touched.add(ch.id);
      }
    }
    let freed = 0, removed = 0;
    for (const k of targets) {
      const e = s[k];
      const err = (e && e.err) || '';
      if (e) {
        if (e.out) { try { fs.unlinkSync(path.join(TRANSCODE_DIR, e.out)); } catch (x) {} }
        freed += e.bytes || 0;
        delete s[k];
        removed++;
      }
      tcQueue.delete(k);
      tcWanted.delete(k);
      removedAdd({ src: k, err, reason: err || 'unplayable file', from: fromBySrc.get(k) || [] });
    }
    tcPersist();
    if (touched.size) { saveLineup(l); for (const id of touched) io.emit('lineup:update', { updated: id }); }
    res.json({ ok: true, removed, episodes, freed, log: removedLog().slice(0, 100) });
  } catch (e) { next(e); }
});

// take one episode out of a show
app.post('/api/admin/channel/shows/episode/remove', (req, res, next) => {
  try {
    const { channel, showId, src } = req.body || {};
    const l = loadLineup(); const ch = channelOrThrow(l, channel);
    const show = (ch.shows || []).find((s2) => s2.id === String(showId));
    if (!show) throw Object.assign(new Error('show not found'), { status: 404 });
    const before = (show.episodes || []).length;
    show.episodes = (show.episodes || []).filter((e) => e.src !== src);
    if (show.episodes.length === before) throw Object.assign(new Error('episode not found'), { status: 404 });
    saveLineup(l);
    io.emit('lineup:update', { updated: ch.id });
    res.json({ ok: true, left: show.episodes.length });
  } catch (e) { next(e); }
});

// point one episode at a different file — the old file was a dud, this is its replacement
app.post('/api/admin/channel/shows/episode/replace', (req, res, next) => {
  try {
    const { channel, showId, src, newSrc } = req.body || {};
    const l = loadLineup(); const ch = channelOrThrow(l, channel);
    const show = (ch.shows || []).find((s2) => s2.id === String(showId));
    if (!show) throw Object.assign(new Error('show not found'), { status: 404 });
    const ep = (show.episodes || []).find((e) => e.src === src);
    if (!ep) throw Object.assign(new Error('episode not found'), { status: 404 });
    const next_ = String(newSrc || '').trim();
    if (!next_) throw Object.assign(new Error('no replacement file'), { status: 400 });
    ep.src = next_.slice(0, 600);
    ep.duration = undefined; // measured again on the next build
    saveLineup(l);
    io.emit('lineup:update', { updated: ch.id });
    res.json({ ok: true, src: ep.src });
  } catch (e) { next(e); }
});

// re-measure one file: it may have finished downloading, or the library may be
// serving it now. The old measurement is dropped so the probe actually runs.
app.post('/api/admin/episode/rescan', async (req, res, next) => {
  try {
    const { channel, showId, src } = req.body || {};
    const l = loadLineup(); const ch = channelOrThrow(l, channel);
    const show = (ch.shows || []).find((s2) => s2.id === String(showId));
    if (!show) throw Object.assign(new Error('show not found'), { status: 404 });
    const ep = (show.episodes || []).find((e) => e.src === src);
    if (!ep) throw Object.assign(new Error('episode not found'), { status: 404 });
    const d = durs();
    delete d[ep.src];
    durPersist();
    let duration = null, error = null;
    try { duration = await probeDuration(ep.src); } catch (e) { error = e.message; }
    if (duration) {
      ep.duration = clampDuration(duration);
      d[ep.src] = duration;
      durPersist();
      tcEntry(ep.src, { status: 'pending', err: null });
      tcEnqueue(ep.src);
      tcPump();
    }
    saveLineup(l);
    io.emit('lineup:update', { updated: ch.id });
    res.json({ ok: !error, duration: duration || 0, error: error || '' });
  } catch (e) { next(e); }
});
// cached mp4s; touch lastUsed so LRU eviction keeps what's actually being watched
app.use('/transcodes', (req, res, next) => {
  const file = req.path.replace(/^\//, '');
  const s = tc();
  for (const k in s) if (s[k].out === file && s[k].status === 'ready') { s[k].lastUsed = Date.now(); break; }
  next();
}, express.static(TRANSCODE_DIR));

// --- live streaming transcode (Plex-style): spawn ffmpeg on demand, pipe to client ---
// Used when a file isn't in the pre-transcode cache yet. Starts in ~2s instead of
// waiting for the whole file to encode. CPU scales with viewers, not channels.
const liveCmds = new Set();    // active ffmpeg child processes (one per live pipe)
// A file ffmpeg can't read dies the moment it starts, and the client reconnects — a
// tight loop that spawned hundreds of encodes and took the box down. Count the
// failures per src and refuse that src for a while, so the loop costs one
// request per window instead of hundreds of processes.
const liveFails = new Map();   // src -> { n, until }
const LIVE_FAIL_WINDOW = 60 * 1000;
const LIVE_FAIL_MAX = 3;
// Did this stream carry any video? A fragmented MP4 is a chain of top-level boxes:
// ftyp, moov, then a moof per media fragment. A seek past the end of the file emits
// only the init segment (ftyp+moov, no moof) and an unreadable file emits nothing —
// and ffmpeg exits 0 for the first one, so the exit code can't tell them apart.
// The box chain can, and it does not misfire on the last sliver of a valid file
// (which is a few KB but still has a moof).
// Returns true (played), false (played nothing) or null (can't tell).
function mp4HasFragment(buf) {
  let off = 0;
  while (off < buf.length) {
    if (off + 8 > buf.length) return null;       // partial box header
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'moof') return true;
    if (size === 1 || size < 8) return null;      // 64-bit size, or malformed
    if (off + size > buf.length) return null;     // box not fully buffered yet
    off += size;
  }
  return false;                                   // clean end of chain, no fragment
}
function liveBlocked(src) {
  const f = liveFails.get(src);
  if (!f) return false;
  if (f.until > Date.now()) return true;
  if (f.n && Date.now() - f.at > LIVE_FAIL_WINDOW) liveFails.delete(src);
  return false;
}
function noteLiveFail(src) {
  const f = liveFails.get(src) || { n: 0, at: Date.now(), until: 0 };
  f.n++; f.at = Date.now();
  if (f.n >= LIVE_FAIL_MAX) { f.until = Date.now() + LIVE_FAIL_WINDOW; f.n = 0; }
  liveFails.set(src, f);
}
// --- live streaming, shared: one encode per file, everybody watching it -------
// Every viewer of a channel is at the same place in the broadcast — it is a
// clock, after all — so they can all watch the same pipe. A thousand people,
// one ffmpeg. Before this, each viewer started their own, which meant a busy
// channel could run out of live streams and send people back to the start of
// the episode.
const livePipes = new Map();      // src -> pipe
const liveStarting = new Map();  // src -> the pipe being started right now
const LIVE_PIPE_TOLERANCE = 12;   // seconds: how far a viewer may be from the pipe
const LIVE_PIPE_STALE = 15000;    // ms with no output = the pipe is dead
const LIVE_PIPE_MAX_BUF = 8 * 1024 * 1024; // a viewer that stops reading is dropped
// How long a pipe stays up after the last viewer leaves. A viewer that comes
// straight back (the picture hiccuped and it reconnects) rejoins that pipe
// instead of waiting for a new one to start up.
const LIVE_PIPE_KEEPALIVE = 20000;

// Where in the file the pipe is now. The pipe reads at 1x (-re), so this is the
// broadcast position too — a viewer joining now is exactly where everyone else is.
function pipePos(pipe, now) { return pipe.seek + (now - pipe.startedAt) / 1000; }
function killPipe(pipe) {
  if (!pipe || pipe.killed) return;
  pipe.killed = true;
  liveCmds.delete(pipe.cmd);
  try { pipe.cmd.kill('SIGTERM'); } catch (e) {}
}
function endPipe(pipe) {
  for (const v of pipe.viewers) { try { v.end(); } catch (e) {} }
  for (const v of pipe.waiting) { try { v.end(); } catch (e) {} }
  pipe.viewers.clear();
  pipe.waiting.clear();
}
function dropViewer(pipe, res) {
  pipe.viewers.delete(res);
  pipe.waiting.delete(res);
  // Nobody is watching any more — but the pipe is not killed straight away. A
  // viewer whose picture hiccuped reconnects a second later, and if the pipe were
  // gone it would have to start again from scratch: two seconds of nothing, and
  // the picture stutters again. So the pipe waits a little, and is only killed
  // if nobody comes back.
  if (pipe.viewers.size || pipe.waiting.size || pipe.stdoutEnded) return;
  if (pipe.killTimer) return;
  pipe.killTimer = setTimeout(() => {
    pipe.killTimer = null;
    if (pipe.viewers.size || pipe.waiting.size || pipe.stdoutEnded) return;
    killPipe(pipe);
    if (livePipes.get(pipe.src) === pipe) livePipes.delete(pipe.src);
  }, LIVE_PIPE_KEEPALIVE);
  if (pipe.killTimer.unref) pipe.killTimer.unref();
}
// The init segment (ftyp+moov) is written once, at the start. A viewer who joins
// later needs it before the live fragments, or the browser has nothing to decode.
// Where a box starts. A box is [size:4][type:4][payload], so the size sits
// four bytes before the type — and it is the size that has to be kept with the
// box, or the chain is cut and the browser says "header damaged".
function findBox(buf, type) {
  const at = buf.indexOf(Buffer.from(type));
  if (at < 4) return -1;
  const size = buf.readUInt32BE(at - 4);
  return (size >= 8 && size <= buf.length + 4096) ? at - 4 : -1;
}
async function startLivePipe(src, abs, seekSec) {
  const s = getSettings();
  const height = s.transcodeHeight > 0 ? s.transcodeHeight : 0;
  // A conversion of this very file running right now would fight the pipe over
  // the same mount for the rest of the episode. The pipe is what the viewer is
  // watching, so the conversion gives way — and the queue picks it up again
  // once the pipe is gone.
  const conv = tcCmds.get(src);
  if (conv) {
    tcYielded.add(src);
    tcCmds.delete(src);
    try { conv.kill('SIGKILL'); } catch (e) {}
  }
  // Somebody is watching this file right now, so it goes to the front of the
  // pre-convert queue: the cached copy (with the subtitles burnt in) is the
  // one that plays without a hitch.
  tcEnqueue(src, Date.now() - 60000);
  const args = ['-y', '-v', 'error'];
  // Bound the encoder. ffmpeg grabs every core by default, so on an 8-core box a
  // handful of live pipes starve the web server (and each other): the page loads
  // slow and the streams start slow. Measured on a 1080p source: 6.2 cores
  // unbounded, 1.7 with these limits — and still 6x faster than playback needs.
  args.push('-threads', '2'); // decoder
  if (seekSec > 0) args.push('-ss', String(seekSec));
  // -re reads the source at its own rate, so the pipe runs at 1x and stays in step
  // with the broadcast clock. Without it ffmpeg races ahead of the clock, and a
  // viewer joining an existing pipe would be that far ahead of everyone else.
  args.push('-re');
  args.push('-i', abs);
  // Audio: the language the site is set to, where the file has it. The track list
  // is cached from the pre-convert, so this is normally a lookup — and if it
  // isn't known yet the stream starts on ffmpeg's own pick while the probe
  // catches up behind it.
  let tr = tracksCached(src);
  if (!tr) {
    // The track list is what says which audio to play. Without it ffmpeg picks
    // the audio itself, and it picks the wrong one: the Czech track of an
    // American Dad episode, the Spanish one of an anime. So wait for the probe
    // rather than guess — it takes a moment on a local file and the tuning
    // screen covers the wait. If it does not come back in time, ffmpeg's own
    // pick is used and the probe carries on in the background for the next viewer.
    tr = await Promise.race([
      tracksFor(src, true).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 8000))
    ]);
    if (!tr) probeTracksLater(src);
  }
  if (tr && tr.audio.length > 1) {
    // The video is named too: an explicit -map turns ffmpeg's automatic selection off.
    args.push('-map', '0:v:' + tr.videoOrd, '-map', '0:a:' + audioOrd(tr, s.audioLanguage, s.audioFallback));
  }
  args.push('-threads', '1', '-filter_threads', '1'); // encoder + scaling
  // A keyframe every second and a bit. The output is fragmented at keyframes
  // only, so with the default 10-second GOP the first picture would not arrive
  // until ten seconds of the episode had been read — and the pipe now reads at
  // 1x, so that is ten seconds of waiting.
  args.push('-g', '30');
  const vf = [];
  if (height > 0) vf.push('scale=-2:min(ih\\,' + height + ')');
  let pipeRef = null; // the pipe, once it exists — the cues may land later
  if (subtitleModeFor(src) === 'hard' && tr) {
    const ord = subOrd(tr, s.subtitleLanguage);
    if (ord >= 0) {
      // The cues for the burn: they are timed against the whole file, and the
      // pipe starts partway into it, so they have to move to where it started.
      const cues = await hardCues(src, ord, seekSec, tr.subs || [], () => {
        // They are here now, but this pipe started without them: drop it, so
        // the viewers come back to one that has them burnt in.
        const p = pipeRef;
        if (!p || (!p.viewers.size && !p.waiting.size)) return;
        killPipe(p); endPipe(p);
        if (livePipes.get(src) === p) livePipes.delete(src);
      });
      // Same one size for the burn as for the pre-convert: see tcWork.
      if (cues) vf.push('subtitles=' + filterPath(cues) + ':force_style=Fontsize=30');
    }
  }
  if (vf.length) args.push('-vf', vf.join(','));
  // fast encode: ultrafast + crf 28 + 1Mbps cap — 480p is plenty for a TV clone.
  // fragmented MP4 (empty_moov + frag_keyframe) so the browser can start playing as data arrives
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-maxrate', '1000k', '-bufsize', '2000k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  let cmd;
  try { cmd = require('child_process').spawn('ffmpeg', args); }
  catch (e) { return null; }
  liveCmds.add(cmd);
  const pipe = {
    src, cmd, viewers: new Set(), waiting: new Set(),
    seek: seekSec, startedAt: Date.now(), lastOut: Date.now(),
    init: Buffer.alloc(0), initDone: false, head: Buffer.alloc(0), errText: '',
    stdoutEnded: false, killed: false, killTimer: null
  };
  pipeRef = pipe;
  const HEAD_MAX = 256 * 1024;
  cmd.stdout.on('data', (d) => {
    pipe.lastOut = Date.now();
    // The init segment (ftyp+moov) is written once, at the start. A viewer who
    // joins later needs it before the live fragments, or the browser has
    // nothing to decode — so it is kept aside and sent to them on their own.
    let body = d;
    if (!pipe.initDone) {
      const at = findBox(d, 'moof');
      if (at >= 0) {
        // The init is everything before the first fragment — the file header,
        // whole. The fragment itself keeps its size with it.
        pipe.init = Buffer.concat([pipe.init, d.slice(0, at)]);
        pipe.initDone = true;
        body = d.slice(at); // the first moof onwards — the init went out above
        for (const v of pipe.waiting) {
          try { v.write(pipe.init); } catch (e) {}
          pipe.viewers.add(v);
        }
        pipe.waiting.clear();
      } else {
        pipe.init = Buffer.concat([pipe.init, d]);
        body = Buffer.alloc(0); // nothing but the init so far — the viewers wait
      }
    }
    if (pipe.head.length < HEAD_MAX) pipe.head = Buffer.concat([pipe.head, d]).slice(0, HEAD_MAX);
    for (const v of pipe.viewers) {
      if (v.writableEnded || v.destroyed) { pipe.viewers.delete(v); continue; }
      // a viewer that stops reading must not hold the whole pipe up
      if (v.writableLength > LIVE_PIPE_MAX_BUF) { pipe.viewers.delete(v); try { v.end(); } catch (e) {} continue; }
      try { v.write(body); } catch (e) { pipe.viewers.delete(v); }
    }
  });
  cmd.stdout.on('end', () => { pipe.stdoutEnded = true; });
  // ffmpeg's stderr says why it stopped. "Broken pipe" means the client hung up
  // (ffmpeg exits non-zero for that too), anything else is about the file.
  cmd.stderr.on('data', (d) => { if (pipe.errText.length < 4096) pipe.errText += d.toString('utf8'); });
  cmd.on('error', () => { pipe.stdoutEnded = true; endPipe(pipe); });
  cmd.on('close', (code, signal) => {
    pipe.stdoutEnded = true;
    liveCmds.delete(cmd);
    if (livePipes.get(src) === pipe) livePipes.delete(src);
    // ffmpeg died on a signal: we killed it (the viewer left), the client hung up
    // (SIGPIPE), or the OOM killer got it. None of those say the file is bad.
    if (signal) { endPipe(pipe); return; }
    // Judge on the next tick, so the response's own close event has landed: a
    // viewer leaving mid-stream must not be counted against the file.
    setImmediate(() => {
      // A broken pipe means the viewer went away mid-stream, not that the file is
      // bad — ffmpeg exits non-zero for that too.
      if (/Broken pipe|Connection reset/i.test(pipe.errText)) { endPipe(pipe); return; }
      // Did anything playable come out? A fragmented MP4 carries a 'moof' box per
      // media fragment: a valid file has one even in its last sliver, a seek past
      // the end yields only the init segment (ftyp+moov), and a file ffmpeg cannot
      // read yields nothing at all. The exit code can't tell the first two apart
      // (both are 0), so the box chain is what decides.
      const played = mp4HasFragment(pipe.head);
      if (played === true) liveFails.delete(src);   // it played fine — clear any earlier strikes
      else if (played === false) noteLiveFail(src);  // it delivered nothing — that's the loop
      endPipe(pipe);
    });
  });
  return pipe;
}
function attachViewer(pipe, res) {
  if (pipe.killTimer) { clearTimeout(pipe.killTimer); pipe.killTimer = null; }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  if (pipe.initDone) { try { res.write(pipe.init); } catch (e) {} pipe.viewers.add(res); }
  else pipe.waiting.add(res);
  const drop = () => dropViewer(pipe, res);
  res.on('close', drop);
  res.on('finish', drop);
}
app.get('/stream/live', async (req, res) => {
  const src = String(req.query.src || '');
  const seekSec = Math.max(0, parseInt(req.query.seek) || 0);
  const abs = srcToAbs(src);
  if (!abs) return res.status(400).json({ error: 'unknown src' });
  try { fs.accessSync(abs, fs.constants.R_OK); } catch (e) { return res.status(404).json({ error: 'file not found' }); }
  if (liveBlocked(src)) {
    return res.status(503).json({ error: 'this file keeps failing to play — flagged as broken' });
  }
  const now = Date.now();
  let pipe = livePipes.get(src);
  if (pipe) {
    const stale = now - pipe.lastOut > LIVE_PIPE_STALE;
    const off = Math.abs(pipePos(pipe, now) - seekSec);
    if (stale || pipe.cmd.exitCode !== null || off > LIVE_PIPE_TOLERANCE) {
      // the pipe is dead, or this viewer wants a different place in the file
      killPipe(pipe);
      endPipe(pipe);
      if (livePipes.get(src) === pipe) livePipes.delete(src);
      pipe = null;
    }
  }
  if (!pipe) {
    // The cap is on pipes now, not on viewers: one channel, one encode.
    const max = getSettings().liveStreamMax;
    if (liveCmds.size >= max) {
      return res.status(503).json({ error: 'too many live streams — try again in a moment' });
    }
    // Starting a pipe takes a moment (the track list is probed first), and two
    // viewers arriving together both found no pipe and both started one — two
    // encoders for one channel, and the first one left running with nobody
    // watching it. The second waits for the first instead.
    let starting = liveStarting.get(src);
    if (!starting) {
      starting = startLivePipe(src, abs, seekSec).catch(() => null);
      liveStarting.set(src, starting);
    }
    pipe = await starting;
    liveStarting.delete(src);
    if (!pipe) return res.status(503).json({ error: 'ffmpeg unavailable' });
    livePipes.set(src, pipe);
  }
  attachViewer(pipe, res);
});

// --- local library: browse + bulk import -----------------------------------
const VIDEO_EXT = /\.(mp4|mkv|avi|mov|webm|flv|wmv|mpg|mpeg|m4v|ts)$/i;
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
// The walk is async on purpose: the library is a usenet mount, so listing it takes
// seconds, and doing that synchronously froze the whole server (the admin page's own
// requests queued behind it). Async keeps the event loop free while it walks.
async function buildTree(base, rel, depth, budget, preferMp4) {
  if (depth > 6) return null;
  let entries; try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch (e) { return null; }
  const dirs = [], files = [];
  for (const en of entries) {
    if (en.name.startsWith('.')) continue;
    const abs = path.join(base, en.name);
    const relp = rel ? rel + '/' + en.name : en.name;
    // Symlink-heavy library (nzbdav/rclone): the link target is remote, so we must NOT
    // stat a symlink (that's a network call, and recursing into a linked dir lists a huge
    // remote store — both were the 60s+ hangs). The dirent classifies locally: a real dir is
    // recursed into; a video-named entry (real file or link) is a leaf. We stat only real
    // (local) files for size; a link's size stays 0 (read later, per-file, when played).
    if (en.isDirectory()) {
      const node = await buildTree(abs, relp, depth + 1, budget, preferMp4);
      if (node) dirs.push(node);
    } else if ((en.isFile() || en.isSymbolicLink()) && VIDEO_EXT.test(en.name) && budget.count < 100000) {
      let size = 0; if (en.isFile()) { try { size = (await fs.promises.stat(abs)).size; } catch (e) {} }
      files.push({ type: 'file', name: en.name, path: relp, size }); budget.count++;
    }
  }
  dirs.sort((x, y) => natural(x.name, y.name));
  files.sort((x, y) => natural(x.name, y.name));
  // A folder often holds both a converted .mp4 and the original .mkv/.avi of the same
  // video. Browsers can't play the latter, so when both exist we prefer the mp4 and hide
  // the other formats of that same video. A base name with only an .mkv/.avi is kept.
  let shown = files;
  if (preferMp4) {
    const baseOf = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
    const mp4Bases = new Set(files.filter((f) => /\.mp4$/i.test(f.name)).map((f) => baseOf(f.name)));
    shown = files.filter((f) => /\.mp4$/i.test(f.name) || !mp4Bases.has(baseOf(f.name)));
  }
  if (!dirs.length && !shown.length) return null;
  return { type: 'dir', name: path.basename(base), path: rel || '', children: [...dirs, ...shown] };
}
async function mediaTree(req, res, next) {
  try {
    const showAll = String(req.query.all || '').toLowerCase() === '1' || String(req.query.all || '').toLowerCase() === 'true';
    const isMovies = String(req.query.root || '') === 'movies' && fs.existsSync(MOVIES_DIR);
    const base = isMovies ? MOVIES_DIR : CONTENT_DIR;
    const tree = await buildTree(base, '', 0, { count: 0 }, !showAll);
    res.json({ root: isMovies ? 'movies' : 'tv', path: base, tree });
  }
  catch (e) { next(e); }
}
app.get('/api/media/tree', mediaTree);
// The same tree, behind the admin password: the console needs it, and the
// console is not behind the site password.
app.get('/api/admin/media/tree', mediaTree);

// --- shows (per-channel playlists) + build ---------------------------------
function channelOrThrow(l, id) {
  const ch = l.channels.find(c => c.id === String(id));
  if (!ch) throw Object.assign(new Error('channel not found'), { status: 404 });
  return ch;
}
function makeCommercial(chName, dur) {
  const n = chName || 'this channel';
  return { title: 'Commercial', src: '', duration: Math.max(5, Math.round(dur) || 15), isAd: true, year: '',
    adSlides: [`you're watching ${n}.`, 'brought to you by the local network.', 'this break is paid for in coffee. ☕', 'stay tuned — it gets weirder by channel 5.'],
    music: '/media/ad-music.mp3' };
}
// admin left the name blank? derive it from the first selected file —
// "South Park (1997) {tvdb-75897}/Season 01/…" → "South Park"; a movie file → "10 Cloverfield Lane"
function guessShowName(files, inEps) {
  let base = '';
  if (Array.isArray(inEps) && inEps.length && inEps[0] && inEps[0].title) base = String(inEps[0].title);
  else if (Array.isArray(files) && files.length) base = String(files[0]).split('/').filter(Boolean)[0] || '';
  base = String(base).replace(/\.[^.]+$/, '');
  // strip up to two trailing bracket groups: (2008) {imdb-tt…} / [1080p]
  base = base.replace(/\s*[({\[][^(){}[\]]*[)}\]]\s*$/, '').replace(/\s*[({\[][^(){}[\]]*[)}\]]\s*$/, '').replace(/\s+/g, ' ').trim();
  return base || 'Show';
}
function addShow(channelId, { name, files, episodes: inEps, root }) {
  const l = loadLineup(); const ch = channelOrThrow(l, channelId);
  let episodes;
  if (Array.isArray(inEps) && inEps.length) {
    // pre-resolved (e.g. archive.org import): trust the given title/src/duration
    episodes = inEps.slice(0, 1000).map((e) => ({
      title: String((e && e.title) || 'Episode').slice(0, 120),
      src: String((e && e.src) || '').slice(0, 600),
      duration: clampDuration(e && e.duration) || undefined
    })).filter((e) => e.src);
  } else {
    files = Array.isArray(files) ? files : [];
    if (!files.length) throw Object.assign(new Error('select at least one file'), { status: 400 });
    const prefix = root === 'movies' ? '/movies/' : '/content/';
    episodes = files.slice(0, 1000).map((p) => {
      const rel = String(p).replace(/^\/+/, '');
      return { title: rel.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), src: prefix + rel };
    });
  }
  if (!episodes.length) throw Object.assign(new Error('no episodes to add'), { status: 400 });
  ch.shows = ch.shows || [];
  const show = { id: 'show-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: (String(name || '').trim() || guessShowName(files, inEps)).slice(0, 60), episodes };
  ch.shows.push(show);
  saveLineup(l);
  io.emit('lineup:update', { updated: ch.id });
  return show;
}
function removeShow(channelId, showId) {
  const l = loadLineup(); const ch = channelOrThrow(l, channelId);
  ch.shows = (ch.shows || []).filter(s => s.id !== showId);
  saveLineup(l);
  io.emit('lineup:update', { updated: ch.id });
  return { ok: true };
}
// Duration cache (data/durations.json): probe results keyed by src, shared across every
// build + generate, so a file is only ever ffprobed once.
//   > 0  a real measurement (in seconds)
//   < 0  the probe failed at -value (epoch ms) — retry it at most every PROBE_RETRY_MS,
//        so a file the library can't serve doesn't stall every rebuild
// The old cache stored the 30-minute fallback as if it were a measurement, which froze
// broken files at 30 minutes forever; migrateDurations() re-queues those once.
const DUR_STORE = path.join(DATA, 'durations.json');
const PROBE_RETRY_MS = 6 * 3600 * 1000;
let DUR = null;
function durs() { if (!DUR) { try { DUR = JSON.parse(fs.readFileSync(DUR_STORE, 'utf8')); } catch (e) { DUR = {}; } } return DUR; }
function durPersist() { try { fs.writeFileSync(DUR_STORE, JSON.stringify(durs())); } catch (e) { console.error('duration cache save failed:', e.message); } }
function migrateDurations() {
  const d = durs();
  if (d.__v2) return;
  let n = 0;
  // delete the stale entries so the next build re-probes them; a file that then fails is
  // remembered as a failure instead, and won't stall every rebuild after that
  for (const k of Object.keys(d)) if (d[k] === 1800) { delete d[k]; n++; }
  d.__v2 = 1;
  durPersist();
  if (n) console.log('duration cache: re-queued ' + n + ' stale 30-minute fallbacks');
}
// Movies used to be filed under /content/ although they live in the movies root: if the
// file isn't where the src claims, look under the other root and correct the src.
function altRootSrc(src) {
  if (typeof src !== 'string') return null;
  if (src.startsWith('/content/')) return '/movies/' + src.slice('/content/'.length);
  if (src.startsWith('/movies/')) return '/content/' + src.slice('/movies/'.length);
  return null;
}
async function probeEpisode(e) {
  const abs = srcToAbs(e.src);
  try { return await ffprobeDuration(abs); }
  catch (err) {
    const alt = altRootSrc(e.src);
    // only switch roots when the file is genuinely missing here — a corrupt file must not
    // silently become a different title
    if (!alt || fs.existsSync(abs)) throw err;
    const d = durs();
    if (d[alt] > 0 && d[alt] <= MAX_PROBE_SECONDS) { e.src = alt; return d[alt]; } // already measured under the other root
    const dur = await ffprobeDuration(srcToAbs(alt));
    e.src = alt;
    return dur;
  }
}
async function probeShow(show) {
  const d = durs();
  const local = [];
  for (const e of show.episodes) {
    const localFile = !!srcToAbs(e.src);
    // A stored duration can be a leftover from an earlier build, archive.org's metadata
    // length, or a hand-typed admin entry. For a LOCAL file anything past the probe
    // bound came from a half-downloaded file's bogus header — not a length we can
    // believe — so drop it and let the probe below re-measure. A remote file's length
    // is the archive's own measurement, so keep it, capped at what the guide may show.
    if (localFile) { if (!(e.duration > 0 && e.duration <= MAX_PROBE_SECONDS)) e.duration = undefined; }
    else e.duration = clampDuration(e.duration) || undefined;
    const c = d[e.src];
    if (c > 0 && c <= MAX_PROBE_SECONDS) { e.duration = c; continue; }        // measured before
    if (c < 0 && Date.now() + c < PROBE_RETRY_MS) { if (!e.duration) e.duration = 1800; continue; } // failed recently — don't stall the build on it
    if (localFile) { local.push(e); continue; }                                 // local file, probe it
    if (!e.duration) e.duration = 1800; // remote (archive.org) with no length → 30-min assumption
  }
  // 16-wide: ffprobe here is IO-bound (rclone → spinning vHDD), so we push well past
  // core count; serial is ~2.5s/file (336 eps ≈ 20+ min), 16-wide cuts a 6k-ep bucket to ~10 min
  const PROBE_PARALLEL = 16;
  for (let i = 0; i < local.length; i += PROBE_PARALLEL) {
    const chunk = local.slice(i, i + PROBE_PARALLEL);
    await Promise.all(chunk.map(async (e) => {
      try { e.duration = await probeEpisode(e); d[e.src] = e.duration; }
      catch (err) { if (!e.duration) e.duration = 1800; d[e.src] = -Date.now(); } // keep a known length; remember the failure so the next build doesn't stall on it
    }));
    durPersist();
  }
}
// Smart shuffle: one episode from a show at a time, each show stays chronological,
// the show order varies each step, and the same show never plays back-to-back while
// more than one show still has episodes. (The "intelligent shuffle" round-robin can't do.)
function smartShuffle(shows) {
  const pools = shows.map((s) => s.episodes.slice());
  const active = pools.map((_, i) => i).filter((i) => pools[i].length);
  const out = [];
  let last = -1;
  while (active.length) {
    let eligible = active.filter((i) => i !== last);
    if (!eligible.length) eligible = active;
    const pick = eligible[Math.floor(Math.random() * eligible.length)];
    out.push(pools[pick].shift());
    last = pick;
    if (!pools[pick].length) active.splice(active.indexOf(pick), 1);
  }
  return out;
}

async function buildChannel(channelId, opts) {
  opts = opts || {};
  const l = loadLineup(); const ch = channelOrThrow(l, channelId);
  let shows = (ch.shows || []).filter(s => s.episodes && s.episodes.length);
  if (!shows.length) throw Object.assign(new Error('no shows yet — import one from your library first'), { status: 400 });
  if (Array.isArray(opts.order) && opts.order.length) {
    shows = shows.slice().sort((a, b) => { const ia = opts.order.indexOf(a.id), ib = opts.order.indexOf(b.id); return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib); });
  }
  for (const s of shows) await probeShow(s);
  saveLineup(l); // persist detected durations so future builds are instant
  const mode = opts.mode === 'sequential' ? 'sequential' : opts.mode === 'smartshuffle' ? 'smartshuffle' : 'roundrobin';
  const every = Math.max(0, Math.round(opts.commercialEvery)); // 0 = no commercials

  // Marathon mode: pull K consecutive episodes from M random shows, then drop each
  // block at a random spot. The carved shows keep playing their remaining episodes.
  const blocks = [];
  if (opts.marathon && opts.marathon.on) {
    const K = Math.max(2, Math.round(opts.marathon.block) || 2);
    const M = Math.max(1, Math.round(opts.marathon.count) || 1);
    for (const s of shows.filter((s) => s.episodes.length >= K).slice().sort(() => Math.random() - 0.5).slice(0, M)) {
      const start = Math.floor(Math.random() * (s.episodes.length - K + 1));
      blocks.push(s.episodes.slice(start, start + K));
      s.episodes = s.episodes.slice(0, start).concat(s.episodes.slice(start + K));
    }
  }

  // Segments: one episode each, or a whole marathon block (plays unbroken — a
  // commercial never lands inside a block).
  const segs = [];
  if (mode === 'smartshuffle') smartShuffle(shows).forEach((e) => segs.push([e]));
  else if (mode === 'roundrobin') {
    const maxLen = Math.max(0, ...shows.map((s) => s.episodes.length));
    for (let i = 0; i < maxLen; i++) for (const s of shows) if (s.episodes[i]) segs.push([s.episodes[i]]);
  } else for (const s of shows) for (const e of s.episodes) segs.push([e]);
  for (const blk of blocks) segs.splice(Math.floor(Math.random() * (segs.length + 1)), 0, blk);
  if (!segs.length) throw Object.assign(new Error('no episodes to build'), { status: 400 });

  const total = segs.reduce((n, seg) => n + seg.length, 0);
  const items = [];
  let emitted = 0;
  segs.forEach((seg) => {
    const before = emitted;
    for (const e of seg) { items.push({ title: e.title, src: e.src, duration: e.duration, isAd: false, year: '' }); emitted++; }
    if (every > 0 && Math.floor(before / every) < Math.floor(emitted / every) && emitted < total) items.push(makeCommercial(ch.name, opts.commercialDuration));
  });
  const out = publishChannel(ch.id, { items, startIndex: 0 });
  return { ...out, mode, episodes: total, commercials: items.filter((x) => x.isAd).length, marathons: blocks.length };
}
app.post('/api/admin/channel/shows/add', (req, res, next) => {
  try { res.json({ ok: true, show: addShow(req.body.channel, req.body) }); } catch (e) { next(e); }
});
app.post('/api/admin/channel/shows/remove', (req, res, next) => {
  try { res.json(removeShow(req.body.channel, req.body.showId)); } catch (e) { next(e); }
});

// Re-scan a channel's shows: each show's source (its folder, or its archive.org item)
// is recovered from the first episode's src, re-listed for what it holds right now, and
// the show's episode list is replaced. New episodes appear, deleted ones drop off — so the
// admin adds everything once, then just re-scans + go-live when the source changes.
function rescanLocalEpisodes(srcs) {
  const rels = { content: new Set(), movies: new Set() };
  for (const src of srcs || []) {
    if (src.startsWith('/content/')) rels.content.add(src.slice('/content/'.length));
    else if (src.startsWith('/movies/')) rels.movies.add(src.slice('/movies/'.length));
  }
  const baseOf = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
  const out = [];
  for (const [key, [baseDir, prefix]] of Object.entries({ content: [CONTENT_DIR, '/content/'], movies: [MOVIES_DIR, '/movies/'] })) {
    for (const rel of rels[key]) {
      const i = rel.lastIndexOf('/');
      const folderRel = i > 0 ? rel.slice(0, i) : '';
      const abs = path.join(baseDir, folderRel);
      let entries; try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { continue; }
      // follow symlinks (nzbdav/rclone library): a link's dirent.isFile() is false, so statSync it
      const files = entries
        .filter((en) => { try { return fs.statSync(path.join(abs, en.name)).isFile() && VIDEO_EXT.test(en.name); } catch (e) { return false; } })
        .map((en) => en.name).sort(natural);
      if (!files.length) continue;
      // mirror buildTree: when a folder has both a .mp4 and the original .mkv/.avi of the same
      // video, keep only the mp4 (browsers can't play the rest).
      const mp4Bases = new Set(files.filter((f) => /\.mp4$/i.test(f)).map((f) => baseOf(f)));
      for (const name of files.filter((f) => /\.mp4$/i.test(f) || !mp4Bases.has(baseOf(f)))) {
        out.push({ title: name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), src: prefix + (folderRel ? folderRel + '/' : '') + name });
      }
    }
  }
  return out;
}
async function rescanChannel(channelId) {
  const l = loadLineup(); const ch = channelOrThrow(l, channelId);
  const shows = [];
  for (const s of (ch.shows || [])) {
    const src = (s.episodes && s.episodes[0] && s.episodes[0].src) || '';
    let newEps = null; let source = null;
    const ao = src.match(/^https?:\/\/archive\.org\/download\/([^/]+)/);
    if (ao) {
      source = 'archive.org';
      try { newEps = (await resolveArchiveOrg('https://archive.org/details/' + decodeURIComponent(ao[1]), 0, 0)).episodes; }
      catch (e) { shows.push({ id: s.id, name: s.name, source, before: (s.episodes || []).length, after: 0, error: e.message }); continue; }
    } else if (src.startsWith('/content/') || src.startsWith('/movies/')) {
      source = 'folder';
      newEps = rescanLocalEpisodes((s.episodes || []).map((e) => e.src));
    } else {
      shows.push({ id: s.id, name: s.name, source: 'unknown', before: (s.episodes || []).length, after: 0, error: "can't rescan this source" }); continue;
    }
    const before = (s.episodes || []).length;
    if (!newEps.length) { shows.push({ id: s.id, name: s.name, source, before, after: 0, error: 'no episodes found now' }); continue; }
    s.episodes = newEps;
    shows.push({ id: s.id, name: s.name, source, before, after: newEps.length });
  }
  saveLineup(l);
  io.emit('lineup:update', { updated: ch.id });
  return { rescanned: shows.filter((s) => !s.error).length, failed: shows.filter((s) => s.error).length, shows };
}
app.post('/api/admin/channel/rescan', async (req, res, next) => {
  try { res.json({ ok: true, ...(await rescanChannel(req.body.channel)) }); } catch (e) { next(e); }
});
app.post('/api/admin/channel/build', async (req, res, next) => {
  try { res.json({ ok: true, ...(await buildChannel(req.body.channel, req.body)) }); } catch (e) { next(e); }
});

// --- auto-generate: turn the whole library into a themed lineup of channels --------------
// Every TV show lands in one theme channel (name keywords) or an era channel; every movie
// gets a themed/era movie channel plus a Movie Night catch-all. Overlays: Long-Run Legends,
// Binge-Shorts. Episodes shared between channels transcode only once (cache is keyed by src).
const GEN_TV_THEMES = [
  { name: 'Kids & Toons', emoji: '🧸', color: '#29B6F6', re: /spongebob|dora|paw patrol|peppa|winx|transformers|tmnt|aang|kenji|dexter|lazy town|miraculous|bluey|garfield|looney|scooby|clifford|caillou|recess|barbera|clarence|angry birds|cartoon|animation|kiddie|toon/i },
  { name: 'Comedy', emoji: '😂', color: '#FFB300', re: /south park|family guy|king of the hill|bob.?s? burger|frasier|seinfeld|friends|community|curb|fresh prince|modern family|big bang|30 rock|good place|arrested|paul|brooklyn|crazy|reaper|wonder.?s? years|goon.?s? show|bachelor|suburgatory|how i met|sitcom|comedy|the office|young rock/i },
  { name: 'Sci-Fi & Fantasy', emoji: '🚀', color: '#7E57C2', re: /star trek|star wars|stargate|red dwarf|doctor who|stranger|thrones|game of|the ring|dune|alien|predator|terminator|matrix|blade runner|battlestar|buck rogers|rick|futurama|firefly|westworld|sense8|andor|foundation|expanse|supernatural|vampire|werewolf|witch|dragon|merlin|cassidy|flash|space|galaxy|cosmos/i },
  { name: 'Crime & Mystery', emoji: '🕵️', color: '#546E7A', re: /crime|noir|detective|investigation|law and order|csi|forensic|murder|killer|suits|lie to me|mentalist|sopranos|godfather|scarface|pulp fiction|reservoir|starsky|boston legal|elementary|major crimes|lucifer|ray donovan|prison|jail|mafia|psych|castle|ncis|fargo|true detective|zodiac|mandel|daredevil/i },
  { name: 'Drama', emoji: '🎭', color: '#EF5350', re: /drama|breaking|walker|shameless|house.?m?.?d|grays|emergency|revenge|dynasty|gossip|desperate|housewives|yellowstone|success|empire|blue bloods|nurse|doctors?|siren|reacher|green.?book/i },
];
const GEN_MOVIE_THEMES = [
  { name: 'Action Heroes', emoji: '💥', color: '#FF7043', re: /matrix|terminator|mission|die hard|rocky|rambo|speed|jurassic|transformers|avatar|iron man|captain|avengers|dark knight|batman|superman|spider|fast and furious|fast furious|john wick|extract|action|hero|007|wolverine|gladiator|mad max|warrior|titan/i },
  { name: 'Comedy', emoji: '🎪', color: '#FFD54F', re: /comedy|blues brothers|dumb and dumber|home alone|grown ups|night at the movies|wedding crashers|clueless|stepbrothers|tall tales|funny|laugh|joker|there.?s|idiot|nerd|buddy|road trip/i },
  { name: 'Sci-Fi & Space', emoji: '🛸', color: '#9575CD', re: /interstellar|inception|blade runner|back to the future|star wars|star trek|cloverfield|arrival|metropolis|2001|apes|jupiter|neon|cyber|alien|predator|robot|android|space|galaxy|planet|dune/i },
  { name: 'Horror & Thriller', emoji: '👻', color: '#607D8B', re: /horror|terror|scream|jaws|shining|exorcist|haunting|ghost|resident evil|sinister|insidious|hereditary|get out|vampire|werewolf|zombie|dawn of the dead|living dead|night of the|saw:|silence of the lambs|shutter island|unsane/i },
  { name: 'Crime & Gangsters', emoji: '🎩', color: '#8D6E63', re: /godfather|sopranos|scarface|pulp fiction|reservoir|goodfellas|gangster|mafia|casino|ocean eleven|ocean twelve|rounders|starsky|hart|jackie brown|training day|millers crossing|departed|heist|robbery|underworld|black mass|public enemies|american hustler|get shorty|bodyguard/i },
];
function genClean(n) {
  return String(n).replace(/\s*\{.*$/, '').replace(/\s*[({\[][^(){}[\]]*[)}\]]\s*$/, '').replace(/\s+[({\[][^(){}[\]]*[)}\]]\s*$/, '').replace(/\s+/g, ' ').trim();
}
function genYear(n) { const m = String(n).match(/\b(19\d{2}|20\d{2})\b/); return m ? Number(m[1]) : null; }
function genFiles(node) {
  const acc = [];
  (function walk(n) { if (!n) return; if (n.type === 'file') { acc.push(n.path); return; } (n.children || []).forEach(walk); })(node);
  return acc;
}
// Generation runs in the background (first pass probes the whole library — minutes to
// hours over rclone); the admin UI polls /api/admin/generate/status.
const genJob = { running: false, phase: 'idle', done: 0, total: 0, made: [], skipped: [] };
async function generateLineup() {
  const l = loadLineup();
  const used = new Set((l.channels || []).map((c) => String(c.name).toLowerCase()));
  // addShow caps one show at 1000 episodes, so big buckets are split into 900-episode shows
  const mk = async (name, emoji, color, files, showName, desc, root) => {
    if (!files.length) return;
    if (used.has(String(name).toLowerCase())) { genJob.skipped.push(name); return; }
    used.add(String(name).toLowerCase());
    try {
      const ch = addChannel({ name, emoji, color, description: desc });
      for (let i = 0; i < files.length; i += 900) {
        const chunk = files.slice(i, i + 900);
        addShow(ch.id, { name: files.length > 900 ? showName + ' ' + (i / 900 + 1) : showName, files: chunk, root });
      }
      await buildChannel(ch.id, { mode: 'smartshuffle', commercialEvery: 1, commercialDuration: 15 });
      genJob.made.push({ name, episodes: files.length });
    } catch (e) { genJob.skipped.push(name + ': ' + (e.message || e)); }
  };

  // TV: theme (keyword) → era (year) → Late Night Mix; overlays by episode count
  const tvTree = buildTree(CONTENT_DIR, '', 0, { count: 0 }, false);
  const tvShows = (tvTree ? tvTree.children : []).filter((c) => c.type === 'dir');
  const eras = [
    { name: '80s Nostalgia', emoji: '📼', color: '#26A69A' },
    { name: '90s Binge', emoji: '📼', color: '#66BB6A' },
    { name: '2000s Rewind', emoji: '📼', color: '#AB47BC' },
    { name: '2010s & Now', emoji: '📼', color: '#42A5F5' },
  ];
  const buckets = GEN_TV_THEMES.map((t) => ({ name: t.name, emoji: t.emoji, color: t.color, re: t.re, files: [] }));
  eras.forEach((e) => buckets.push({ ...e, files: [] }));
  buckets.push({ name: 'Late Night Mix', emoji: '🌙', color: '#78909C', files: [] });
  const longRun = [], shortBinge = [];
  let tvTitles = 0;
  for (const sh of tvShows) {
    const files = genFiles(sh); if (!files.length) continue;
    tvTitles++;
    const b = buckets.find((x) => x.re && x.re.test(genClean(sh.name)));
    const y = genYear(sh.name);
    const eraName = y == null ? null : (y < 1990 ? eras[0].name : y < 2000 ? eras[1].name : y < 2010 ? eras[2].name : eras[3].name);
    // buckets (not raw eras) carry the files array; no theme + no year → Late Night Mix
    (b || (eraName ? buckets.find((x) => x.name === eraName) : null) || buckets[buckets.length - 1]).files.push(...files);
    if (files.length >= 150) longRun.push(...files);
    else if (files.length <= 40) shortBinge.push(...files);
  }

  // movies: theme → era; Movie Night carries everything so no title is left out
  const mvTree = fs.existsSync(MOVIES_DIR) ? buildTree(MOVIES_DIR, '', 0, { count: 0 }, false) : null;
  const mOld = { name: 'Classic Films (pre-1990)', emoji: '🎞️', color: '#FFA726', files: [] };
  const mNew = { name: 'Modern Movies (1990+)', emoji: '🎬', color: '#EC407A', files: [] };
  const mBuckets = GEN_MOVIE_THEMES.map((t) => ({ name: t.name, emoji: t.emoji, color: t.color, re: t.re, files: [] }));
  mBuckets.push(mOld, mNew);
  const allMovies = [];
  let mvTitles = 0;
  for (const mv of (mvTree ? mvTree.children : [])) {
    const files = mv.type === 'file' ? [mv.path] : genFiles(mv);
    if (!files.length) continue;
    mvTitles++;
    allMovies.push(...files);
    const b = mBuckets.find((x) => x.re && x.re.test(genClean(mv.name)));
    const y = genYear(mv.name);
    (b || (y != null && y < 1990 ? mOld : mNew)).files.push(...files);
  }
  if (allMovies.length) mBuckets.push({ name: 'Movie Night — Everything', emoji: '🍿', color: '#FFF176', files: allMovies.slice() });

  const jobs = [];
  for (const b of buckets) if (b.files.length >= 20) jobs.push({ b, showName: 'TV Mix', desc: b.files.length + ' episodes · auto-generated' });
  jobs.push({ b: { name: 'Long-Run Legends', emoji: '⏳', color: '#90A4AE', files: longRun }, showName: 'Marathon Shows', desc: longRun.length + ' episodes from long-running series' });
  jobs.push({ b: { name: 'Binge-Shorts', emoji: '🍿', color: '#4DB6AC', files: shortBinge }, showName: 'Quick Series', desc: shortBinge.length + ' episodes from short series' });
  for (const b of mBuckets) jobs.push({ b, showName: b.name, desc: b.files.length + ' movies · auto-generated', root: 'movies' });
  genJob.total = jobs.length; genJob.done = 0;
  for (const j of jobs) { genJob.phase = 'building ' + j.b.name; await mk(j.b.name, j.b.emoji, j.b.color, j.b.files, j.showName, j.desc, j.root); genJob.done++; }

  return { made: genJob.made, skipped: genJob.skipped, tvShows: tvTitles, movies: mvTitles };
}
app.post('/api/admin/generate', (req, res) => {
  if (genJob.running) return res.json({ ok: true, running: true, ...genJob });
  genJob.running = true; genJob.phase = 'scanning library'; genJob.done = 0; genJob.total = 0; genJob.made = []; genJob.skipped = [];
  res.json({ ok: true, started: true });
  generateLineup()
    .then(() => { genJob.phase = 'done'; io.emit('lineup:update', { generated: true }); })
    .catch((e) => { genJob.phase = 'error: ' + (e.message || e); })
    .finally(() => { genJob.running = false; });
});
app.get('/api/admin/generate/status', (req, res) => res.json({ ...genJob }));

// --- archive.org import: resolve an item/file link to its streamable mp4s ---
// Prefer <base>.ia.mp4 over <base>.mp4 for the same base (the IA transcode streams
// more reliably), fall back to the plain mp4 when no ia variant exists.
const AO_DOWNLOAD = 'https://archive.org/download/';
const aoEncode = (name) => encodeURIComponent(name).replace(/\(/g, '%28').replace(/\)/g, '%29');
function archiveOrgItem(url) {
  const m = String(url).match(/archive\.org\/(?:details|download)\/([^\/?#]+)/);
  return m ? m[1] : null;
}
async function resolveArchiveOrg(url, minDur, maxDur) {
  const item = archiveOrgItem(url);
  if (!item) throw Object.assign(new Error('paste an archive.org link — https://archive.org/details/… or …/download/…'), { status: 400 });
  let meta;
  try {
    const r = await fetch('https://archive.org/metadata/' + encodeURIComponent(item), { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    meta = await r.json();
  } catch (e) { throw Object.assign(new Error('could not read that archive.org item (' + (e.message || e) + ')'), { status: 502 }); }
  const metaMap = {}; (meta.files || []).forEach((f) => { metaMap[String((f && f.name) || '')] = f; });
  let mp4 = Object.keys(metaMap).filter((f) => /\.mp4$/i.test(f));
  // min/max duration filter (seconds); files with an unknown length are kept.
  const minS = Math.max(0, Math.round(Number(minDur) || 0));
  const maxS = Math.max(0, Math.round(Number(maxDur) || 0));
  let dropped = 0;
  mp4 = mp4.filter((f) => {
    const len = Number(metaMap[f] && metaMap[f].length) || 0;
    if (!len) return true;
    const bad = (minS > 0 && len < minS) || (maxS > 0 && len > maxS);
    if (bad) dropped++;
    return !bad;
  });
  if (!mp4.length) throw Object.assign(new Error((minS || maxS) ? 'all .mp4 files were filtered out by the min/max duration' : 'no .mp4 files found in that item'), { status: 404 });
  const byBase = {};
  for (const f of mp4) {
    const base = f.replace(/\.ia\.mp4$/i, '').replace(/\.mp4$/i, '');
    byBase[base] = byBase[base] || {};
    if (/\.ia\.mp4$/i.test(f)) byBase[base].ia = f;
    else if (!byBase[base].plain) byBase[base].plain = f;
  }
  const episodes = Object.keys(byBase).sort(natural).map((b) => {
    const f = byBase[b].ia || byBase[b].plain;
    const dur = metaMap[f] && metaMap[f].length ? clampDuration(Number(metaMap[f].length)) || undefined : undefined;
    return {
      title: f.replace(/\.ia\.mp4$/i, '').replace(/\.mp4$/i, '').replace(/[_-]+/g, ' ').slice(0, 120),
      src: AO_DOWNLOAD + encodeURIComponent(item) + '/' + aoEncode(f),
      duration: dur || undefined
    };
  });
  return { item, count: episodes.length, episodes, dropped };
}
app.post('/api/admin/archiveorg', async (req, res, next) => {
  try {
    const b = req.body || {};
    const minDur = b.minDur !== undefined ? Number(b.minDur) : 300;
    const maxDur = b.maxDur !== undefined ? Number(b.maxDur) : 28800;
    const r = await resolveArchiveOrg(String(b.url || ''), minDur, maxDur);
    res.json({ ok: true, item: r.item, count: r.count, episodes: r.episodes, dropped: r.dropped });
  } catch (e) { next(e); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- chat (per-channel room; a name is always required — signed-in or not) ---
const chatLogPath = path.join(DATA, 'chatlog.json');
function loadChatLog() {
  try { return JSON.parse(fs.readFileSync(chatLogPath, 'utf8')); } catch (e) { return {}; }
}
function appendChatLog(room, m) {
  const log = loadChatLog();
  log[room] = (log[room] || []).concat(m).slice(-200); // keep the last 200 per room
  fs.writeFileSync(chatLogPath, JSON.stringify(log, null, 2));
}
const chatWins = new Map(); // name (lowercase) -> [{t, n}] char-window, shared across all connections
// chatRateLimit is max CHARACTERS per name per minute (0 = unlimited).
function chatAllowed(name, text, now) {
  const limit = getSettings().chatRateLimit; // 0 = unlimited
  if (!limit) return true;
  const key = name.toLowerCase();
  if (chatWins.size > 1000) for (const [k, w] of chatWins) if (!w.length || w[w.length - 1].t < now - 60000) chatWins.delete(k);
  const win = chatWins.get(key) || [];
  while (win.length && win[0].t < now - 60000) win.shift();
  const used = win.reduce((a, e) => a + e.n, 0);
  if (used + text.length > limit) return false;
  win.push({ t: now, n: text.length });
  chatWins.set(key, win);
  return true;
}
io.use((socket, next) => {
  if (!siteGated() || liveToken(siteTokens, cookie(socket.request, 'site'))) return next();
  next(new Error('unauthorized'));
});
// how many sockets are in a channel's room = how many are watching that channel
function roomCount(channelId) {
  const room = io.sockets.adapter.rooms.get('chat:' + channelId);
  return room ? room.size : 0;
}
function announceCount(channelId) { io.to('chat:' + channelId).emit('chat:count', roomCount(channelId)); }
// socket.io clears a socket's rooms BEFORE its 'disconnect' fires, so we keep our own
// record of which chat room(s) each socket is in, to know what to re-announce on exit.
const watched = new Map(); // socket.id -> Set of channel ids
io.on('connection', (socket) => {
  socket.on('chat:join', (channelId) => {
    socket.join('chat:' + channelId);
    let set = watched.get(socket.id);
    if (!set) { set = new Set(); watched.set(socket.id, set); }
    set.add(channelId);
    announceCount(channelId);
    const hist = (loadChatLog()[channelId] || []).slice(-50); // replay the last 50
    if (hist.length) socket.emit('chat:history', hist);
  });
  socket.on('chat:leave', (channelId) => {
    socket.leave('chat:' + channelId);
    const set = watched.get(socket.id);
    if (set) { set.delete(channelId); if (!set.size) watched.delete(socket.id); }
    announceCount(channelId);
  });
  socket.on('disconnect', () => {
    for (const id of watched.get(socket.id) || []) announceCount(id);
    watched.delete(socket.id);
  });
  socket.on('chat:message', (channelId, msg) => {
    const me = userName(socket.request);
    // gated chat: signed-in users only; the username is authoritative (no name field)
    if (getSettings().chatMode === 'users' && !me) { socket.emit('chat:denied', 'auth'); return; }
    const name = (me || String((msg && msg.name) || '')).trim().slice(0, 24);
    if (!name) { socket.emit('chat:denied', 'name'); return; } // no anonymous chatter
    const text = String((msg && msg.text) || '').slice(0, 280);
    if (!text) return;
    const now = Date.now();
    // rate limit is per NAME across all connections, so extra tabs don't bypass it
    if (!chatAllowed(name, text, now)) { socket.emit('chat:throttled', { limit: getSettings().chatRateLimit }); return; }
    const safe = { name, text, t: now };
    // io.to (not socket.to) so the sender also receives their own message back.
    io.to('chat:' + channelId).emit('chat:message', safe);
    appendChatLog(channelId, safe);
    const fx = effectFor(text);
    if (fx && channelId !== 'global' && getSettings().chatEffects) io.to('chat:' + channelId).emit('chat:effect', fx);
  });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'server error' });
});

server.listen(PORT, () => {
  console.log(`dialarr on :${PORT}`);
  migrateDurations();
  tcStartup();
  setInterval(tcTick, 60000); // keep the look-ahead queue fed with what's about to air
});
