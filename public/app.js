/* global io, dialarrEngine */
'use strict';

const E = dialarrEngine;
const $ = (id) => document.getElementById(id);
const player = $('player');
const adMusic = $('ad-music');

let lineup = null;
let intentionalPause = false; // set when tick() pauses on purpose (bump/commercial); the pause-resume guard ignores it
let channelIdx = 0;
let manualOffset = null;      // user seek offset from live, in ms (null = live)
let lastItem = null;          // last video item we loaded into <video>
let adMusicId = null;         // id of the generated-commercial whose music is playing
const manifestCache = new Map(); // version key -> manifest

// Remember the channel, so coming back to the site lands on what you were watching.
const CH_KEY = 'dialarr.channel';
function rememberChannel(id) { try { localStorage.setItem(CH_KEY, id); } catch (e) {} }
function rememberedChannel() { try { return localStorage.getItem(CH_KEY); } catch (e) { return null; } }

async function loadLineup() {
  // Only the channel list and the bump clock are drawn on this page — the shows and
  // their episodes are admin data, and they are most of the megabyte.
  const r = await fetch('/broadcast/channels.json');
  lineup = await r.json();
  paintChannel();
}

function channel() { return lineup && lineup.channels ? lineup.channels[channelIdx] : null; }

let chatMode = 'open';   // 'open' or 'users' (from settings)
let viewerCount = 0;     // people in the current room (last value the server reported)
let viewerShow = true;   // master on/off (admin setting)
let viewerMin = 50;      // only show the count once the room is at least this big (admin setting)
function paintChatCount() {
  const el = $('chat-count');
  if (!el) return;
  const show = viewerShow && viewerCount >= viewerMin;
  el.classList.toggle('hidden', !show);
  if (show) el.textContent = viewerCount + ' watching';
}
function applySettings(s) {
  if (!s) return;
  if (s.siteName) {
    document.title = s.siteName;
    for (const id of ['site-name', 'about-site']) { const el = $(id); if (el) el.textContent = s.siteName; }
  }
  if (s.theme) { for (const k in s.theme) { const v = s.theme[k]; if (v) document.documentElement.style.setProperty('--' + k, v); } }
  if (s.chatMode) { chatMode = s.chatMode; applyChatGate(); }
  if (s.showViewerCount !== undefined) viewerShow = s.showViewerCount !== false;
  if (typeof s.viewerCountMin === 'number') viewerMin = s.viewerCountMin;
  if (s.showSeekButtons !== undefined) {
    const on = s.showSeekButtons;
    for (const id of ['rewind', 'fwd']) { const el = $(id); if (el) el.classList.toggle('hidden', !on); }
  }
  for (const [id, k] of [['coffee-btn', 'coffeeLink'], ['patreon-btn', 'patreonLink']]) {
    const b = $(id);
    if (!b) continue;
    if (s[k]) { b.href = s[k]; b.classList.remove('hidden'); } else b.classList.add('hidden');
  }
  if (Array.isArray(s.infoBoxes)) renderInfoBoxes(s.infoBoxes, s.siteName);
  paintChatCount();
}

