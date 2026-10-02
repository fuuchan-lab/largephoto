// ブラウザでの通し試験: node test/e2e.mjs
// 疑似地図からスクショ／動画を作り、アプリに読み込ませて書き出し結果を元画像と比べる。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = path.join(process.env.TMPDIR || os.tmpdir(), 'largephoto-e2e');
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const f = p.endsWith('/') ? p + 'index.html' : p;
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(url);

// 疑似地図（世界）を作り、指定位置の「スクショ」を PNG で返す関数をページに置く
await page.evaluate(() => {
  const W = 3000, H = 3000;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let s = 42; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = '#eef0e6'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 160; i++) { g.fillStyle = `hsl(${90 + r() * 120},40%,${70 + r() * 15}%)`; g.fillRect(r() * W, r() * H, 40 + r() * 300, 40 + r() * 300); }
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  for (let i = 0; i < 60; i++) { g.lineWidth = 4 + r() * 12; g.beginPath(); g.moveTo(r() * W, r() * H); g.bezierCurveTo(r() * W, r() * H, r() * W, r() * H, r() * W, r() * H); g.stroke(); }
  g.fillStyle = '#334'; g.font = '22px sans-serif';
  for (let i = 0; i < 500; i++) g.fillText('地点' + i, r() * W, r() * H);
  window.__world = c;
  window.__shot = (x, y, w = 390, h = 844) => {
    const o = document.createElement('canvas'); o.width = w; o.height = h;
    const q = o.getContext('2d');
    q.drawImage(c, x, y, w, h, 0, 0, w, h);
    // 動かないUI（検索バー・タブバー）
    q.fillStyle = '#fff'; q.fillRect(0, 0, w, 100); q.fillStyle = '#888'; q.fillRect(20, 40, w - 40, 44);
    q.fillStyle = '#fafafa'; q.fillRect(0, h - 100, w, 100); q.fillStyle = '#39f'; q.fillRect(30, h - 80, 60, 50);
    return o.toDataURL('image/png');
  };
});

async function saveShot(name, x, y) {
  const d = await page.evaluate(([x, y]) => window.__shot(x, y), [x, y]);
  const f = path.join(tmp, name);
  await writeFile(f, Buffer.from(d.split(',')[1], 'base64'));
  return f;
}

// ---- 1) スクリーンショット（3×3 のグリッド、約30%重なり、順番はばらばら）----
const pos = [];
for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) pos.push([600 + i * 270, 500 + j * 450]);
const files = [];
for (let k = 0; k < pos.length; k++) files.push(await saveShot(`s${k}.png`, pos[k][0], pos[k][1]));

let fail = 0;
const check = (cond, msg) => { console.log(cond ? 'OK ' : 'NG ', msg); if (!cond) fail++; };

await page.setInputFiles('#fileImages', files);
await page.waitForSelector('#dlgCrop[open]');
await page.click('#dlgCrop [data-ok]');
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open && window.largephoto.mosaic.tiles.length === 9, null, { timeout: 60000 });
const tiles = await page.evaluate(() => window.largephoto.mosaic.tiles.map((t) => ({ id: t.id, x: t.x, y: t.y, placed: t.placed })));
console.log(tiles);
// 期待される相対位置（1枚目基準）
const t0 = tiles.find((t) => t.id === 1);
let posOk = true;
for (const t of tiles) {
  const e = pos[t.id - 1];
  if (!t.placed || t.x - t0.x !== e[0] - pos[0][0] || t.y - t0.y !== e[1] - pos[0][1]) posOk = false;
}
check(posOk, 'スクショ9枚の位置が正確');
await page.screenshot({ path: path.join(tmp, 'ui-images.png') });

// 書き出して元画像と比較
const diff = await page.evaluate(async ([x0, y0]) => {
  const { mosaic } = window.largephoto;
  const c = await mosaic.exportCanvas({ scale: 1 });
  const crop = 844 * 0.13 | 0; // 既定の上部除外
  const bb = mosaic.bbox();
  const ctx = c.getContext('2d');
  const a = ctx.getImageData(0, 0, c.width, c.height).data;
  const w = document.createElement('canvas'); w.width = c.width; w.height = c.height;
  w.getContext('2d').drawImage(window.__world, x0 + Math.round(390 * 0) , y0 + Math.round(844 * 0.13), c.width, c.height, 0, 0, c.width, c.height);
  const b = w.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return { mad: s / (a.length / 4 * 3), w: c.width, h: c.height, bb };
}, pos[0]);
console.log('export', diff);
check(diff.mad < 2, `書き出し画像が元の地図と一致（平均差 ${diff.mad.toFixed(2)}）`);

// 書き出しダイアログ経由
await page.click('#btnExport');
await page.click('#expGo');
await page.waitForSelector('#expDownload:not([hidden])', { timeout: 30000 });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#expDownload')]);
const out = path.join(tmp, 'export.png');
await dl.saveAs(out);
console.log('downloaded', out);
await page.click('#dlgExport [data-close]');

