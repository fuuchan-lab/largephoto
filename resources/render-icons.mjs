// アイコン一式を resources/icon-source.jpg（正方形のイラスト）から生成: npm run icons
// - 元画像の角丸・白い余白を除き、青グラデーションを上下に延ばして正方形にそろえる
// - Web/PWA、Android（mipmap・アダプティブ・スプラッシュ）、iOS、ストア用画像を書き出す
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
const srcB64 = (await readFile(path.join(here, 'icon-source.jpg'))).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');

// ページ内に正方形アート（1254px）を作って window.__art に保持する
await page.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
  const S = 1254;
  // 元画像の青い角丸四角（x 11..1243, y 59..1194）の内側、角丸にかからない範囲を使う
  const sx = 60, sw = 1135, sy = 90, sh = 1070;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, '#1f9bf5'); grad.addColorStop(1, '#0452ff');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  // 上下の継ぎ目をぼかして重ねる
  const w = Math.round(S * sw / sh * (sh / sw)); // = S
  const dh = Math.round(S * sh / sw), dy = Math.round((S - dh) / 2);
  const t = document.createElement('canvas'); t.width = S; t.height = dh;
  const tg = t.getContext('2d');
  tg.drawImage(img, sx, sy, sw, sh, 0, 0, S, dh);
  tg.globalCompositeOperation = 'destination-in';
  const m = tg.createLinearGradient(0, 0, 0, dh);
  const f = Math.min(0.5, 36 / dh);
  m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(f, 'rgba(0,0,0,1)');
  m.addColorStop(1 - f, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  tg.fillStyle = m; tg.fillRect(0, 0, S, dh);
  g.drawImage(t, 0, dy);
  window.__art = c;
  window.__bg = (() => { const b = document.createElement('canvas'); b.width = b.height = S; const q = b.getContext('2d'); q.fillStyle = grad; q.fillRect(0, 0, S, S); return b; })();
}, srcB64);

