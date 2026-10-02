import { Mosaic } from './mosaic.js';
import { View, drawOverview } from './view.js';
import { Stitcher, Tracker } from './stitcher.js';
import { editCrop, PRESETS } from './cropdialog.js';
import { grabFrame, decodeBitmap, isIOS, isMobile, nextFrame } from './imageutil.js';
import { ProjectStore } from './store.js';
import { computeTrim, TrimEditor } from './trim.js';
import { isNative, nativePlatform, webPlatform, ScreenRecorder, nativeFileToBlob } from './native.js';

const $ = (s) => document.querySelector(s);
const APP = 'largepic';

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
    const s = JSON.parse(localStorage.getItem(APP + '.settings') || '{}');
    return { ...DEFAULTS, ...s, crops: { ...DEFAULTS.crops, ...(s.crops || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(APP + '.settings', JSON.stringify(settings)); } catch { /* 無視 */ }
}

// ---------- 本体 ----------
const mosaic = new Mosaic();
const view = new View($('#view'), mosaic);
const stitcher = new Stitcher(mosaic, settings);
const store = new ProjectStore(mosaic);
const mini = $('#mini');
let busy = false;
let imageCropConfirmed = false;

const canLive = !!navigator.mediaDevices?.getDisplayMedia && !isMobile && !isNative;

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let coverage = 0;
function updateStats() {
  const n = mosaic.tiles.length;
  $('#empty').hidden = n > 0;
  mini.hidden = n === 0;
  coverage = n ? mosaic.coverage() : 0;
  $('#btnFill').hidden = !n || coverage > 0.995 || busy;
  if (!n) { $('#stats').textContent = '撮影して始めましょう'; return; }
  const bb = mosaic.bbox();
  const un = mosaic.tiles.filter((t) => !t.placed).length;
  let s = `${n}枚`;
  if (bb) s += ` ・ ${Math.round(bb.w).toLocaleString()}×${Math.round(bb.h).toLocaleString()}px ・ 埋まり ${Math.round(coverage * 100)}%`;
  if (un) s += ` ・ 未配置 ${un}`;
  $('#stats').textContent = s;
}
function setBusy(b) {
  busy = b;
  $('#btnFill').hidden = b || !mosaic.tiles.length || coverage > 0.995;
}

let liveRect = null, liveLost = false;
function drawMini() {
  if (mini.hidden) return;
  drawOverview(mini, mosaic, { viewRect: view.visibleRect(), liveRect, lost: liveLost });
}
view.onViewChange = drawMini;

mosaic.onChange((kind) => {
  if (kind !== 'redraw') { updateStats(); store.schedule(); }
  view.draw();
});
mini.addEventListener('click', () => view.fit());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.flush().catch(() => {});
  else checkNativePending();
});

// ---------- 進捗ダイアログ ----------
const prog = {
  cancelled: false,
  open(title) {
    this.cancelled = false;
    $('#progTitle').textContent = title;
    $('#progBar').value = 0;
    $('#progText').textContent = '';
    if (!$('#dlgProgress').open) $('#dlgProgress').showModal();
  },
  set(v, text) {
    $('#progBar').value = v;
    if (text != null) $('#progText').textContent = text;
    drawOverview($('#progMini'), mosaic, { liveRect, lost: liveLost });
  },
  close() { if ($('#dlgProgress').open) $('#dlgProgress').close(); },
};
$('#progCancel').onclick = () => { prog.cancelled = true; };
$('#dlgProgress').addEventListener('cancel', (e) => { e.preventDefault(); prog.cancelled = true; });

async function askCrop(kind, source, sw, sh, opts) {
  const r = await editCrop($('#dlgCrop'), source, sw, sh, settings.crops[kind], opts);
  if (!r) return null;
  settings.crops[kind] = r.crop;
  saveSettings();
  return r;
}