// ---- 2) 位置が分からない画像を手動で動かしてスナップ ----
await page.evaluate(() => { window.largephoto.mosaic.clear(); });
const far = [await saveShot('f0.png', 100, 100), await saveShot('f1.png', 2200, 2000)];
await page.setInputFiles('#fileImages', far);
await page.waitForSelector('#dlgCrop[open]');
await page.click('#dlgCrop [data-ok]');
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open && window.largephoto.mosaic.tiles.length === 2, null, { timeout: 60000 });
const un = await page.evaluate(() => window.largephoto.mosaic.tiles.filter((t) => !t.placed).length);
check(un === 1, '重ならない画像は未配置になる');
const res = await page.evaluate(async () => {
  const { stitcher, mosaic } = window.largephoto;
  return { ok1: await stitcher.snap(mosaic.tiles[1]) };
});
check(res.ok1 === false, '重なりがない場所ではスナップしない');
// 正しく置かれたタイルをずらしてからスナップすると元に戻る
const mid = await saveShot('f2.png', 350, 500);
await page.setInputFiles('#fileImages', [mid]);
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open && window.largephoto.mosaic.tiles.length === 3, null, { timeout: 60000 });
const snap = await page.evaluate(async () => {
  const { mosaic, stitcher } = window.largephoto;
  const [a, , c] = mosaic.tiles;
  const before = [c.x - a.x, c.y - a.y, c.placed];
  c.x += 57; c.y -= 41;
  const ok = await stitcher.snap(c);
  return { ok, before, after: [c.x - a.x, c.y - a.y] };
});
console.log(snap);
check(snap.before[0] === 250 && snap.before[1] === 400 && snap.before[2], '3枚目は自動で正しい位置');
check(snap.ok && snap.after[0] === 250 && snap.after[1] === 400, 'ずらしたタイルがスナップで正確に戻る');

// ---- 3) 動画 ----
await page.evaluate(() => { window.largephoto.mosaic.clear(); });
const frames = [];
let fx = 300, fy = 300;
const path2 = [];
for (let k = 0; k < 40; k++) { fx += 25; path2.push([fx, fy]); }
for (let k = 0; k < 40; k++) { fy += 30; path2.push([fx, fy]); }
for (let k = 0; k < 40; k++) { fx -= 25; path2.push([fx, fy]); }
for (let k = 0; k < path2.length; k++) frames.push(await saveShot(`v${String(k).padStart(4, '0')}.png`, path2[k][0], path2[k][1]));
const vid = path.join(tmp, 'rec.webm');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '10', '-i', path.join(tmp, 'v%04d.png'), '-c:v', 'libvpx-vp9', '-b:v', '4M', '-pix_fmt', 'yuv420p', vid]);
await page.evaluate(() => { window.largephoto.settings.videoStep = 0.1; });
await page.setInputFiles('#fileVideo', vid);
await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
await page.click('#dlgCrop [data-ok]');
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 120000, polling: 500 });
const vres = await page.evaluate(() => {
  const { mosaic } = window.largephoto;
  return { n: mosaic.tiles.length, bb: mosaic.bbox(), cov: mosaic.coverage(), tiles: mosaic.tiles.map((t) => [t.x, t.y]) };
});
console.log('video', vres.n, vres.bb, vres.cov.toFixed(3));
const expW = Math.max(...path2.map((p) => p[0])) - Math.min(...path2.map((p) => p[0])) + 390;
const cropH = Math.round(844 * (1 - 0.13 - 0.14));
const expH = Math.max(...path2.map((p) => p[1])) - Math.min(...path2.map((p) => p[1])) + cropH;
check(Math.abs(vres.bb.w - expW) <= 6 && Math.abs(vres.bb.h - expH) <= 6, `動画から全範囲を取り込み (${vres.bb.w}x${vres.bb.h} vs ${expW}x${expH})`);
const vdiff = await page.evaluate(async ([x0, y0]) => {
  const { mosaic } = window.largephoto;
  const c = await mosaic.exportCanvas({ scale: 1 });
  const bb = mosaic.bbox();
  const t1 = mosaic.tiles.find((t) => t.id === 1);
  // 1枚目 (= 世界座標 x0,y0+110) を基準に元画像を切り出して比較（取り込まれた範囲のみ）
  const wx = x0 + (bb.x - t1.x), wy = y0 + 110 + (bb.y - t1.y);
  const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const w = document.createElement('canvas'); w.width = c.width; w.height = c.height;
  w.getContext('2d').drawImage(window.__world, wx, wy, c.width, c.height, 0, 0, c.width, c.height);
  const b = w.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let s = 0, n = 0;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
    if (!mosaic.covers(bb.x + x, bb.y + y)) continue;
    const i = (y * c.width + x) * 4;
    s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++;
  }
  return s / n / 3;
}, path2[0]);
check(vdiff < 6, `動画の貼り合わせが元の地図と一致（平均差 ${vdiff.toFixed(2)}、動画圧縮ぶんの誤差あり）`);
await page.click('#btnFit');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(tmp, 'ui-video.png') });

await browser.close();
server.close();
console.log(fail ? `${fail} failed` : 'all passed', ' 出力:', tmp);
process.exit(fail ? 1 : 0);
