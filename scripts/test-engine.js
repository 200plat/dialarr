const assert = require('assert');
const E = require('../public/engine.js');

const manifest = {
  items: [
    { id: 'a', duration: 10 },
    { id: 'b', duration: 20 },
    { id: 'c', duration: 30, isAd: true }
  ]
};
const bumpMs = 5000;
// loop = 60s items + 3*5s bumps = 75s
const version = { v: 1, epochMs: 1_000_000, effectiveAtMs: 1_000_000, startIndex: 0 };

assert.strictEqual(E.loopMs(manifest, bumpMs), 75000, 'loop length');

// at epoch: item a starts
let p = E.positionAt(manifest, version, 1_000_000, bumpMs);
assert.strictEqual(p.item.id, 'a');
assert.strictEqual(p.offsetMs, 0);

// 10s in: gap after a (bump)
p = E.positionAt(manifest, version, 1_010_000, bumpMs);
assert.ok(p.bump && p.afterIndex === 0, 'bump after item a, got ' + JSON.stringify(p));

// 15s in: item b at offset 0
p = E.positionAt(manifest, version, 1_015_000, bumpMs);
assert.strictEqual(p.item.id, 'b');
assert.strictEqual(p.offsetMs, 0);

// 22s in: item b at 7s
p = E.positionAt(manifest, version, 1_022_000, bumpMs);
assert.strictEqual(p.item.id, 'b');
assert.strictEqual(p.offsetMs, 7000);

// wraps: 74s in = last bump of c; 75s wraps to item a
p = E.positionAt(manifest, version, 1_074_000, bumpMs);
assert.ok(p.bump && p.afterIndex === 2, 'wrap bump, got ' + JSON.stringify(p));
p = E.positionAt(manifest, version, 1_075_000, bumpMs);
assert.strictEqual(p.item.id, 'a');

// before epoch (clock in future of a new version): clamps into loop, no crash
p = E.positionAt(manifest, version, 1_000_000 - 30_000, bumpMs);
assert.ok(p.item || p.bump, 'pre-epoch returns something sane');

// time-shift: publishing epoch + 10s shifts position 10s backward
const shifted = { ...version, v: 2, epochMs: version.epochMs + 10_000 };
const now = 1_020_000;
const before = E.positionAt(manifest, version, now, bumpMs);
const after = E.positionAt(manifest, shifted, now, bumpMs);
assert.strictEqual(before.item.id, 'b');
assert.strictEqual(before.offsetMs, 5000);
assert.ok(after.bump && after.afterIndex === 0, 'shifted back 10s lands in bump after a, got ' + JSON.stringify(after));

// activeVersion picks latest effective version
const ch = { versions: [version, { v: 2, epochMs: 2_000_000, effectiveAtMs: 2_000_000, startIndex: 0 }] };
assert.strictEqual(E.activeVersion(ch, 1_500_000).v, 1);
assert.strictEqual(E.activeVersion(ch, 2_500_000).v, 2);
assert.strictEqual(E.activeVersion(ch, 999_999), null);

// liveFilePos: the live pipe's clock starts at 0, so the player's currentTime is an
// offset from the seek point — the position in the file is the seek plus that offset.
assert.strictEqual(E.liveFilePos('/stream/live?src=x&seek=100', 30), 130);
assert.strictEqual(E.liveFilePos('/stream/live?src=x&seek=0', 30), 30);
assert.strictEqual(E.liveFilePos('/stream/live?src=x&seek=100', 0), 100);
assert.strictEqual(E.liveFilePos('/stream/live?src=x', 12.7), 12);
assert.strictEqual(E.liveFilePos('', 0), 0);

// liveSrcOf: which file the live pipe is serving
assert.strictEqual(E.liveSrcOf('/stream/live?src=%2Fcontent%2FShow%2Fx.mkv&seek=10'), '/content/Show/x.mkv');
assert.strictEqual(E.liveSrcOf('http://h/stream/live?src=%2Fcontent%2FA%20B.mkv&seek=3'), '/content/A B.mkv');
assert.strictEqual(E.liveSrcOf('/transcodes/abc.mp4'), '');

console.log('engine: all tests passed');
