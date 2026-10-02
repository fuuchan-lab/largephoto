import { Mosaic } from './mosaic.js';
import { View, drawOverview } from './view.js';
import { Stitcher, Tracker } from './stitcher.js';
import { editCrop, PRESETS } from './cropdialog.js';
import { grabFrame, decodeBitmap, isIOS, isMobile, nextFrame } from './imageutil.js';

const $ = (s) => document.querySelector(s);

// ---------- 設定 ----------
const DEFAULTS = {
  threshold: 0.55,
  videoStep: 0.15,
  addUncovered: 0.2,
  thumbSize: 640,
  crops: { image: PRESETS.phone, video: PRESETS.phone, live: PRESETS.desktop },
};
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('largephoto.settings') || '{}');
    return { ...DEFAULTS, ...s, crops: { ...DEFAULTS.crops, ...(s.crops || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem('largephoto.settings', JSON.stringify(settings)); } catch { /* 無視 */ }
}

// ---------- 本体 ----------
const mosaic = new Mosaic();
const view = new View($('#view'), mosaic);
const stitcher = new Stitcher(mosaic, settings);
const mini = $('#mini');
let busy = false;
let imageCropConfirmed = false;

const canLive = !!navigator.mediaDevices?.getDisplayMedia && !isMobile;
if (!canLive) document.querySelectorAll('.only-desktop').forEach((e) => e.classList.add('unsupported'));

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function updateStats() {
  const n = mosaic.tiles.length;
  $('#empty').hidden = n > 0;
  mini.hidden = n === 0;
  if (!n) { $('#stats').textContent = '画像を追加してください'; return; }
  const bb = mosaic.bbox();
  const un = mosaic.tiles.filter((t) => !t.placed).length;
  const cov = Math.round(mosaic.coverage() * 100);
  let s = `${n}枚`;
  if (bb) s += ` ・ ${Math.round(bb.w).toLocaleString()}×${Math.round(bb.h).toLocaleString()}px ・ 埋まり ${cov}%`;
  if (un) s += ` ・ 未配置 ${un}`;
  $('#stats').textContent = s;
}

let liveRect = null, liveLost = false;
function drawMini() {
  if (mini.hidden) return;
  drawOverview(mini, mosaic, { viewRect: view.visibleRect(), liveRect, lost: liveLost });
}
view.onViewChange = drawMini;

mosaic.onChange((kind) => {
  if (kind !== 'redraw') updateStats();
  view.draw();
});
mini.addEventListener('click', () => view.fit());
window.addEventListener('beforeunload', (e) => { if (mosaic.tiles.length) { e.preventDefault(); e.returnValue = ''; } });

// ---------- 進捗ダイアログ ----------
const prog = {
  cancelled: false,
  open(title) {
    this.cancelled = false;
    $('#progTitle').textContent = title;
    $('#progBar').value = 0;
    $('#progText').textContent = '';
    $('#dlgProgress').showModal();
  },
  set(v, text) {
    $('#progBar').value = v;
    if (text != null) $('#progText').textContent = text;
    drawOverview($('#progMini'), mosaic, { liveRect, lost: liveLost });
  },
  close() { $('#dlgProgress').close(); },
};
$('#progCancel').onclick = () => { prog.cancelled = true; };
$('#dlgProgress').addEventListener('cancel', (e) => { e.preventDefault(); prog.cancelled = true; });

async function askCrop(kind, source, sw, sh) {
  const c = await editCrop($('#dlgCrop'), source, sw, sh, settings.crops[kind]);
  if (!c) return null;
  settings.crops[kind] = c;
  saveSettings();
  return c;
}

// ---------- スクリーンショット ----------
async function addImages(files) {
  if (!files.length || busy) return;
  busy = true;
  files = [...files].sort((a, b) => (a.lastModified - b.lastModified) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const counts = { placed: 0, unplaced: 0, first: 0 };
  try {
    let crop = settings.crops.image;
    const wasEmpty = !mosaic.tiles.length;
    for (let i = 0; i < files.length; i++) {
      const bmp = await decodeBitmap(files[i]);
      const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
      if (i === 0 && (!imageCropConfirmed || wasEmpty)) {
        crop = await askCrop('image', bmp, w, h);
        if (!crop) { bmp.close?.(); return; }
        imageCropConfirmed = true;
        prog.open('画像をつなげています…');
      } else if (i === 0) {
        prog.open('画像をつなげています…');
      }
      prog.set(i / files.length, `${i + 1} / ${files.length} 枚目`);
      await nextFrame();
      const frame = grabFrame(bmp, w, h, crop);
      bmp.close?.();
      const r = await stitcher.addStill(frame, files[i]);
      counts[r]++;
      if (i === 0 && wasEmpty) view.fit();
      prog.set((i + 1) / files.length);
      if (prog.cancelled) break;
    }
  } catch (err) {
    console.error(err);
    toast('エラー: ' + err.message, 5000);
  } finally {
    prog.close();
    busy = false;
  }
  view.fit();
  const ok = counts.placed + counts.first;
  if (counts.unplaced) {
    toast(`${ok}枚をつなげました。${counts.unplaced}枚は位置が分からなかったので右側に置きました（✥調整でドラッグ）`, 6000);
  } else {
    toast(`${ok}枚をつなげました`);
  }
}

// ---------- 動画 ----------
function waitEvent(el, ev, ms = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { el.removeEventListener(ev, f); rej(new Error(ev + ' timeout')); }, ms);
    const f = () => { clearTimeout(t); res(); };
    el.addEventListener(ev, f, { once: true });
  });
}

