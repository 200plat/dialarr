// Broadcast position math. Shared by the browser player and the node self-test.
(function (root) {
  'use strict';

  function activeVersion(channel, now) {
    const vs = (channel.versions || [])
      .filter(v => v.effectiveAtMs <= now)
      .sort((a, b) => a.v - b.v);
    return vs.length ? vs[vs.length - 1] : null;
  }

  function loopMs(manifest, bumpMs) {
    const items = manifest.items || [];
    return items.reduce((s, i) => s + i.duration * 1000, 0) + items.length * bumpMs;
  }

  // What is playing at time `now`? Walks the item loop starting at startIndex.
  // Returns {item, offsetMs} or {bump:true, afterItem} when inside a gap card.
  function positionAt(manifest, version, now, bumpMs) {
    bumpMs = bumpMs || 0;
    const items = manifest.items || [];
    const loop = loopMs(manifest, bumpMs);
    const n = items.length;
    if (!n || loop <= 0) return { offAir: true };
    const t = (((now - version.epochMs) % loop) + loop) % loop;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const idx = (version.startIndex + i) % n;
      const item = items[idx];
      const durMs = item.duration * 1000;
      if (t < acc + durMs) return { item: item, offsetMs: t - acc, index: idx };
      acc += durMs;
      if (bumpMs > 0 && t < acc + bumpMs) return { bump: true, afterIndex: idx };
      acc += bumpMs;
    }
    return { item: items[version.startIndex % n], offsetMs: 0, index: version.startIndex % n };
  }

  // Where in the FILE the live pipe is right now. The pipe's own clock starts at 0
  // (ffmpeg resets the timestamps after the -ss seek), so the player's currentTime is
  // an offset from the seek point, not a position in the file. Resuming where we
  // were needs the seek we started from plus that offset.
  function liveFilePos(src, currentTime) {
    const m = /[?&]seek=(\d+)/.exec(String(src || ''));
    return (m ? Number(m[1]) : 0) + Math.floor(Number(currentTime) || 0);
  }

  // The source a live pipe is serving — the src= parameter of the stream URL.
  function liveSrcOf(src) {
    const m = /[?&]src=([^&]*)/.exec(String(src || ''));
    return m ? decodeURIComponent(m[1]) : '';
  }

  const api = { activeVersion, loopMs, positionAt, liveFilePos, liveSrcOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.dialarrEngine = api;
})(typeof self !== 'undefined' ? self : this);