// The footer boxes are plain text edited in the admin console; {{site}} stands in
// for the site name and any http(s) link becomes a link.
function renderInfoBoxes(boxes, siteName) {
  const grid = $('about-grid');
  if (!grid) return;
  grid.textContent = '';
  for (const b of boxes) {
    const box = document.createElement('div');
    const h = document.createElement('h4');
    h.textContent = b.title || '';
    const p = document.createElement('p');
    for (const node of linkify(String(b.body || '').replace(/\{\{site\}\}/g, siteName || 'Dialarr'))) p.appendChild(node);
    box.appendChild(h);
    box.appendChild(p);
    grid.appendChild(box);
  }
}
function linkify(text) {
  const out = [];
  const re = /(https?:\/\/[^\s<>"]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener';
    out.push(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

// --- sign-in (top right) + member-only chat gate ----------------------------
let me = null;           // signed-in username, or null
async function loadMe() {
  try { const r = await fetch('/api/user/me'); if (r.ok) me = (await r.json()).username; } catch (e) { me = null; }
  paintWho(); applyChatGate();
}
function paintWho() {
  const t = $('who-toggle');
  if (!t) return;
  t.textContent = me ? 'sign out' : 'sign in';
  t.title = me ? 'signed in as ' + me : '';
}
function paintNameField() {
  const n = $('chat-name');
  if (!n) return;
  if (me && chatMode === 'users') { n.value = me; n.readOnly = true; n.placeholder = me; }
  else { n.readOnly = false; n.value = ''; }
}
function applyChatGate() {
  const gated = chatMode === 'users' && !me;
  $('chat-gate').classList.toggle('hidden', !gated);
  $('emojis').classList.toggle('hidden', gated);
  $('chat-row').classList.toggle('hidden', gated);
  paintNameField();
}
// login/logout changes the cookie, and the server reads identity from the
// socket handshake — so the socket must reconnect to pick it up
function refreshSocket() { currentRoom = null; socket.disconnect(); socket.connect(); } // null: force re-join after reconnect
$('who-toggle').onclick = async () => {
  if (me) { await fetch('/api/user/logout', { method: 'POST' }); me = null; refreshSocket(); }
  else $('who-form').classList.toggle('hidden');
  paintWho(); applyChatGate();
};
$('who-go').onclick = async () => {
  const r = await fetch('/api/user/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('who-user').value.trim(), password: $('who-pass').value }) });
  if (r.ok) { me = (await r.json()).username; refreshSocket(); $('who-form').classList.add('hidden'); $('who-pass').value = ''; $('who-err').textContent = ''; }
  else { const j = await r.json().catch(() => ({})); $('who-err').textContent = j.error || 'sign-in failed'; return; }
  paintWho(); applyChatGate();
};
$('who-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('who-go').click(); });
async function loadSiteName() {
  try { const s = await (await fetch('/api/settings')).json(); applySettings(s); } catch (e) { /* keep static defaults */ }
}

function paintChannel() { renderDial(); renderGuide(); }

function renderDial() {
  const dial = $('dial');
  if (!dial) return;
  dial.innerHTML = '';
  lineup.channels.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'dial-ch' + (i === channelIdx ? ' active' : '');
    b.textContent = `${c.dial} ${c.emoji}`;
    b.title = c.name;
    b.onclick = () => goChannel(i);
    dial.appendChild(b);
  });
}

// --- TV guide: channels down the Y axis, time across the X axis ------------
// Blocks are placed from the shared clock, so the item now playing spans its
// real start→end across the "now" line (a 4h file 30 min in shows start 0.5h
// behind and end 3.5h ahead).
const GUIDE_BACK = 3600000;              // 1h of history shown behind "now"
const GUIDE_FWD = 5 * 3600000;           // 5h ahead
let guideToken = 0;

function clockLabel(ms) {
  const d = new Date(ms); let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h' + (m ? ' ' + m + 'm' : '');
  if (m) return m + 'm';
  return s + 's';
}


async function renderGuide() {
  const g = $('guide');
  if (!g) return;
  const token = ++guideToken;
  let data;
  try {
    data = await (await fetch('/api/guide/blocks?backMs=' + GUIDE_BACK + '&fwdMs=' + GUIDE_FWD)).json();
  } catch (e) { return; }
  if (token !== guideToken) return; // a newer render started; drop this one
  const now = data.now;
  const origin = now - data.backMs, span = data.backMs + data.fwdMs;
  const pct = (tm) => Math.max(0, Math.min(100, (tm - origin) / span * 100));
  // map channel id -> lineup index for goChannel()
  const idToIdx = {};
  (lineup.channels || []).forEach((c, i) => { idToIdx[c.id] = i; });
  g.innerHTML = '';
  const grid = document.createElement('div'); grid.className = 'tvguide';

  const head = document.createElement('div'); head.className = 'tvg-head';
  const corner = document.createElement('div'); corner.className = 'tvg-corner'; corner.textContent = 'ch \\ time';
  const axis = document.createElement('div'); axis.className = 'tvg-axis';
  for (let h = Math.ceil(origin / 3600000) * 3600000; h <= origin + span; h += 3600000) {
    const tk = document.createElement('span'); tk.className = 'tvg-tick';
    tk.style.left = pct(h) + '%'; tk.textContent = clockLabel(h); axis.appendChild(tk);
  }
  head.append(corner, axis); grid.appendChild(head);

  const nowPct = pct(now);
  (data.channels || []).forEach((ch) => {
    const i = idToIdx[ch.id];
    const row = document.createElement('div'); row.className = 'tvg-row' + (i === channelIdx ? ' active' : '');
    const label = document.createElement('button'); label.className = 'tvg-label';
    label.innerHTML = `<span class="g-dial">${ch.dial}</span><span class="g-emoji">${escapeHtml(ch.emoji)}</span><span class="g-name">${escapeHtml(ch.name)}</span>`;
    label.onclick = () => { if (i !== undefined) goChannel(i); };
    const track = document.createElement('div'); track.className = 'tvg-track';
    const nl = document.createElement('div'); nl.className = 'tvg-now'; nl.style.left = nowPct + '%'; track.appendChild(nl);

    if (ch.offAir || !(ch.blocks || []).length) {
      const off = document.createElement('div'); off.className = 'tvg-block off';
      off.style.left = '0%'; off.style.width = '100%'; off.textContent = 'off air';
      track.appendChild(off);
    } else {
      ch.blocks.forEach((b) => {
        const el = document.createElement('div');
        el.className = 'tvg-block' + (b.start <= now && b.end > now ? ' live' : '');
        const l = pct(Math.max(b.start, origin));
        const w = Math.max(0.5, Math.min(100, (Math.min(b.end, origin + span) - Math.max(b.start, origin)) / span * 100));
        el.style.left = l + '%'; el.style.width = w + '%';
        if (w >= 6) { const bt = document.createElement('span'); bt.className = 'tvg-bt'; bt.textContent = b.title || ''; el.appendChild(bt); }
        el.addEventListener('mouseenter', () => showTip(el, ch, b));
        el.addEventListener('mouseleave', hideTip);
        el.onclick = () => { if (i !== undefined) goChannel(i); };
        track.appendChild(el);
      });
    }
    row.append(label, track); grid.appendChild(row);
  });
  g.appendChild(grid);
}

function showTip(el, c, b) {
  const tip = $('tvg-tip');
  if (!tip) return;
  const tag = b.isAd ? 'commercial' : '';
  const durSecs = Math.round((b.end - b.start) / 1000);
  tip.innerHTML =
    `<div class="tip-ch">${escapeHtml(c.dial + ' ' + c.name)}</div>` +
    `<div class="tip-title">${escapeHtml(b.title || '')}</div>` +
    `<div class="tip-meta">${clockLabel(b.start)} – ${clockLabel(b.end)} · ${fmtDur(durSecs)}${tag ? ' · ' + tag : ''}</div>`;
  const r = el.getBoundingClientRect();
  tip.classList.add('show');
  const tw = tip.offsetWidth || 240, th = tip.offsetHeight || 60;
  tip.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left)) + 'px';
  const below = r.bottom + 6;
  tip.style.top = (below + th > window.innerHeight && r.top - th - 6 > 0) ? (r.top - th - 6) + 'px' : below + 'px';
}
function hideTip() { const tip = $('tvg-tip'); if (tip) tip.classList.remove('show'); }

function goChannel(i) {
  channelIdx = i; manualOffset = null; lastItem = null; stopAdMusic();
  const c = channel(); if (c) rememberChannel(c.id);
  paintChannel(); joinChat(); tick();
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

function activeBump(ch, afterIndex) {
  const bumps = lineup.bumps || [];
  if (!bumps.length) return [{ text: ch.name }];
  return bumps[afterIndex % bumps.length].slides;
}

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function setProgress(ms, totalMs, show) {
  const prog = $('prog');
  if (!show || !totalMs) { if (prog) prog.classList.add('hidden'); return; }
  prog.classList.remove('hidden');
  $('prog-fill').style.width = Math.max(0, Math.min(100, (ms / totalMs) * 100)) + '%';
  $('prog-time').textContent = fmt(ms / 1000) + ' / ' + fmt(totalMs / 1000);
  paintStreamHealth();
}
// Where the playhead should be if the picture is keeping the clock: where the
// anchor put it, plus the real time since. The pipe is paced to real time, so
// in step the two grow together — anything else is drift.
let liveAnchorT = 0, liveAnchorPos = 0;
// How the stream is doing, and how many times the picture has had to wait.
// It is the difference between "the box is busy" and "the connection is".
// ("How far the buffer reaches ahead" is NOT the measure: a healthy stream's
// buffer grows with watch time, so a perfectly synced viewer read "17s
// ahead" after eleven seconds. Drift against the anchor is the truth.)
function paintStreamHealth() {
  const el = $('prog-live');
  if (!el) return;
  const live = player.currentSrc && player.currentSrc.indexOf('/stream/live') >= 0;
  if (!live) { el.textContent = ''; return; }
  let word = 'buffering', warn = true;
  if (player.paused) { word = 'paused'; warn = false; }
  else if (manualOffset === null && liveAnchorT) {
    const drift = player.currentTime - (liveAnchorPos + (Date.now() - liveAnchorT) / 1000);
    if (Math.abs(drift) < 3) { word = 'in step'; warn = false; }
    else if (drift > 0) word = drift.toFixed(0) + 's ahead of live';
    else word = (-drift).toFixed(0) + 's behind live';
    warn = Math.abs(drift) >= 8;
  } else if (manualOffset !== null) {
    // the viewer hand-rewound: there is no live drift to read.
    word = 'on-demand'; warn = false;
  }
  el.textContent = '· ' + word + (stallCount ? ' · ' + stallCount + ' stalls' : '');
  el.style.color = warn || stallCount ? '#ff9a3c' : '';
}

// Autoplay: try with sound first (allowed after any user gesture); if the browser
// blocks it, fall back to muted autoplay + a "tap for sound" pill. Guarantees playback.
function tryPlay() {
  const p = player.play();
  if (p && p.catch) p.catch(() => {
    player.muted = true;
    player.play().catch(() => {});
    showSoundHint();
  });
}
// How far behind the live edge a viewer sits: enough buffer to ride out a
// delivery hiccup without a stall, close enough that it still reads as live.
const LIVE_LATENCY = 6;
// The pipe delivers at real time, so the newest content (buffered.end) IS the
// live edge — and a slow start leaves a deep buffer of already-past content.
// Playing from the start of that buffer is what dumped viewers 20-30s behind the
// broadcast and ran the episode out from under them. So once a little is
// buffered, anchor a fixed LIVE_LATENCY behind the live edge instead: smooth,
// and in step with the clock no matter how long the start took. (A user pressing
// play is never made to wait — that path calls tryPlay directly. And a manual
// rewind/fwd sets its own offset, so it plays from the stream start, not live.)
function playLiveWithLead() {
  const src = player.src;
  const deadline = Date.now() + 15000;
  (function poll() {
    if (player.src !== src) return; // moved on before the lead earned itself
    const b = player.buffered;
    const have = b.length ? b.end(b.length - 1) - b.start(0) : 0;
    if (have < LIVE_LATENCY && Date.now() <= deadline) { setTimeout(poll, 300); return; }
    if (manualOffset === null && b.length) {
      player.currentTime = Math.max(b.start(0), b.end(b.length - 1) - LIVE_LATENCY);
      liveAnchorPos = player.currentTime;
      liveAnchorT = Date.now();
    }
    tryPlay();
  })();
}
function showSoundHint() {
  const h = $('sound-hint');
  if (h) h.classList.remove('hidden');
  $('mute').textContent = '🔇';
}
// The picture takes a while to come up. A black screen reads as a dead site, so
// the set shows its tuning screen until there is something to look at.
let tuningTimer = null;
function tuning(on, sub) {
  const el = $('tuning');
  if (!el) return;
  el.classList.toggle('hidden', !on);
  if (sub) $('tuning-sub').textContent = sub;
  if (tuningTimer) { clearTimeout(tuningTimer); tuningTimer = null; }
  // if the signal never comes up, don't sit on the static forever — but the
  // picture can take a while to come up on a channel with hard subtitles (the
  // encoder waits for the cues), so give it longer than a plain stream
  if (on) tuningTimer = setTimeout(() => tuning(false), 40000);
}
// (the tuning screen stays up until the picture is actually playing — the live
// path deliberately waits for a buffer lead before it starts)
player.addEventListener('playing', () => tuning(false));
player.addEventListener('error', () => tuning(false));
// Retry playback when the browser pauses due to buffering or autoplay block.
// Without this, a stream that pauses before enough data is buffered stays paused forever.
player.addEventListener('waiting', () => {
  if (player.paused) tryPlay();
});
// Live transcode streams are one-shot pipes: once the buffer drains the video
// freezes forever. If a live stream has been waiting >5s, restart it from the
// current position so the encoder can catch up.
let stallCount = 0, lastStallAt = 0, waitingSince = 0;
let liveStart = 0, liveFails = 0;
player.addEventListener('waiting', () => {
  if (!player.src.startsWith('/stream/live')) return;
  if (!waitingSince) waitingSince = Date.now();
  // Ten seconds, not five: the picture freezing for a moment is much less
  // ugly than throwing the stream away and starting again — and the server
  // keeps the pipe alive for a while, so the new request rejoins the same
  // encode instead of waiting for a cold one.
  else if (Date.now() - waitingSince > 10000) {
    waitingSince = 0;
    const now = Date.now();
    if (now - lastStallAt < 15000) return; // don't restart more than once per 15s
    lastStallAt = now;
    stallCount++;
    if (stallCount > 5) return; // give up after 5 restarts on the same item
    const t = E.liveFilePos(player.src, player.currentTime);
    player.src = player.src.split('&seek=')[0] + '&seek=' + t;
    trackSeek = t;
    applyTracks();
    liveStart = Date.now();
    playLiveWithLead();
  }
});
player.addEventListener('playing', () => {
  waitingSince = 0;
  stallCount = 0;
});
// A live pipe that ends right after it starts means ffmpeg died on the file — it's
// corrupt, or the seek landed past its end (which is what a bogus guide length does).
// Restarting it immediately just spawns another ffmpeg, and a client that reconnects
// in a tight loop took the box down with hundreds of encodes. So: restart a few times,
// slowly, then give up and say so.
function liveRestart(src, seek) {
  if (liveFails >= 3) {
    if (!player.paused) player.pause();
    playCard('⚠ ' + (lastItem.title || 'episode') + ' — playback failed', 'the file may be corrupt; fix or remove it in the admin console');
    return;
  }
  setTimeout(() => {
    // The guide may have moved on to the next item while we waited — then that
    // item's stream is already set and must not be overwritten with our seek.
    if (!lastItem || player.src !== src) return;
    player.src = src.split('&seek=')[0] + '&seek=' + Math.floor(seek);
    trackSeek = Math.floor(seek);
    applyTracks();
    liveStart = Date.now();
    playLiveWithLead();
  }, 3000);
}
// Live transcode streams are one-shot pipes that end when the buffer is full
// or the encoder falls behind. Restart from the current position when that happens.
player.addEventListener('ended', () => {
  if (!player.src.startsWith('/stream/live')) return;
  if (!lastItem) return; // don't restart if we've already moved to a new item
  // died on arrival (no bytes) → a hard failure; count it. Otherwise the pipe just
  // ran out of buffer, which is recoverable.
  if (Date.now() - liveStart < 3000) liveFails++; else liveFails = 0;
  liveRestart(player.src, E.liveFilePos(player.src, player.currentTime));
});
// A live stream that errors outright (the server refused it, or the file is gone)
// must not spin: show why and stop.
player.addEventListener('error', () => {
  if (!player.src.startsWith('/stream/live')) return;
  if (!lastItem) return;
  if (!player.paused) player.pause();
  playCard('⚠ ' + (lastItem.title || 'episode') + ' — playback failed', 'the file may be corrupt; fix or remove it in the admin console');
});

function startAdMusic(item) {
  if (!adMusic) return;
  if (!item.music) { stopAdMusic(); return; }
  if (adMusicId === item.id) return;
  adMusicId = item.id;
  adMusic.src = item.music;
  // setting src resets .muted to false, so re-apply to keep ad audio in sync with the player mute
  adMusic.muted = player.muted;
  adMusic.loop = true;
  const p = adMusic.play();
  if (p && p.catch) p.catch(() => {});
}
function stopAdMusic() {
  if (adMusic) adMusic.pause();
  adMusicId = null;
}

// --- transcode: local mkv/avi are served as a cached mp4 (converted server-side) ---
const TC_SRC = /\.(mkv|avi|mov|flv|wmv|mpg|mpeg|ts)$/i;
const needsTc = (src) => /^\/(content|movies)\//.test(src) && TC_SRC.test(src);
const tcStatusCache = new Map(); // src -> {st, at} — don't hammer the status API every tick
async function tcStatus(src) {
  const c = tcStatusCache.get(src);
  if (c && Date.now() - c.at < 5000) return c.st;
  const st = await (await fetch('/api/transcode/status?src=' + encodeURIComponent(src))).json();
  tcStatusCache.set(src, { st, at: Date.now() });
  return st;
}
function playCard(title, foot) {
  const card = $('card');
  tuning(false);
  card.classList.remove('hidden'); card.classList.remove('commercial');
  $('card-slides').textContent = title;
  $('card-foot').textContent = foot;
}
async function playTranscoded(ch, item, pos) {
  const foot = `${ch.dial} ${ch.emoji} ${ch.name}`;
  let st; try { st = await tcStatus(item.src); } catch (e) { st = { status: 'unknown' }; }
  // A chosen audio track means the cached file (which carries English) is no use.
  if (st.status === 'ready' && st.out) {
    const card = $('card');
    card.classList.add('hidden'); card.classList.remove('commercial');
    // Already watching this item live? The pre-convert has caught up — switch to the
    // cached file. Same video, same position, but the encoder is released: on a busy
    // box that is the difference between one ffmpeg per channel and one per viewer.
    if (player.src.startsWith('/stream/live') && E.liveSrcOf(player.src) === item.src) {
      const at = E.liveFilePos(player.src, player.currentTime);
      lastItem = item;
      tuning(true, `${ch.dial} ${ch.name} — switching over`);
      player.src = '/transcodes/' + st.out;
      trackSeek = 0; // the cached file is the whole thing, so its clock is the file's
      applyTracks();
      const onMeta = () => { player.currentTime = at; tryPlay(); player.removeEventListener('loadedmetadata', onMeta); };
      player.addEventListener('loadedmetadata', onMeta);
    } else if (!lastItem || lastItem.id !== item.id) {
      lastItem = item;
      tuning(true, `${ch.dial} ${ch.name} — bringing up the picture`);
      player.src = '/transcodes/' + st.out;
      trackSeek = 0;
      applyTracks();
      const seekTo = Math.floor((pos.offsetMs || 0) / 1000);
      const onMeta = () => { player.currentTime = seekTo; tryPlay(); player.removeEventListener('loadedmetadata', onMeta); };
      player.addEventListener('loadedmetadata', onMeta);
    }
    $('now-playing').textContent = `${ch.dial} ${ch.emoji} ${ch.name} — ${item.title || item.id}`;
    setProgress(pos.offsetMs || 0, item.duration * 1000, true);
    return;
  }
  if (st.status === 'too_large') {
    // 4K and the like — it will never convert, so don't bother trying.
    if (!player.paused) player.pause();
    lastItem = null;
    playCard('⚠ ' + (item.title || 'episode') + ' — ' + (st.err || 'not streamable'), foot + '  ·  flagged in the admin console');
    $('now-playing').textContent = `${ch.dial} ${ch.name} — UNAVAILABLE`;
    setProgress(0, 0, false);
  } else if (!lastItem || lastItem.id !== item.id) {
    // live transcode: stream from source as we play (Plex-style), starts in ~2s
    // only start a new stream when the item changes (not every tick)
    // a pre-convert that failed does not get the last word — the library is a usenet
    // mount and a file that is still downloading reads as broken, so try the live
    // path anyway (the server stops offering a file that keeps failing)
    const card = $('card');
    card.classList.add('hidden'); card.classList.remove('commercial');
    lastItem = item;
    liveFails = 0;
    trackSeek = Math.floor((pos.offsetMs || 0) / 1000); // the live pipe starts here in the file
    tuning(true, `${ch.dial} ${ch.name} — bringing up the picture`);
    player.src = '/stream/live?src=' + encodeURIComponent(item.src) + '&seek=' + trackSeek;
    applyTracks();
    liveStart = Date.now();
    // the buffer only fills at real time, so wait for a lead before starting —
    // starting thin is what made the picture stutter (see playLiveWithLead)
    const onMeta = () => { playLiveWithLead(); player.removeEventListener('loadedmetadata', onMeta); };
    player.addEventListener('loadedmetadata', onMeta);
  }
  $('now-playing').textContent = `${ch.dial} ${ch.emoji} ${ch.name} — ${item.title || item.id}`;
  setProgress(pos.offsetMs || 0, item.duration * 1000, true);
}

function tick() {
  const ch = channel();
  if (!ch) return;
  const now = Date.now();
  const v = E.activeVersion(ch, now);
  const card = $('card'), offair = $('offair');
  if (!v) {
    stopAdMusic();
    tuning(false);
    card.classList.add('hidden'); offair.classList.remove('hidden');
    if (!player.paused) player.pause();
    $('now-playing').textContent = `${ch.dial} ${ch.name} — OFF AIR`;
    setProgress(0, 0, false);
    lastItem = null;
    return;
  }
  offair.classList.add('hidden');

  const key = ch.id + ':' + v.v;
  const getMv = manifestCache.has(key)
    ? Promise.resolve(manifestCache.get(key))
    : fetch('/broadcast/' + v.manifest).then(r => r.json()).then(mv => {
      // The server clamps every length it serves (a manifest published before the
      // ceiling existed still carries the bad one), so what arrives here is safe to
      // derive a seek from.
      manifestCache.set(key, mv);
      return mv;
    });

  getMv.then(mv => {
    let pos = E.positionAt(mv, v, now, lineup.bumpMs || 0);
    if (manualOffset !== null) pos = E.positionAt(mv, v, now - manualOffset, lineup.bumpMs || 0);
    if (pos.offAir) return;

    // --- gap "bump" card (short, between items) ---
    if (pos.bump) {
      stopAdMusic();
      tuning(false);
      intentionalPause = true;
      if (!player.paused) player.pause();
      card.classList.remove('hidden'); card.classList.remove('commercial');
      const slides = activeBump(ch, pos.afterIndex);
      $('card-slides').textContent = slides.map(s => s.text).join('  /  ');
      $('card-foot').textContent = ch.name;
      $('now-playing').textContent = `${ch.dial} ${ch.name} — BUMP`;
      setProgress(0, 0, false);
      lastItem = null;
      return;
    }

    const item = pos.item;

    // --- generated commercial (on-screen quips rotating by the shared clock + music) ---
    if (item.adSlides && item.adSlides.length) {
      tuning(false);
      if (!player.paused) player.pause();
      card.classList.remove('hidden'); card.classList.add('commercial');
      const durMs = item.duration * 1000, per = durMs / item.adSlides.length;
      const si = Math.min(item.adSlides.length - 1, Math.floor((pos.offsetMs || 0) / per));
      $('card-slides').textContent = item.adSlides[si];
      $('card-foot').textContent = 'COMMERCIAL  ·  ' + ch.name;
      $('now-playing').textContent = `${ch.dial} ${ch.emoji} ${ch.name} — COMMERCIAL`;
      intentionalPause = true;
      startAdMusic(item);
      setProgress(pos.offsetMs || 0, durMs, true);
      lastItem = null;
      return;
    }

    // --- regular video (local mkv/avi stream as a cached mp4; everything else plays direct) ---
    stopAdMusic();
    if (!lastItem || lastItem.id !== item.id) loadTracks(item.src);
    if (needsTc(item.src)) { playTranscoded(ch, item, pos); return; }
    card.classList.add('hidden'); card.classList.remove('commercial');
    if (!lastItem || lastItem.id !== item.id) {
      lastItem = item;
      tuning(true, `${ch.dial} ${ch.name} — bringing up the picture`);
      player.src = item.src;
      trackSeek = 0; // played straight through, so the file's clock is the player's
      applyTracks();
      const seekTo = Math.floor((pos.offsetMs || 0) / 1000);
      const onMeta = () => { player.currentTime = seekTo; tryPlay(); player.removeEventListener('loadedmetadata', onMeta); };
      player.addEventListener('loadedmetadata', onMeta);
    }
    $('now-playing').textContent =
      `${ch.dial} ${ch.emoji} ${ch.name} — ${item.title || item.id}${manualOffset !== null ? '  (−' + Math.round(manualOffset / 1000) + 's)' : ''}`;
    setProgress(pos.offsetMs || 0, item.duration * 1000, true);
  });
}

// --- subtitles --------------------------------------------------------------
// An mkv can carry several languages of subtitles. The server probes the file
// and hands the list over; the viewer picks, and the choice is remembered.
// The subtitles come back as a WebVTT sidecar, timed to where the player is.
// (Audio is not a choice: everybody gets English.)
const SUB_KEY = 'dialarr.subs';      // language code, 'off' = no subtitles
let trackInfo = null;    // { audio, subs, defaultAudio } for the item on screen
let trackSrc = '';       // the file those tracks belong to
let trackSeek = 0;       // where the player starts in that file (0 = the whole file)
let subOrd = null;       // the subtitle track on screen, null = off
let subEls = [];         // the <track> elements, in the order they were added
let subMode = 'soft';    // 'soft' = the viewer picks, 'hard' = burnt in, 'off' = none

function storePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function readPref(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function pickTrack(list, lang) {
  if (!list || !list.length) return null;
  const l = String(lang || '').toLowerCase();
  if (!l || l === 'off') return null;
  let t = list.find((x) => x.lang === l);
  if (!t) t = list.find((x) => x.lang && (x.lang.startsWith(l) || l.startsWith(x.lang)));
  return t || null;
}
async function loadTracks(src) {
  trackSrc = src;
  trackInfo = null;
  applyTracks();
  renderTracksPanel();
  let t;
  try { t = await (await fetch('/api/tracks?src=' + encodeURIComponent(src))).json(); }
  catch (e) { return; }
  if (trackSrc !== src) return; // the item moved on while we were asking
  trackInfo = t;
  subMode = t.mode || 'soft';   // the server's setting — hard subs are already in the picture
  // The site's language is the default; a viewer who picks another one keeps it.
  const pref = readPref(SUB_KEY, null);
  let sub = null;
  if (pref === 'off') sub = null;
  else if (pref) sub = pickTrack(t.subs, pref);
  else sub = t.subs.find((x) => x.ord === t.defaultSub) || null;
  if (subMode !== 'soft') sub = null;
  subOrd = sub ? sub.ord : null;
  applyTracks();
}
function applyTracks() {
  for (const el of Array.from(player.querySelectorAll('track'))) el.remove();
  subEls = [];
  if (!trackInfo || subMode !== 'soft' || !trackInfo.subs.length) { subOrd = null; return; }
  for (const s of trackInfo.subs) {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = s.label;
    el.srclang = s.lang || 'und';
    el.src = '/api/tracks/vtt?src=' + encodeURIComponent(trackSrc) + '&i=' + s.ord + '&seek=' + trackSeek;
    player.appendChild(el);
    subEls.push({ ord: s.ord, el });
  }
  selectSub(subOrd);
}
// The sidecar is extracted on the server in the background — reading the cues
// means reading the whole file — so it may not be there yet. Ask again until
// it turns up; nobody waits on it.
let subPoll = null, subTries = 0;
function pollSubs() {
  if (subPoll) clearTimeout(subPoll);
  subPoll = null;
  if (subOrd === null || !subEls.length) return;
  subPoll = setTimeout(async () => {
    subPoll = null;
    const s = subEls.find((x) => x.ord === subOrd);
    if (!s) return;
    const tt = s.el.track;
    if (tt && tt.cues && tt.cues.length) return; // it arrived
    if (++subTries > 60) return;                  // give up after five minutes
    const url = '/api/tracks/vtt?src=' + encodeURIComponent(trackSrc) + '&i=' + subOrd +
      '&seek=' + trackSeek + '&r=' + Date.now();
    try {
      const r = await fetch(url);
      if (r.ok) s.el.src = url;
    } catch (e) { /* try again */ }
    pollSubs();
  }, 5000);
}
function selectSub(ord) {
  subOrd = ord;
  subTries = 0;
  for (const s of subEls) {
    const tt = s.el.track || (s.el.textTracks && s.el.textTracks[0]); // Chrome: el.track
    if (!tt) continue;
    tt.mode = (ord !== null && s.ord === ord) ? 'showing' : 'disabled';
  }
  renderTracksPanel();
  pollSubs();
}
function renderTracksPanel() {
  const s = $('tracks-subs'), btn = $('tracks-btn');
  const a = $('tracks-audio');
  if (!s) return;
  s.textContent = '';
  if (a) a.textContent = '—';
  if (!trackInfo) {
    s.textContent = '—';
    if (btn) { btn.textContent = 'CC'; btn.classList.remove('on'); btn.title = 'subtitles'; }
    return;
  }
  // Which audio is playing — the server picks it, and this says which.
  if (a) {
    const t = (trackInfo.audio || [])[trackInfo.audioOrd];
    a.textContent = (t && (t.label || t.lang)) || '—';
  }
  if (subMode !== 'soft') {
    // The subtitles are in the picture already, or there are none — nothing to pick.
    s.textContent = subMode === 'hard' ? 'burnt in' : 'none';
    if (btn) {
      btn.textContent = 'CC';
      btn.classList.remove('on');
      btn.title = subMode === 'hard' ? 'subtitles are burnt into the picture' : 'no subtitles';
    }
    return;
  }
  const off = document.createElement('button');
  off.textContent = 'off';
  if (subOrd === null) off.classList.add('on');
  off.onclick = () => { storePref(SUB_KEY, 'off'); selectSub(null); };
  s.appendChild(off);
  for (const t of trackInfo.subs) {
    const b = document.createElement('button');
    b.textContent = t.label;
    if (subOrd === t.ord) b.classList.add('on');
    b.onclick = () => { storePref(SUB_KEY, t.lang || String(t.ord)); selectSub(t.ord); };
    s.appendChild(b);
  }
  if (btn) {
    const sub = trackInfo.subs.find((x) => x.ord === subOrd);
    btn.textContent = 'CC';
    btn.classList.toggle('on', !!sub);
    btn.title = sub ? 'subtitles: ' + sub.label : 'subtitles';
  }
}
$('tracks-btn').onclick = () => {
  const p = $('tracks-panel');
  if (p) p.classList.toggle('hidden');
};
// The browser forgets which track was on when the media changes.
player.addEventListener('loadedmetadata', () => { if (subOrd !== null) selectSub(subOrd); });

// --- channel up/down
function stepChannel(d) {
  if (!lineup || !lineup.channels.length) return;
  goChannel((channelIdx + d + lineup.channels.length) % lineup.channels.length);
}
$('ch-up').onclick = () => stepChannel(1);
$('ch-down').onclick = () => stepChannel(-1);
$('shuffle').onclick = () => {
  const n = (lineup && lineup.channels || []).length;
  if (n < 2) return;
  let i = channelIdx;
  while (i === channelIdx) i = Math.floor(Math.random() * n); // never land on the same one
  goChannel(i);
};

// --- live / seek / sound
function paintSeek() { $('fwd').disabled = (manualOffset || 0) <= 0; } // at the live edge, 15s-fwd has nowhere to go
$('play-pause').onclick = () => {
  if (player.paused) { tryPlay(); } else { player.pause(); }
};
player.addEventListener('play', () => { $('play-pause').textContent = '⏸'; });
player.addEventListener('pause', () => { $('play-pause').textContent = '▶'; });
$('rewind').onclick = () => { manualOffset = (manualOffset || 0) + 15000; lastItem = null; paintSeek(); tick(); };
$('fwd').onclick = () => { manualOffset = Math.max(0, (manualOffset || 0) - 15000); lastItem = null; paintSeek(); tick(); };
$('goto-live').onclick = () => { manualOffset = null; lastItem = null; paintSeek(); tick(); };
paintSeek();
$('mute').onclick = () => {
  player.muted = !player.muted;
  if (adMusic) adMusic.muted = player.muted;
  $('mute').textContent = player.muted ? '🔇' : '🔊';
  if (!player.muted) $('sound-hint').classList.add('hidden');
};
$('fullscreen').onclick = () => {
  const el = $('stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen();
};
// Double-clicking the picture does the same as the ⛶ button — in, and out.
player.addEventListener('dblclick', () => $('fullscreen').onclick());
$('sound-hint').onclick = () => {
  player.muted = false;
  if (adMusic) adMusic.muted = false;
  $('sound-hint').classList.add('hidden');
  $('mute').textContent = '🔊';
  player.play().catch(() => {}); // the tap is a user gesture → sound + play is now allowed
};

// --- chat (per-channel room by default; optional GLOBAL room where everyone
//     talks to everyone; chat effects never fire in the global room) ---
const socket = io();
let chatGlobal = false;         // true → global chat
let currentRoom = null;         // the room this socket is currently in
function chatRoom() { return chatGlobal ? 'global' : (channel() ? channel().id : null); }
function paintChatTitle() {
  $('chat-title').textContent = chatGlobal ? 'CHAT — GLOBAL (everyone)' : 'CHAT — ' + (channel() ? channel().name : '');
  const mb = $('chat-mode'); if (mb) mb.textContent = chatGlobal ? '🌐 switch to channel chat' : '📺 switch to global chat';
}
function ensureRoom() {
  const want = chatRoom();
  if (want === currentRoom) return;
  if (currentRoom) socket.emit('chat:leave', currentRoom);
  currentRoom = want;
  if (want) socket.emit('chat:join', want);
  paintChatTitle();
}
function joinChat() { ensureRoom(); }
socket.on('connect', () => joinChat());
function renderMsg(m) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<b>${escapeHtml(m.name)}</b> ${escapeHtml(m.text)}`;
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
socket.on('chat:message', (m) => renderMsg(m));
socket.on('chat:history', (msgs) => { const log = $('chat-log'); log.innerHTML = ''; (msgs || []).forEach(renderMsg); });
socket.on('chat:count', (n) => { viewerCount = Math.max(0, n | 0); paintChatCount(); });
socket.on('chat:denied', (reason) => {
  if (reason === 'auth') { chatMode = 'users'; applyChatGate(); }
  else { const n = $('chat-name'); n.focus(); n.placeholder = 'pick a name first'; }
});
socket.on('chat:throttled', () => {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = 'msg throttle';
  div.textContent = '⏳ slow down — that’s a lot of characters for a minute';
  log.appendChild(div); log.scrollTop = log.scrollHeight;
});
const modeBtn = $('chat-mode');
if (modeBtn) modeBtn.onclick = () => { chatGlobal = !chatGlobal; ensureRoom(); };
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const room = chatRoom();
  if (!room) return;
  const n = $('chat-name');
  const name = n.value.trim();
  if (!name) { n.focus(); n.placeholder = 'pick a name first'; return; } // anonymous chatter is blocked
  const text = $('chat-input').value.trim();
  if (!text) return;
  socket.emit('chat:message', room, { name, text });
  $('chat-input').value = '';
}
'📺 🔥 😂 👀 💾 📼 ☕ ✨'.split(' ').forEach((e) => {
  const b = document.createElement('button');
  b.textContent = e;
  b.onclick = () => { $('chat-input').value = e; sendChat(); };
  $('emojis').appendChild(b);
});

socket.on('settings:update', (s) => applySettings(s));
socket.on('chat:effect', (e) => {
  const fx = window.chaFX; if (!fx || !e || !e.kind) return;
  if (e.kind === 'emoji' && e.value) fx.emoji(e.value);
  else if (e.kind === 'fireworks') fx.fireworks();
  else if (e.kind === 'confetti') fx.confetti();
});
socket.on('broadcast:update', () => { lastItem = null; stopAdMusic(); manifestCache.clear(); tick(); });
socket.on('lineup:update', () => {
  manifestCache.clear();
  if (channelIdx >= lineup.channels.length) channelIdx = 0;
  loadLineup().then(() => { lastItem = null; stopAdMusic(); paintChannel(); joinChat(); tick(); });
});

// --- boot
(async () => {
  await loadLineup();
  // Land on the channel this browser was last watching.
  const last = rememberedChannel();
  if (last) {
    const i = (lineup.channels || []).findIndex((c) => c.id === last);
    if (i >= 0) { channelIdx = i; paintChannel(); }
  }
  loadMe();
  loadSiteName();
  joinChat();
  tick();
  setInterval(tick, 1000);
  setInterval(renderGuide, 60000); // keep the "now" line + block positions fresh
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowUp') stepChannel(1);
    if (e.key === 'ArrowDown') stepChannel(-1);
  });
})();