// ---------- スクリーンショット ----------
async function addImages(files) {
  if (!files.length || busy) return;
  setBusy(true);
  files = [...files].sort((a, b) => (a.lastModified - b.lastModified) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const counts = { placed: 0, unplaced: 0, first: 0 };
  try {
    let crop = settings.crops.image;
    const wasEmpty = !mosaic.tiles.length;
    for (let i = 0; i < files.length; i++) {
      const bmp = await decodeBitmap(files[i]);
      const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
      if (i === 0 && (!imageCropConfirmed || wasEmpty)) {
        const r = await askCrop('image', bmp, w, h);
        if (!r) { bmp.close?.(); return; }
        crop = r.crop;
        imageCropConfirmed = true;
      }
      if (i === 0) prog.open('画像をつなげています…');
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
    setBusy(false);
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

// file: File または Blob（ネイティブの録画ファイル）
async function addVideo(file) {
  if (!file || busy) return;
  setBusy(true);
  const video = $('#video');
  const url = URL.createObjectURL(file);
  const wasEmpty = !mosaic.tiles.length;
  try {
    video.src = url;
    video.load();
    await waitEvent(video, 'loadeddata', 20000);
    try { await video.play(); video.pause(); } catch { /* 自動再生不可でもシークはできる */ }
    const dur = video.duration;
    if (!isFinite(dur) || !video.videoWidth) throw new Error('この動画は読み込めませんでした');
    await seek(video, Math.min(0.2, dur / 2));
    const sel = await askCrop('video', video, video.videoWidth, video.videoHeight, { video });
    if (!sel) return;
    const { crop, start, end } = sel;
    const tracker = new Tracker(stitcher);
    prog.open(wasEmpty ? '動画からつなげています…' : '追加の動画を取り込んでいます…');
    const step = settings.videoStep;
    const times = [];
    for (let t = start; t < end - step / 2; t += step) times.push(t);
    times.push(Math.max(start, end - 0.05));
    let fitted = !wasEmpty;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (prog.cancelled) break;
      await seek(video, t);
      const frame = grabFrame(video, video.videoWidth, video.videoHeight, crop);
      const r = await tracker.process(frame, { final: i === times.length - 1 });
      if (r.state === 'added' && !fitted) { view.fit(); fitted = true; }
      liveRect = r.rect; liveLost = r.state === 'lost';
      const msg = r.state === 'waiting' ? ' ・ スクロールの始まりを探しています…'
        : liveLost ? ' ・ 位置を探しています（取り込み済みの場所が映るまで待機）' : '';
      prog.set((t - start) / Math.max(0.01, end - start),
        `${(t - start).toFixed(1)} / ${(end - start).toFixed(1)} 秒 ・ 取り込み ${tracker.stats.added}枚${msg}`);
      await nextFrame();
    }
    liveRect = null;
    view.fit();
    const { added, lost } = tracker.stats;
    if (!wasEmpty && added === 0) {
      toast('取り込み済みの場所が見つからず、追加できませんでした。撮影の最初に取り込み済みの場所を映してください', 7000);
    } else {
      toast(`動画から${added}枚を取り込みました` + (lost > 3 ? `（${lost}コマは位置が分からずスキップ）` : ''), 5000);
    }
  } catch (err) {
    console.error(err);
    toast('エラー: ' + err.message, 5000);
  } finally {
    prog.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    liveRect = null;
    setBusy(false);
  }
}

// ---------- 撮影モード ----------
const STEPS = {
  'native-android': [
    '下の［録画を開始］→ 確認画面で「開始」',
    'ホームに戻って地図アプリを開き、ルールを守ってスクロール',
    '終わったら通知の［停止］か、このアプリに戻って［停止して取り込む］',
  ],
  'native-ios': [
    '下の［録画を開始］→「ブロードキャストを開始」',
    '地図アプリに切り替えて、ルールを守ってスクロール',
    '画面上部の赤い表示をタップして停止 → このアプリに戻ると取り込みます',
  ],
  ios: [
    'コントロールセンターを開き「画面収録」◉ をタップ（3秒後に開始）',
    '地図アプリでルールを守ってスクロール',
    '画面上部の赤い表示をタップして停止（写真アプリに保存されます）',
    'このアプリに戻って［撮影した動画を選ぶ］',
  ],
  android: [
    'クイック設定（画面上から2回スワイプ）の「スクリーンレコード」で録画開始',
    '地図アプリでルールを守ってスクロール',
    '通知から録画を停止',
    'このアプリに戻って［撮影した動画を選ぶ］',
  ],
  desktop: [
    '［ライブ取り込み］で地図のタブやウィンドウを選ぶと、スクロールした範囲がこの画面にリアルタイムで表示されます',
    'または、画面録画した動画ファイルを［撮影した動画を選ぶ］で読み込み',
  ],
};

function openCapture(fill = false) {
  if (busy) return toast('処理中です');
  const key = isNative ? 'native-' + nativePlatform : webPlatform;
  $('#capTitle').textContent = fill ? '不足部分を追加撮影' : '画面収録で撮影';
  $('#capFill').hidden = !fill;
  $('#capSteps').innerHTML = (STEPS[key] || STEPS.desktop).map((s) => `<li>${s}</li>`).join('');
  $('#capStart').hidden = !(isNative && ScreenRecorder);
  $('#capLive').hidden = !canLive;
  $('#dlgCapture').showModal();
}
$('#btnFill').onclick = () => openCapture(true);
$('#capPick').onclick = () => { $('#dlgCapture').close(); $('#fileVideo').click(); };
$('#capLive').onclick = () => { $('#dlgCapture').close(); startLive(); };
$('#capStart').onclick = startNativeRecording;

// ---- ネイティブ版の画面収録 ----
async function startNativeRecording() {
  $('#dlgCapture').close();
  try {
    await store.flush();
    await ScreenRecorder.start();
    if (nativePlatform === 'android') {
      $('#recbar').hidden = false;
      toast('録画を開始しました。ホームに戻って地図アプリで撮影してください', 5000);
    } else {
      toast('「ブロードキャストを開始」を押してから地図アプリへ。終わったらこのアプリに戻ってください', 7000);
    }
  } catch (err) {
    toast('録画を開始できませんでした: ' + (err.message || err), 5000);
  }
}
$('#btnRecStop').onclick = async () => {
  $('#recbar').hidden = true;
  try {
    const r = await ScreenRecorder.stop();
    if (r?.path) await importNative(r.path);
  } catch (err) {
    toast('録画の停止に失敗しました: ' + (err.message || err), 5000);
  }
};
async function importNative(path) {
  if (busy) return;
  const blob = await nativeFileToBlob(path);
  await ScreenRecorder.clearPending?.();
  await addVideo(blob);
}
let checking = false;
async function checkNativePending() {
  if (!isNative || !ScreenRecorder || checking || busy) return;
  checking = true;
  try {
    const r = await ScreenRecorder.getPending();
    if (r?.path) { $('#recbar').hidden = true; await importNative(r.path); }
    else if (r?.recording && nativePlatform === 'android') $('#recbar').hidden = false;
  } catch (err) {
    console.warn(err);
  } finally {
    checking = false;
  }
}
if (isNative && ScreenRecorder) {
  ScreenRecorder.addListener?.('recordingStopped', () => {
    $('#recbar').hidden = true;
    if (document.visibilityState === 'visible') checkNativePending();
  });
}

// ---------- ライブ（PC の画面共有） ----------
const live = { stream: null, running: false, paused: false, tracker: null, crop: null, pip: null, busyFrame: null };

async function startLive() {
  if (busy) return;
  if (!canLive) { toast('この端末ではライブ取り込みが使えません。画面収録した動画をお使いください', 5000); return; }
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
  const sel = await askCrop('live', video, video.videoWidth, video.videoHeight);
  if (!sel) { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; return; }
  setBusy(true);
  Object.assign(live, { stream, running: true, paused: false, tracker: new Tracker(stitcher), crop: sel.crop });
  stream.getVideoTracks()[0].addEventListener('ended', stopLive);
  $('#livebar').hidden = false;
  $('#btnPip').hidden = !('documentPictureInPicture' in window);
  $('#btnLivePause').textContent = '一時停止';
  liveLoop();
}

async function liveLoop() {
  const video = $('#video');
  let fitted = !!mosaic.tiles.length;
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
        if (!fitted && r.state === 'added') { view.fit(); fitted = true; }
        if (liveRect) view.follow(liveRect);
        view.draw();
        if (r.state === 'waiting') setLiveState('ok', 'スクロールを始めてください');
        else setLiveState(liveLost ? 'lost' : 'ok', liveLost ? '見失いました。取り込み済みの場所へ戻してください' : `取り込み中（${mosaic.tiles.length}枚）`);
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
  $('#liveState').className = 'live-state ' + (kind === 'ok' ? '' : kind);
  $('#liveText').textContent = text;
  if (live.pip) {
    const t = live.pip.document.getElementById('t');
    t.textContent = text;
    t.style.color = kind === 'lost' ? '#ffb020' : '#e9edf2';
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
  video.srcObject = null;
  live.pip?.close();
  live.pip = null;
  $('#livebar').hidden = true;
  liveRect = null; view.liveRect = null;
  setBusy(false);
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
  drawOverview(live.pip.document.getElementById('c'), mosaic, { liveRect, lost: liveLost });
}

$('#btnLiveStop').onclick = stopLive;
$('#btnLivePause').onclick = () => {
  live.paused = !live.paused;
  $('#btnLivePause').textContent = live.paused ? '再開' : '一時停止';
  if (live.paused) setLiveState('paused', '一時停止中');
  else live.tracker.lost = true; // 再開時は位置を探し直す
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
  setBusy(true);
  try {
    const ok = await stitcher.snap(tile);
    if (ok) toast('ピタッと合わせました');
    else { tile.placed = true; mosaic.changed(); toast('合う場所が見つからないので、その位置に置きました'); }
  } finally { setBusy(false); }
};
$('#btnSnap').onclick = async () => {
  const t = view.selected;
  if (!t || busy) return toast('タイルを選んでください');
  setBusy(true);
  try { toast((await stitcher.snap(t)) ? 'ピタッと合わせました' : '近くに合う場所が見つかりませんでした'); }
  finally { setBusy(false); }
};
$('#btnAuto').onclick = async () => {
  const t = view.selected;
  if (!t || busy) return toast('タイルを選んでください');
  setBusy(true);
  toast('探しています…', 10000);
  try { toast((await stitcher.autoPlace(t)) ? '合う場所に移動しました' : '合う場所が見つかりませんでした'); }
  finally { setBusy(false); }
};
$('#btnFront').onclick = () => { if (view.selected) mosaic.bringToFront(view.selected); };
$('#btnDelete').onclick = () => {
  if (!view.selected) return toast('タイルを選んでください');
  mosaic.remove(view.selected);
  view.selected = null;
};

// ---------- その他のボタン ----------
document.querySelectorAll('[data-action]').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    const a = b.dataset.action;
    if (a === 'help') { b.closest('dialog')?.close(); $('#dlgHelp').showModal(); return; }
    if (busy) return toast('処理中です');
    if (a === 'capture') openCapture(mosaic.tiles.length > 0 && coverage < 0.995);
    if (a === 'images') $('#fileImages').click();
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
$('#btnPickVideo').onclick = () => { $('#dlgSettings').close(); $('#fileVideo').click(); };
$('#btnClear').onclick = async () => {
  if (!confirm('すべての画像を消去しますか？')) return;
  mosaic.clear();
  await store.clear();
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
  const r = await askCrop('image', src, w, h);
  if (r) { settings.crops.video = r.crop; saveSettings(); }
  imageCropConfirmed = true;
  src.close?.();
  toast('次に追加する画像・動画から適用されます');
};

// ---------- 書き出し ----------
function exportLimits() {
  const maxSide = isIOS ? 16384 : (isMobile ? 16384 : 32767);
  const maxArea = isIOS ? 16777216 : (isMobile ? 100e6 : 250e6);
  return { maxSide, maxArea };
}
const trim = new TrimEditor($('#trimCanvas'), mosaic, drawOverview);
const exp = { shape: 'rect', fit: 'outer' };
const FIT_HINT = {
  outer: '取り込んだ全体が入る大きさ。すき間は下の色で埋まります。',
  inner: 'すき間が入らない、いちばん大きな形。',
  free: 'プレビューの枠をドラッグして移動、角の丸をドラッグで大きさを変更。',
};

function segSet(id, v) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
function updateTrim(recompute = true) {
  if (recompute && exp.fit !== 'free') {
    trim.rect = computeTrim(mosaic, exp.shape, exp.fit) || computeTrim(mosaic, exp.shape, 'outer');
  }
  if (exp.fit === 'free' && exp.shape === 'circle' && trim.rect && trim.rect.w !== trim.rect.h) {
    const k = Math.min(trim.rect.w, trim.rect.h);
    trim.rect = { x: trim.rect.x + (trim.rect.w - k) / 2, y: trim.rect.y + (trim.rect.h - k) / 2, w: k, h: k };
  }
  trim.shape = exp.shape;
  trim.editable = exp.fit === 'free';
  $('#fitHint').textContent = FIT_HINT[exp.fit];
  trim.draw();
  updateScaleOptions();
}
trim.onChange = () => updateScaleOptions();

function updateScaleOptions() {
  const r = trim.rect;
  if (!r) return;
  const { maxSide, maxArea } = exportLimits();
  const maxScale = Math.min(1, maxSide / r.w, maxSide / r.h, Math.sqrt(maxArea / (r.w * r.h)));
  const sel = $('#expScale');
  const prev = parseFloat(sel.value) || 1;
  sel.innerHTML = '';
  const opts = [1, 0.75, 0.5, 0.35, 0.25].filter((s) => s <= maxScale + 1e-9);
  if (!opts.length || opts[0] < maxScale - 0.01) opts.unshift(Math.floor(maxScale * 100) / 100);
  for (const s of opts) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = `${Math.round(s * 100)}%（${Math.round(r.w * s).toLocaleString()}×${Math.round(r.h * s).toLocaleString()}px）`;
    sel.appendChild(o);
  }
  if (opts.includes(prev)) sel.value = prev;
  const un = mosaic.tiles.filter((t) => !t.placed).length;
  $('#expWarn').textContent = [
    maxScale < 1 ? `この端末で作れる最大サイズに合わせて縮小します（最大 ${Math.round(maxScale * 100)}%）。` : '',
    un ? `未配置の${un}枚は含まれません。` : '',
  ].join(' ');
}

document.querySelectorAll('#segShape button').forEach((b) => {
  b.onclick = () => { exp.shape = b.dataset.v; segSet('segShape', exp.shape); updateTrim(exp.fit !== 'free'); };
});
document.querySelectorAll('#segFit button').forEach((b) => {
  b.onclick = () => { exp.fit = b.dataset.v; segSet('segFit', exp.fit); updateTrim(); };
});

let lastUrl = null, lastFile = null;
$('#btnExport').onclick = () => {
  const bb = mosaic.bbox();
  if (!bb) return toast('まだ画像がありません');
  $('#expInfo').textContent = `全体 ${Math.round(bb.w).toLocaleString()}×${Math.round(bb.h).toLocaleString()}px ・ ${mosaic.placed().length}枚 ・ 埋まり ${Math.round(mosaic.coverage() * 100)}%`;
  $('#expResult').hidden = true;
  $('#expGo').disabled = false;
  $('#dlgExport').showModal();
  updateTrim();
};
$('#expGo').onclick = async () => {
  if (busy || !trim.rect) return;
  setBusy(true);
  $('#expGo').disabled = true;
  const scale = parseFloat($('#expScale').value);
  const type = $('#expType').value;
  let bg = $('#expBg').value;
  if (bg === 'transparent' && type !== 'image/png') bg = '#ffffff';
  const circle = exp.shape === 'circle';
  $('#expDone').textContent = '作成中…';
  $('#expResult').hidden = false;
  $('#expDownload').hidden = true;
  $('#expShare').hidden = true;
  try {
    const blob = await mosaic.exportBlob({
      scale, background: bg, type, quality: 0.92, region: trim.rect, circle,
      outside: circle && type !== 'image/png' ? bg : null,
      onProgress: (p) => { $('#expDone').textContent = `作成中… ${Math.round(p * 100)}%`; },
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `LargePic-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
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
    setBusy(false);
  }
};
$('#expShare').onclick = async () => {
  if (!lastFile) return;
  try { await navigator.share({ files: [lastFile] }); } catch { /* キャンセル */ }
};

// ---------- 起動 ----------
async function boot() {
  updateStats();
  view.resize();
  view.fit();
  if (await store.hasProject()) {
    const dlg = $('#dlgRestore');
    const go = await new Promise((res) => {
      $('#restoreGo').onclick = () => { dlg.close(); res(true); };
      $('#restoreNew').onclick = () => { dlg.close(); res(false); };
      dlg.oncancel = () => res(true);
      dlg.showModal();
    });
    if (go) {
      setBusy(true);
      prog.open('前回の作業を読み込んでいます…');
      try {
        await store.load(stitcher, (p) => prog.set(p));
        view.fit();
      } catch (err) {
        console.error(err);
        toast('前回の作業を読み込めませんでした', 5000);
      } finally {
        prog.close();
        setBusy(false);
      }
    } else {
      await store.clear();
    }
  }
  checkNativePending();
}
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// テスト・デバッグ用
window.largepic = { mosaic, view, stitcher, settings, store, trim, computeTrim };
