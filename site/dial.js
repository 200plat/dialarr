// Dialarr — the landing page's television.
//
// The channels below are invented. A real Dialarr shows whatever is in your own
// library; that is the whole point. The guide and the screen are driven by one
// clock, exactly like the real thing — this copy runs that clock sixty times faster
// so you can see the guide move.

const CHANNELS = [
  { dial: 2, emoji: '🎬', name: 'Monster Matinee', offset: 12, items: [
    { t: 'Gravel (1958)', m: 74 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'The Attic (1961)', m: 68 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'Night of the Puppet (1974)', m: 81 }, { t: 'Commercial', m: 2, ad: 1 } ] },
  { dial: 3, emoji: '☕', name: 'Sitcom Central', offset: 30, items: [
    { t: 'Two Couches (1979)', m: 24 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'The Neighbours (1984)', m: 24 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'Desk Job (1991)', m: 24 }, { t: 'Commercial', m: 2, ad: 1 } ] },
  { dial: 4, emoji: '🍕', name: 'Saturday Cartoons', offset: 3, items: [
    { t: 'Captain Fleece (1968)', m: 11 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'The Blob Brigade (1972)', m: 11 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'Mystery Machine Kid (1980)', m: 11 } ] },
  { dial: 5, emoji: '👻', name: 'Late Night Horror', offset: 47, items: [
    { t: 'Hollow House (1969)', m: 88 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'Midnight Aisle (1977)', m: 91 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'The Long Drive (1983)', m: 84 } ] },
  { dial: 6, emoji: '🌍', name: 'Wild Earth', offset: 21, items: [
    { t: 'Prairie Year (1988)', m: 48 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'The Herd (1993)', m: 47 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'Tide Pools (1999)', m: 52 } ] },
  { dial: 7, emoji: '🎤', name: 'Music Video Midnights', offset: 8, items: [
    { t: 'Neon Harbour (1985)', m: 4 }, { t: 'Static Bloom (1990)', m: 4 },
    { t: 'Chrome (1994)', m: 5 }, { t: 'Nightdrive (1997)', m: 4 },
    { t: 'Commercial', m: 2, ad: 1 } ] },
  { dial: 8, emoji: '📡', name: 'News and Weather', offset: 5, items: [
    { t: 'Evening Bulletin', m: 12 }, { t: 'Weather Centre', m: 8 },
    { t: 'Market Report', m: 9 }, { t: 'Commercial', m: 2, ad: 1 } ] },
  { dial: 9, emoji: '⏪', name: 'The Rewind Channel', offset: 17, items: [
    { t: 'Countdown (1982)', m: 25 }, { t: "Yesterday's Broadcast", m: 25 },
    { t: 'Retro Hour', m: 25 }, { t: 'Commercial', m: 2, ad: 1 } ] },
  { dial: 10, emoji: '🎭', name: 'The Silver Screen', offset: 63, items: [
    { t: 'Analog Hearts (1994)', m: 96 }, { t: 'Commercial', m: 2, ad: 1 },
    { t: 'Premiere (1962)', m: 88 }, { t: 'Commercial', m: 2, ad: 1 } ] },
  { dial: 11, emoji: '🍿', name: 'Movie Night', offset: 39, items: [
    { t: 'The Long Signal (1996)', m: 102 }, { t: 'Double Feature', m: 104 },
    { t: 'Commercial', m: 2, ad: 1 } ] }
];

const BACK = 30;    // minutes of guide shown before now
const FWD = 150;    // minutes shown after now
const SPEED = 60;   // broadcast minutes per real second

for (const ch of CHANNELS) {
  ch.loop = ch.items.reduce((s, i) => s + i.m, 0);
  ch.bounds = [];
  let acc = 0;
  for (const it of ch.items) { ch.bounds.push({ item: it, start: acc }); acc += it.m; }
}

const T0 = Date.now();
const dialEl = document.getElementById('dial');
const rowsEl = document.getElementById('guide-rows');
const axisEl = document.getElementById('axis');
let selected = CHANNELS[0];

// minutes of broadcast time since the page opened
const nowMin = () => (Date.now() - T0) / 1000 * SPEED / 60;
const mod = (a, n) => ((a % n) + n) % n;

// every item of every channel that falls inside the guide window
function timeline(ch, now) {
  const A = now - BACK, B = now + FWD;
  const base = now - mod(ch.offset + now, ch.loop);
  const out = [];
  for (const b of ch.bounds) {
    const kMin = Math.floor((A - base - b.start) / ch.loop);
    const kMax = Math.ceil((B - base - b.start) / ch.loop);
    for (let k = kMin; k <= kMax; k++) {
      const abs = base + b.start + k * ch.loop;
      if (abs + b.item.m > A && abs < B) out.push({ item: b.item, abs });
    }
  }
  return out.sort((x, y) => x.abs - y.abs);
}

