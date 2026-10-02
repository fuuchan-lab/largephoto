// node test/register.test.mjs
import { makeFeatures, register, registerNear, scalesFor } from '../js/register.js';

// 疑似「地図」画像を作る（道路っぽい線＋ブロック＋ノイズ）
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeWorld(W, H, seed = 1) {
  const r = rng(seed);
  const img = new Uint8Array(W * H).fill(235);
  const rect = (x, y, w, h, v) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) img[yy * W + xx] = v;
  };
  for (let i = 0; i < 400; i++) rect((r() * W) | 0, (r() * H) | 0, (20 + r() * 200) | 0, (20 + r() * 200) | 0, (150 + r() * 80) | 0);
  for (let i = 0; i < 120; i++) {
    if (r() < 0.5) rect(0, (r() * H) | 0, W, (3 + r() * 10) | 0, 255);
    else rect((r() * W) | 0, 0, (3 + r() * 10) | 0, H, 255);
  }
  for (let i = 0; i < 3000; i++) rect((r() * W) | 0, (r() * H) | 0, (4 + r() * 30) | 0, (2 + r() * 6) | 0, (40 + r() * 60) | 0);
  for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(255, img[i] + (r() - 0.5) * 6));
  return img;
}
function crop(img, W, x, y, w, h) {
  const out = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) out.set(img.subarray((y + yy) * W + x, (y + yy) * W + x + w), yy * w);
  return out;
}

const W = 6000, H = 6000;
const world = makeWorld(W, H, 7);
const fw = 1179, fh = 2000;
const scales = scalesFor(fw, fh);
let fail = 0;
const cases = [
  [[1000, 1000], [1400, 1300]],
  [[1000, 1000], [1000, 2500]],   // 縦に 25% 重なり
  [[1000, 1000], [1900, 1000]],   // 横に 24% 重なり
  [[1000, 1000], [600, 400]],
  [[1000, 1000], [1003, 1017]],   // 小さな移動
  [[2000, 2000], [1300, 3100]],
];
for (const [[ax, ay], [bx, by]] of cases) {
  const t0 = performance.now();
  const fa = makeFeatures(crop(world, W, ax, ay, fw, fh), fw, fh, scales);
  const fb = makeFeatures(crop(world, W, bx, by, fw, fh), fw, fh, scales);
  const t1 = performance.now();
  const r = register(fa, fb);
  const t2 = performance.now();
  const ok = r && r.dx === bx - ax && r.dy === by - ay;
  if (!ok) fail++;
  console.log(ok ? 'OK ' : 'NG ', 'expect', bx - ax, by - ay, 'got', r && [r.dx, r.dy, r.score.toFixed(3), r.overlap.toFixed(2)],
    `feat ${(t1 - t0).toFixed(0)}ms reg ${(t2 - t1).toFixed(0)}ms`);
}
// 重ならない場合は低スコアになること
{
  const fa = makeFeatures(crop(world, W, 100, 100, fw, fh), fw, fh, scales);
  const fb = makeFeatures(crop(world, W, 3500, 3500, fw, fh), fw, fh, scales);
  const r = register(fa, fb);
  console.log('no-overlap score', r && r.score.toFixed(3));
  if (r && r.score > 0.5) { fail++; console.log('NG false positive'); }
}
// registerNear
{
  const fa = makeFeatures(crop(world, W, 1000, 1000, fw, fh), fw, fh, scales);
  const fb = makeFeatures(crop(world, W, 1500, 1800, fw, fh), fw, fh, scales);
  const r = registerNear(fa, fb, 470, 830, 80);
  const ok = r && r.dx === 500 && r.dy === 800;
  if (!ok) fail++;
  console.log(ok ? 'OK ' : 'NG ', 'near', r && [r.dx, r.dy, r.score.toFixed(3)]);
}
if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all passed');
