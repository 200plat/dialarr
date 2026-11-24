// End-to-end verification against the running server on :3005.
const BASE = process.env.BASE || 'http://localhost:3005';
const ioc = require('socket.io-client');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const jget = async (p) => (await (await fetch(BASE + p)).json());
const jpost = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());

(async () => {
  console.log('health + pages');
  ok((await jget('/api/health')).status === 'ok', 'health');
  const idx = await (await fetch(BASE + '/')).text();
  ok(idx.includes('id="guide"'), 'index has GUIDE section');
  ok(idx.includes('id="prog"'), 'index has progress bar');
  ok(idx.includes('id="ad-music"'), 'index has ad-music');
  ok(idx.includes('easter-eggs.js'), 'index loads easter-eggs');
  ok((await fetch(BASE + '/easter-eggs.js')).status === 200, 'easter-eggs.js served');
  ok((await fetch(BASE + '/media/ad-music.mp3')).status === 200, 'ad-music.mp3 served');
  const adm = await (await fetch(BASE + '/admin.html')).text();
  ok(adm.includes('id="c-lines"') && adm.includes('id="i-detect"'), 'admin has wizard (quips + detect)');

  console.log('the tabbed console');
  const tabs = await (await fetch(BASE + '/admin.html')).text();
  ok(tabs.includes('id="tabs"'), 'the console has the tab bar');
  for (const p of ['tab-channels', 'tab-onair', 'tab-transcode', 'tab-flags', 'tab-site', 'tab-members', 'tab-backup', 'tab-info']) {
    ok(tabs.includes(`id="${p}"`), 'the console has the ' + p + ' panel');
  }
  for (const i of ['tc-cache-now', 'user-list', 'ch-list', 'items', 'onair-list', 'mode-add', 'mode-lib', 'sec-draft', 'blocked-names', 'info-box', 'tc-audio-lang', 'tc-sub-lang', 'tc-sub-mode', 'ch-submode']) {
    ok(tabs.includes(`id="${i}"`), 'the console has #' + i);
  }
  ok(adm.includes('id="c-lines"'), 'the console still has the quips box');
  const old = await fetch(BASE + '/admin.htm', { redirect: 'manual' });
  ok(old.status === 301, 'the old /admin.htm URL still points at the console');

  console.log('transcode cache view');
  const tc = await jget('/api/admin/transcodes');
  ok(!!tc && !!tc.counts && typeof tc.bytes === 'number' && typeof tc.diskBytes === 'number' && Array.isArray(tc.list), 'transcodes endpoint has the shape the console reads');

  console.log('probe (duration detect)');
  const p1 = await jpost('/api/admin/probe', { src: '/media/test.mp4' });
  ok(p1.duration >= 25 && p1.duration <= 40, 'probe test.mp4 → ' + (p1.duration || p1.error) + 's');

  console.log('publish a generated commercial + tapes, then read it back');
  const lineup = await jget('/api/lineup');
  const ch = lineup.channels[0];
  const items = [
    { title: 'Test Tape A', src: '/media/test.mp4', duration: 30 },
    { title: 'Commercial', src: '', duration: 15, isAd: true, adSlides: ['stay tuned', 'brought to you by vibes', 'thank you for watching'], music: '/media/ad-music.mp3' },
    { title: 'Test Tape B', src: '/media/tape2.mp4', duration: 45, isAd: false }
  ];
  const pub = await jpost('/api/admin/publish', { channel: ch.id, items, startIndex: 0 });
  ok(pub.ok === true && pub.count === 3, 'publish ok (v' + pub.v + ', ' + pub.count + ' items)');
  const fresh = await jget('/api/lineup');
  const last = fresh.channels.find(c => c.id === ch.id).versions.slice(-1)[0];
  const mv = await jget('/broadcast/' + last.manifest);
  const gen = mv.items.find(i => i.adSlides);
  ok(!!gen, 'manifest has a generated-ad item');
  ok(gen && gen.adSlides.length === 3 && gen.music === '/media/ad-music.mp3', 'gen-ad kept slides + music');
  ok(mv.items.every(i => i.duration > 0), 'all items have positive duration');

  console.log('chat: sender sees own message + a second client sees it');
  await new Promise((resolve) => {
    const a = ioc(BASE, { transports: ['websocket'] });
    const b = ioc(BASE, { transports: ['websocket'] });
    let aGot = 0, bGot = 0, done = false;
    const finish = (m) => { if (done) return; done = true;
      ok(aGot >= 1, 'A (sender) received own message (aGot=' + aGot + ')');
      ok(bGot >= 1, 'B (other) received message (bGot=' + bGot + ')');
      a.close(); b.close(); resolve(); };
    a.on('chat:message', () => { aGot++; if (aGot >= 1 && bGot >= 1) finish(); });
    b.on('chat:message', () => { bGot++; if (aGot >= 1 && bGot >= 1) finish(); });
    a.on('connect', () => { a.emit('chat:join', ch.id); b.emit('chat:join', ch.id);
      setTimeout(() => { a.emit('chat:message', ch.id, { name: 'tester', text: 'hello' }); }, 150);
      setTimeout(() => finish('timeout'), 2500); });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