function liveItem(ch, now) {
  for (const b of timeline(ch, now)) {
    if (b.abs <= now && now < b.abs + b.item.m) return b;
  }
  return timeline(ch, now)[0] || null;
}

// the wall clock as the broadcast sees it — this copy runs fast so the guide moves
const broadcastWall = () => Date.now() + (Date.now() - T0) * (SPEED - 1);
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};
const mins = (m) => Math.floor(m) + ':' + pad(Math.round((m % 1) * 60));

// ---------- the dial ----------

for (const ch of CHANNELS) {
  const b = document.createElement('button');
  b.className = 'dial-ch';
  b.type = 'button';
  b.setAttribute('aria-pressed', ch === selected ? 'true' : 'false');
  b.innerHTML = '<span>' + pad(ch.dial) + '</span><span class="d-emoji">' + ch.emoji + '</span>';
  b.title = ch.name;
  b.setAttribute('aria-label', 'Channel ' + ch.dial + ', ' + ch.name);
  b.onclick = () => select(ch);
  dialEl.appendChild(b);
}

function select(ch) {
  selected = ch;
  [...dialEl.children].forEach((b, i) => b.setAttribute('aria-pressed', CHANNELS[i] === ch ? 'true' : 'false'));
  paint();
}

// ---------- the guide ----------

const axisTicks = [];
for (let m = -BACK; m <= FWD; m += 30) axisTicks.push(m);

function buildGuide() {
  const rows = [];
  for (const ch of CHANNELS) {
    const row = document.createElement('div');
    row.className = 'tvg-row';
    row.dataset.dial = ch.dial;

    const label = document.createElement('button');
    label.className = 'tvg-label';
    label.type = 'button';
    label.innerHTML = '<span class="g-dial">' + pad(ch.dial) + '</span><span class="g-name">' + ch.emoji + ' ' + ch.name + '</span>';
    label.onclick = () => select(ch);

    const track = document.createElement('div');
    track.className = 'tvg-track';
    const now = document.createElement('span');
    now.className = 'tvg-now';
    now.style.left = (BACK / (BACK + FWD) * 100) + '%';
    track.appendChild(now);

    row.append(label, track);
    rows.push({ ch, row, track });
  }
  rowsEl.append(...rows.map((r) => r.row));
  return rows;
}
const rows = buildGuide();

function paintGuide(now) {
  const span = BACK + FWD;
  for (const r of rows) {
    r.row.classList.toggle('active', r.ch === selected);
    r.track.querySelectorAll('.tvg-block').forEach((n) => n.remove());
    for (const b of timeline(r.ch, now)) {
      const el = document.createElement('div');
      el.className = 'tvg-block' + (b.item.ad ? ' ad' : '');
      const live = b.abs <= now && now < b.abs + b.item.m;
      if (live) el.classList.add('live');
      // clip to the window: a block that started before it would otherwise paint
      // leftwards across the channel names
      const left = Math.max(0, (b.abs + BACK) / span * 100);
      const right = Math.min(span, (b.abs + b.item.m + BACK) / span * 100);
      el.style.left = left + '%';
      el.style.width = Math.max(0.6, right - left) + '%';
      const t = document.createElement('span');
      t.className = 'tvg-bt';
      t.textContent = b.item.t;
      el.appendChild(t);
      r.track.appendChild(el);
    }
  }
}

function paintAxis(now) {
  const span = BACK + FWD;
  axisEl.innerHTML = '';
  for (const m of axisTicks) {
    const t = document.createElement('span');
    t.className = 'tvg-tick';
    t.style.left = ((m + BACK) / span * 100) + '%';
    t.textContent = clock(broadcastWall() + m * 60000);
    axisEl.appendChild(t);
  }
}

// ---------- the screen ----------

const osdNum = document.getElementById('osd-num');
const osdCh = document.getElementById('osd-ch');
const osdTitle = document.getElementById('osd-title');
const osdFill = document.getElementById('osd-fill');
const osdClock = document.getElementById('osd-clock');
const osdPos = document.getElementById('osd-pos');

function paintScreen(now) {
  const live = liveItem(selected, now);
  osdNum.textContent = pad(selected.dial);
  osdCh.textContent = selected.emoji + ' ' + selected.name.toUpperCase();
  if (!live) return;
  osdTitle.textContent = live.item.t;
  const into = now - live.abs;
  osdFill.style.width = Math.min(100, (into / live.item.m) * 100) + '%';
  osdPos.textContent = mins(Math.max(0, into)) + ' / ' + mins(live.item.m);
}

function paint() {
  const now = nowMin();
  paintGuide(now);
  paintAxis(now);
  paintScreen(now);
}

// ---------- the clock ----------

function tick() {
  const now = nowMin();
  paintScreen(now);
  osdClock.textContent = clock(broadcastWall());
}

paint();
setInterval(tick, 1000);
setInterval(paint, 20000);
