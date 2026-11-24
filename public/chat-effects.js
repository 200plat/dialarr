/* Self-contained one-shot chat pop-up effects over the video (#stage).
   Emoji pop + a compact fireworks/confetti burst. Zero deps. It creates its own
   canvas + overlay here (index.html and style.css are untouched) and exposes
   window.chaFX. app.js drives it from the socket 'chat:effect' event so every
   viewer in the channel sees the same pop. The rAF loop only runs while there
   are live particles, then stops itself (no idle cost). */
(function () {
  'use strict';
  const stage = document.getElementById('stage');
  if (!stage) return;

  // --- overlay layers (positioned over the video; pointer-events none) ---
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20';
  const fx = document.createElement('div');
  fx.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:21';
  const ctx = canvas.getContext('2d');
  stage.appendChild(canvas);
  stage.appendChild(fx);

  // emoji pop: fade in fast, hold, drift up + fade out (position set inline per pop)
  const st = document.createElement('style');
  st.textContent =
    '@keyframes fxpop{0%{transform:translate(-50%,-50%) scale(.2);opacity:0}' +
    '28%{transform:translate(-50%,-50%) scale(1);opacity:1}' +
    '100%{transform:translate(-50%,calc(-50% - 48px)) scale(1.06);opacity:0}}' +
    '.fx-emoji{position:absolute;transform:translate(-50%,-50%) scale(.2);opacity:0;' +
    'font-size:min(22vmin,120px);line-height:1;pointer-events:none;will-change:transform,opacity;' +
    'animation:fxpop .95s ease-out forwards}';
  document.head.appendChild(st);

  let W = 0, H = 0, raf = 0, running = false, last = 0;
  const FIRE = [], CONF = [];
  const PAL = ['#FFD23F', '#FF6F00', '#5AC8FF', '#FF5E62', '#9dffb0', '#e2b3ff'];
  const TAU = Math.PI * 2;

  function resize() {
    const r = stage.getBoundingClientRect();
    W = canvas.width = Math.max(1, Math.round(r.width));
    H = canvas.height = Math.max(1, Math.round(r.height));
  }
  window.addEventListener('resize', resize);
  resize();

  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ctx.clearRect(0, 0, W, H);
    for (let i = FIRE.length - 1; i >= 0; i--) {
      const p = FIRE[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt; p.life -= dt;
      if (p.life <= 0) { FIRE.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    }
    for (let i = CONF.length - 1; i >= 0; i--) {
      const c = CONF[i];
      c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 120 * dt; c.rot += c.vr * dt;
      if (c.y > H + 24) { CONF.splice(i, 1); continue; }
      ctx.globalAlpha = 1; ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.fillStyle = c.c; ctx.fillRect(-c.s / 2, -c.s / 4, c.s, c.s / 2); ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (FIRE.length || CONF.length) raf = requestAnimationFrame(loop);
    else { running = false; ctx.clearRect(0, 0, W, H); }
  }
  function kick() { if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(loop); } }

  function emoji(ch) {
    if (typeof ch !== 'string' || !ch) return;
    const el = document.createElement('div');
    el.className = 'fx-emoji'; el.textContent = ch; el.setAttribute('aria-hidden', 'true');
    el.style.left = (22 + Math.random() * 56) + '%';
    el.style.top = (62 + Math.random() * 18) + '%';   // lower-middle of the video, ~1/5–1/3 up, then rises
    fx.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 1600);              // safety net if animationend never fires
  }
  function fireworks() {
    resize();
    const n = 3 + (Math.random() * 3 | 0);            // 3–5 bursts
    for (let b = 0; b < n; b++) {
      const cx = W * (0.2 + Math.random() * 0.6), cy = H * (0.12 + Math.random() * 0.3);
      const c = PAL[(Math.random() * PAL.length) | 0];
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * TAU, sp = 120 + Math.random() * 240;
        FIRE.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, r: 1.6 + Math.random() * 2.2, c, life: 0.9 + Math.random() * 0.6, max: 1.5 });
      }
    }
    kick();
  }
  function confetti() {
    resize();
    for (let i = 0; i < 90; i++) {
      CONF.push({
        x: Math.random() * W, y: -10 - Math.random() * H * 0.3,
        vx: (Math.random() - 0.5) * 60, vy: 40 + Math.random() * 80,
        rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 12,
        s: 6 + Math.random() * 8, c: PAL[(Math.random() * PAL.length) | 0]
      });
    }
    kick();
  }

  window.chaFX = { emoji, fireworks, confetti };
})();