async function seek(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-3) return;
  const p = waitEvent(video, 'seeked');
  video.currentTime = t;
  await p;
}

async function addVideo(file) {
  if (!file || busy) return;
  busy = true;
  const video = $('#video');
  const url = URL.createObjectURL(file);
  try {
    video.src = url;
    video.load();
    await waitEvent(video, 'loadeddata', 15000);
    try { await video.play(); video.pause(); } catch { /* 自動再生不可でもシークはできる */ }
    const dur = video.duration;
    if (!isFinite(dur) || !video.videoWidth) throw new Error('この動画は読み込めませんでした');
    await seek(video, Math.min(0.2, dur / 2));
    const crop = await askCrop('video', video, video.videoWidth, video.videoHeight);
    if (!crop) return;
    const tracker = new Tracker(stitcher);
    const wasEmpty = !mosaic.tiles.length;
    prog.open('動画からつなげています…');
    let lostFrames = 0, added = 0;
    const step = settings.videoStep;
    const times = [];
    for (let t = 0; t < dur - step / 2; t += step) times.push(t);
    times.push(Math.max(0, dur - 0.05));
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (prog.cancelled) break;
      await seek(video, t);
      const frame = grabFrame(video, video.videoWidth, video.videoHeight, crop);
      const r = await tracker.process(frame, { final: i === times.length - 1 });
      if (r.state === 'lost') lostFrames++;
      if (r.state === 'added') { added++; if (added === 1 && wasEmpty) view.fit(); }
      liveRect = r.rect; liveLost = r.state === 'lost';
      prog.set(t / dur, `${t.toFixed(1)} / ${dur.toFixed(1)} 秒 ・ 取り込み ${added}枚${liveLost ? ' ・ 位置を探しています…' : ''}`);
      await nextFrame();
    }
    liveRect = null;
    view.fit();
    toast(`動画から${added}枚を取り込みました` + (lostFrames > 3 ? `（${lostFrames}コマは位置が分からずスキップ）` : ''), 5000);
  } catch (err) {
    console.error(err);
    toast('エラー: ' + err.message, 5000);
  } finally {
    prog.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    liveRect = null;
    busy = false;
  }
}

// ---------- ライブ（画面共有） ----------
const live = { stream: null, running: false, paused: false, tracker: null, crop: null, pip: null };