// kind: 'full'（正方形・全面）| 'round'（角丸）| 'circle' | 'fg'（アダプティブ前景）| 'bg'（アダプティブ背景）
async function render(kind, size, out, w = size, h = size) {
  const url = await page.evaluate(([kind, w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    const S = Math.min(w, h);
    const ox = (w - S) / 2, oy = (h - S) / 2;
    if (kind === 'bg') { g.drawImage(window.__bg, 0, 0, w, h); return c.toDataURL('image/png'); }
    if (kind === 'fg') {
      // 安全域（中央 66%）に収める。縁はなじませるため少しぼかして透明に
      const k = 0.72, d = S * k;
      const t = document.createElement('canvas'); t.width = t.height = 1254;
      const tg = t.getContext('2d');
      tg.drawImage(window.__art, 0, 0);
      tg.globalCompositeOperation = 'destination-in';
      const rg = tg.createRadialGradient(627, 627, 400, 627, 627, 700);
      rg.addColorStop(0, 'rgba(0,0,0,1)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      // 四角くフェード
      const mk = document.createElement('canvas'); mk.width = mk.height = 1254;
      const mg = mk.getContext('2d');
      const fx = mg.createLinearGradient(0, 0, 1254, 0);
      fx.addColorStop(0, '#0000'); fx.addColorStop(0.06, '#000'); fx.addColorStop(0.94, '#000'); fx.addColorStop(1, '#0000');
      mg.fillStyle = fx; mg.fillRect(0, 0, 1254, 1254);
      mg.globalCompositeOperation = 'destination-in';
      const fy = mg.createLinearGradient(0, 0, 0, 1254);
      fy.addColorStop(0, '#0000'); fy.addColorStop(0.06, '#000'); fy.addColorStop(0.94, '#000'); fy.addColorStop(1, '#0000');
      mg.fillStyle = fy; mg.fillRect(0, 0, 1254, 1254);
      tg.globalCompositeOperation = 'destination-in'; tg.drawImage(mk, 0, 0);
      g.drawImage(t, ox + (S - d) / 2, oy + (S - d) / 2, d, d);
      return c.toDataURL('image/png');
    }
    g.save();
    g.beginPath();
    if (kind === 'circle') {
      // 円で切れないよう、背景の上に少し縮めて置く
      g.arc(w / 2, h / 2, S / 2, 0, Math.PI * 2); g.clip();
      g.drawImage(window.__bg, ox, oy, S, S);
      const d = S * 0.8; g.drawImage(window.__art, ox + (S - d) / 2, oy + (S - d) / 2, d, d);
      g.restore();
      return c.toDataURL('image/png');
    }
    else if (kind === 'round') g.roundRect(ox, oy, S, S, S * 0.224);
    else g.rect(ox, oy, S, S);
    g.clip();
    g.drawImage(window.__art, ox, oy, S, S);
    g.restore();
    return c.toDataURL('image/png');
  }, [kind, w, h]);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(url.split(',')[1], 'base64'));
}

// Web / PWA
for (const s of [32, 192, 512]) await render('full', s, path.join(root, `www/icons/icon-${s}.png`));
await render('full', 180, path.join(root, 'www/icons/icon-180.png'));
await render('full', 512, path.join(root, 'www/icons/maskable-512.png'));

// ストア用・元データ
await render('full', 512, path.join(here, 'store/play-icon-512.png'));
await render('full', 1024, path.join(here, 'store/app-store-icon-1024.png'));
await render('full', 1024, path.join(here, 'icon.png'));
await render('fg', 1024, path.join(here, 'icon-foreground.png'));
await render('bg', 1024, path.join(here, 'icon-background.png'));

// iOS アプリアイコン（1024、角丸なし・不透明）
const appicon = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
try { await readFile(appicon); await render('full', 1024, appicon); console.log('ios icon written'); } catch { /* ios/ なし */ }

// Play ストアのフィーチャーグラフィック 1024x500
const iconUrl = (await readFile(path.join(root, 'www/icons/icon-512.png'))).toString('base64');
await page.setViewportSize({ width: 1024, height: 500 });
await page.setContent(`<html><body style="margin:0">
<div style="width:1024px;height:500px;background:linear-gradient(135deg,#1f9bf5,#0440c8);display:flex;align-items:center;gap:56px;padding:0 90px;box-sizing:border-box;font-family:'Noto Sans CJK JP','Noto Sans JP',sans-serif;color:#fff">
  <img src="data:image/png;base64,${iconUrl}" width="300" height="300" style="flex:none;filter:drop-shadow(0 10px 24px rgba(0,0,0,.35))">
  <div><div style="font-size:76px;font-weight:800;letter-spacing:1px">LargePic</div>
  <div style="font-size:46px;font-weight:700;margin-top:2px">画像つなぎ</div>
  <div style="font-size:27px;margin-top:22px;opacity:.92;line-height:1.5">スクロールした地図を<br>1枚の大きな画像に</div></div>
</div></body></html>`);
await page.screenshot({ path: path.join(here, 'store/feature-graphic-1024x500.png') });

// Android（android/ がある場合）
const res = path.join(root, 'android/app/src/main/res');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
try {
  await readFile(path.join(root, 'android/app/build.gradle'));
  for (const [d, k] of Object.entries(dens)) {
    await render('full', 48 * k, path.join(res, `mipmap-${d}/ic_launcher.png`));
    await render('full', 48 * k, path.join(res, `mipmap-${d}/ic_launcher_round.png`));
    await render('fg', 108 * k, path.join(res, `mipmap-${d}/ic_launcher_foreground.png`));
    await render('bg', 108 * k, path.join(res, `mipmap-${d}/ic_launcher_background.png`));
  }
  // スプラッシュ（既存ファイルと同じサイズで置き換え。背景は青、中央にアイコン）
  for (const dir of await readdir(res)) {
    if (!dir.startsWith('drawable')) continue;
    const f = path.join(res, dir, 'splash.png');
    let buf; try { buf = await readFile(f); } catch { continue; }
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const s = Math.round(Math.min(w, h) * 0.34);
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;background:#14171b;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">
      <img src="data:image/png;base64,${iconUrl}" width="${s}" height="${s}"></body></html>`);
    await page.screenshot({ path: f, clip: { x: 0, y: 0, width: w, height: h } });
  }
  console.log('android icons / splash written');
} catch { console.log('android/ が無いので省略'); }

// iOS スプラッシュ
const splashDir = path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset');
try {
  for (const f of await readdir(splashDir)) {
    if (!f.endsWith('.png')) continue;
    const s = 2732;
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(`<html><body style="margin:0;background:#14171b;width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center">
      <img src="data:image/png;base64,${iconUrl}" width="900" height="900"></body></html>`);
    await page.screenshot({ path: path.join(splashDir, f), clip: { x: 0, y: 0, width: s, height: s } });
  }
} catch { /* ios/ なし */ }

await browser.close();
console.log('done');