async function startLive() {
  if (busy) return;
  if (!canLive) { toast('この端末ではライブ取り込みが使えません。画面収録→［動画］をお使いください', 5000); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch {
    return;
  }
  const video = $('#video');
  video.srcObject = stream;
  try { await video.play(); } catch { /* */ }
  for (let i = 0; i < 50 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
  const crop = await askCrop('live', video, video.videoWidth, video.videoHeight);
  if (!crop) { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; return; }
  busy = true;
  Object.assign(live, { stream, running: true, paused: false, tracker: new Tracker(stitcher), crop });
  stream.getVideoTracks()[0].addEventListener('ended', stopLive);
  $('#livebar').hidden = false;
  $('#btnPip').hidden = !('documentPictureInPicture' in window);
  $('#btnLivePause').textContent = '一時停止';
  liveLoop();
}

async function liveLoop() {
  const video = $('#video');
  let first = !mosaic.tiles.length;
  while (live.running) {
    const t0 = performance.now();
    if (!live.paused && video.videoWidth) {
      try {
        const frame = grabFrame(video, video.videoWidth, video.videoHeight, live.crop);
        live.busyFrame = live.tracker.process(frame);
        const r = await live.busyFrame;
        if (!live.running) break;
        liveRect = r.rect; liveLost = r.state === 'lost';
        view.liveRect = liveRect; view.lost = liveLost;
        if (first && r.state === 'added') { view.fit(); first = false; }
        if (liveRect) view.follow(liveRect);
        view.draw();
        setLiveState(liveLost ? 'lost' : 'ok', liveLost ? '見失いました。取り込み済みの場所へ戻してください' : `取り込み中（${mosaic.tiles.length}枚）`);
        drawPip();
      } catch (err) {
        console.error(err);
      }
    }
    const dt = performance.now() - t0;
    await new Promise((r) => setTimeout(r, Math.max(30, 120 - dt)));
  }
}

function setLiveState(kind, text) {
  const s = $('#liveState');
  s.className = 'live-state ' + (kind === 'ok' ? '' : kind);
  $('#liveText').textContent = text;
  if (live.pip) {
    const d = live.pip.document;
    d.getElementById('t').textContent = text;
    d.getElementById('t').style.color = kind === 'lost' ? '#ffb020' : '#e9edf2';
  }
}

async function stopLive() {
  if (!live.running) return;
  live.running = false;
  // 最後に映っていた範囲も取り込む
  const video = $('#video');
  if (!live.paused && video.videoWidth && live.stream?.active) {
    try {
      await live.busyFrame;
      await live.tracker.process(grabFrame(video, video.videoWidth, video.videoHeight, live.crop), { final: true });
    } catch { /* */ }
  }
  live.stream?.getTracks().forEach((t) => t.stop());
  $('#video').srcObject = null;
  live.pip?.close();
  live.pip = null;
  $('#livebar').hidden = true;
  liveRect = null; view.liveRect = null;
  busy = false;
  view.fit();
  toast(`ライブ取り込みを終了しました（${mosaic.tiles.length}枚）`);
}

async function openPip() {
  if (!('documentPictureInPicture' in window) || live.pip) return;
  const w = await window.documentPictureInPicture.requestWindow({ width: 300, height: 380 });
  w.document.body.style.cssText = 'margin:0;background:#111418;color:#e9edf2;font:13px system-ui,sans-serif;display:flex;flex-direction:column;height:100vh';
  w.document.body.innerHTML = '<div id="t" style="padding:6px 8px">取り込み中</div><canvas id="c" style="flex:1;width:100%;min-height:0"></canvas>';
  live.pip = w;
  w.addEventListener('pagehide', () => { live.pip = null; });
  drawPip();
}

function drawPip() {
  if (!live.pip) return;
  const c = live.pip.document.getElementById('c');
  drawOverview(c, mosaic, { liveRect, lost: liveLost });
}

$('#btnLiveStop').onclick = stopLive;
$('#btnLivePause').onclick = () => {
  live.paused = !live.paused;
  $('#btnLivePause').textContent = live.paused ? '再開' : '一時停止';
  if (live.paused) {
    setLiveState('paused', '一時停止中');
  } else {
    // 再開時は位置を探し直す
    live.tracker.lost = true;
  }
};
$('#btnPip').onclick = openPip;

// ---------- 調整モード ----------
function setAdjust(on) {
  view.mode = on ? 'adjust' : 'pan';
  if (!on) view.selected = null;
  $('#adjustbar').hidden = !on;
  $('#btnAdjust').classList.toggle('on', on);
  if (on && !view.selected) view.selected = mosaic.tiles.find((t) => !t.placed) || null;
  view.draw();
}
$('#btnAdjust').onclick = () => setAdjust(view.mode !== 'adjust');
$('#btnAdjustDone').onclick = () => setAdjust(false);
view.onTap = (w) => {
  if (view.mode !== 'adjust') return;
  view.selected = mosaic.hitTest(w.x, w.y);
  view.draw();
};
view.onTileMoved = async (tile) => {
  if (busy) return;
  busy = true;
  try {
    const ok = await stitcher.snap(tile);
    if (ok) toast('ピタッと合わせました');
    else { tile.placed = true; mosaic.changed(); toast('合う場所が見つからないので、その位置に置きました'); }
  } finally { busy = false; }
};
$('#btnSnap').onclick = async () => {
  const t = view.selected;
  if (!t || busy) return toast('タイルを選んでください');
  busy = true;
  try { toast((await stitcher.snap(t)) ? 'ピタッと合わせました' : '近くに合う場所が見つかりませんでした'); }
  finally { busy = false; }
};
$('#btnAuto').onclick = async () => {
  const t = view.selected;
  if (!t || busy) return toast('タイルを選んでください');
  busy = true;
  toast('探しています…', 10000);
  try { toast((await stitcher.autoPlace(t)) ? '合う場所に移動しました' : '合う場所が見つかりませんでした'); }
  finally { busy = false; }
};
$('#btnFront').onclick = () => { if (view.selected) mosaic.bringToFront(view.selected); };
$('#btnDelete').onclick = () => {
  if (!view.selected) return toast('タイルを選んでください');
  mosaic.remove(view.selected);
  view.selected = null;
};

// ---------- その他のボタン ----------
document.querySelectorAll('[data-action]').forEach((b) => {
  b.addEventListener('click', () => {
    const a = b.dataset.action;
    if (busy) return toast('処理中です');
    if (a === 'images') $('#fileImages').click();
    if (a === 'video') $('#fileVideo').click();
    if (a === 'live') startLive();
  });
});
$('#fileImages').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; addImages(f); };
$('#fileVideo').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; addVideo(f); };
$('#btnFit').onclick = () => view.fit();
$('#btnUndo').onclick = () => {
  if (busy || !mosaic.tiles.length) return;
  const last = mosaic.tiles.reduce((a, b) => (b.id > a.id ? b : a));
  if (view.selected === last) view.selected = null;
  mosaic.remove(last);
  toast('最後の1枚を取り消しました');
};
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();
document.querySelectorAll('dialog [data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

// 設定
function bindRange(id, out, key, fmt) {
  const el = $(id), o = $(out);
  el.value = settings[key];
  o.textContent = fmt(settings[key]);
  el.oninput = () => { settings[key] = parseFloat(el.value); o.textContent = fmt(settings[key]); saveSettings(); };
}
bindRange('#setThr', '#outThr', 'threshold', (v) => v.toFixed(2));
bindRange('#setStep', '#outStep', 'videoStep', (v) => v.toFixed(2) + ' 秒');
bindRange('#setAdd', '#outAdd', 'addUncovered', (v) => Math.round(v * 100) + '%');
$('#btnSettings').onclick = () => $('#dlgSettings').showModal();
$('#btnClear').onclick = () => {
  if (!confirm('すべての画像を消去しますか？')) return;
  mosaic.clear();
  view.selected = null;
  view.fit();
  $('#dlgSettings').close();
};
$('#btnCropEdit').onclick = async () => {
  $('#dlgSettings').close();
  const t = mosaic.tiles[0];
  let src = null, w = 0, h = 0;
  if (t) {
    src = await decodeBitmap(t.src);
    w = src.naturalWidth || src.width; h = src.naturalHeight || src.height;
  } else {
    src = document.createElement('canvas');
    w = src.width = 390; h = src.height = 844;
    const ctx = src.getContext('2d');
    ctx.fillStyle = '#556'; ctx.fillRect(0, 0, w, h);
  }
  await askCrop('image', src, w, h);
  imageCropConfirmed = true;
  src.close?.();
  toast('次に追加する画像から適用されます');
};

// ---------- 書き出し ----------
function exportLimits() {
  const maxSide = isIOS ? 16384 : (isMobile ? 16384 : 32767);
  const maxArea = isIOS ? 16777216 : (isMobile ? 100e6 : 250e6);
  return { maxSide, maxArea };
}
let lastUrl = null, lastFile = null;
$('#btnExport').onclick = () => {
  const bb = mosaic.bbox();
  if (!bb) return toast('まだ画像がありません');
  const { maxSide, maxArea } = exportLimits();
  const maxScale = Math.min(1, maxSide / bb.w, maxSide / bb.h, Math.sqrt(maxArea / (bb.w * bb.h)));
  const sel = $('#expScale');
  sel.innerHTML = '';
  const opts = [1, 0.75, 0.5, 0.35, 0.25].filter((s) => s <= maxScale + 1e-9);
  if (!opts.length || opts[0] < maxScale - 0.01) opts.unshift(Math.floor(maxScale * 100) / 100);
  for (const s of opts) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = `${Math.round(s * 100)}%（${Math.round(bb.w * s).toLocaleString()}×${Math.round(bb.h * s).toLocaleString()}px）`;
    sel.appendChild(o);
  }
  const un = mosaic.tiles.filter((t) => !t.placed).length;
  const cov = Math.round(mosaic.coverage() * 100);
  $('#expInfo').textContent = `全体 ${Math.round(bb.w).toLocaleString()}×${Math.round(bb.h).toLocaleString()}px ・ ${mosaic.placed().length}枚 ・ 埋まり ${cov}%`;
  $('#expWarn').textContent = [
    maxScale < 1 ? `この端末で作れる最大サイズに合わせて縮小します（最大 ${Math.round(maxScale * 100)}%）。` : '',
    un ? `未配置の${un}枚は含まれません。` : '',
  ].join(' ');
  $('#expResult').hidden = true;
  $('#expGo').disabled = false;
  $('#dlgExport').showModal();
};
$('#expGo').onclick = async () => {
  if (busy) return;
  busy = true;
  $('#expGo').disabled = true;
  const scale = parseFloat($('#expScale').value);
  const type = $('#expType').value;
  let bg = $('#expBg').value;
  if (bg === 'transparent' && type !== 'image/png') bg = '#ffffff';
  $('#expDone').textContent = '作成中…';
  $('#expResult').hidden = false;
  $('#expDownload').hidden = true;
  $('#expShare').hidden = true;
  try {
    const blob = await mosaic.exportBlob({
      scale, background: bg, type, quality: 0.92,
      onProgress: (p) => { $('#expDone').textContent = `作成中… ${Math.round(p * 100)}%`; },
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const d = new Date();
    const name = `largephoto-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.${ext}`;
    lastFile = new File([blob], name, { type });
    const a = $('#expDownload');
    a.href = lastUrl;
    a.download = name;
    a.hidden = false;
    $('#expShare').hidden = !(navigator.canShare && navigator.canShare({ files: [lastFile] }));
    $('#expDone').textContent = `できました：${name}（${(blob.size / 1048576).toFixed(1)} MB）`;
  } catch (err) {
    console.error(err);
    $('#expDone').textContent = 'エラー: ' + err.message + '　小さいサイズを選んで再度お試しください。';
  } finally {
    $('#expGo').disabled = false;
    busy = false;
  }
};
$('#expShare').onclick = async () => {
  if (!lastFile) return;
  try { await navigator.share({ files: [lastFile] }); } catch { /* キャンセル */ }
};

// ---------- 起動 ----------
updateStats();
view.resize();
view.fit();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// テスト・デバッグ用
window.largephoto = { mosaic, view, stitcher, settings };
