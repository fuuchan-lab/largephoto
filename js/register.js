// 画像位置合わせ（平行移動のみ）
// 位相限定相関で粗く候補を探し、正規化相互相関(NCC)で検証・高解像度で詰める。
// DOM に依存しないので Node でもテストできる。

// ---------- FFT ----------
function fft1d(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function fft2d(re, im, nx, ny, inverse) {
  const rr = new Float64Array(Math.max(nx, ny));
  const ii = new Float64Array(Math.max(nx, ny));
  for (let y = 0; y < ny; y++) {
    const o = y * nx;
    for (let x = 0; x < nx; x++) { rr[x] = re[o + x]; ii[x] = im[o + x]; }
    fft1d(rr, ii, nx, inverse);
    for (let x = 0; x < nx; x++) { re[o + x] = rr[x]; im[o + x] = ii[x]; }
  }
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) { rr[y] = re[y * nx + x]; ii[y] = im[y * nx + x]; }
    fft1d(rr, ii, ny, inverse);
    for (let y = 0; y < ny; y++) { re[y * nx + x] = rr[y]; im[y * nx + x] = ii[y]; }
  }
}

const nextPow2 = (v) => { let n = 1; while (n < v) n <<= 1; return n; };

// ---------- 画像ピラミッド ----------
// gray: Uint8Array / Uint8ClampedArray (w*h)
export function downscale(gray, w, h, tw, th) {
  const out = new Float32Array(tw * th);
  const sx = w / tw, sy = h / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * sy));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * sx));
      let s = 0;
      for (let y = y0; y < y1; y++) {
        const o = y * w;
        for (let x = x0; x < x1; x++) s += gray[o + x];
      }
      out[ty * tw + tx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function makeLevel(gray, w, h, scale) {
  if (scale >= 1) return { data: gray, w, h, scale: 1 };
  const lw = Math.max(8, Math.round(w * scale));
  const lh = Math.max(8, Math.round(h * scale));
  return { data: downscale(gray, w, h, lw, lh), w: lw, h: lh, scale: lw / w };
}

// scales: { coarse, mid }  （例: 最大辺 160px / 640px になる倍率）
export function makeFeatures(gray, w, h, scales) {
  return {
    w, h,
    coarse: makeLevel(gray, w, h, scales.coarse),
    mid: makeLevel(gray, w, h, scales.mid),
    full: { data: gray, w, h, scale: 1 },
    _fft: null,
  };
}

export function scalesFor(w, h) {
  const m = Math.max(w, h);
  return { coarse: Math.min(1, 160 / m), mid: Math.min(1, 640 / m) };
}

// 輝度を「エッジ強調+平均0」にしたテーパー付き画像をFFT
function coarseSpectrum(f, nx, ny) {
  const key = nx + 'x' + ny;
  if (f._fft && f._fft.key === key) return f._fft;
  const { data, w, h } = f.coarse;
  let mean = 0;
  for (let i = 0; i < w * h; i++) mean += data[i];
  mean /= w * h;
  const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
  const tx = Math.max(2, Math.round(w * 0.1)), ty = Math.max(2, Math.round(h * 0.1));
  const tap = (i, n, t) => {
    if (i < t) return 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / t);
    if (i >= n - t) return 0.5 - 0.5 * Math.cos(Math.PI * (n - i - 0.5) / t);
    return 1;
  };
  const wx = new Float64Array(w);
  for (let x = 0; x < w; x++) wx[x] = tap(x, w, tx);
  for (let y = 0; y < h; y++) {
    const wy = tap(y, h, ty);
    for (let x = 0; x < w; x++) {
      re[y * nx + x] = (data[y * w + x] - mean) * wy * wx[x];
    }
  }
  fft2d(re, im, nx, ny, false);
  f._fft = { key, re, im };
  return f._fft;
}

// ---------- NCC ----------
// b を a 座標の (dx,dy) に置いたときの重なり部分の正規化相互相関
export function ncc(A, B, dx, dy, stride = 1) {
  const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
  const x1 = Math.min(A.w, dx + B.w), y1 = Math.min(A.h, dy + B.h);
  if (x1 - x0 < 4 || y1 - y0 < 4) return { score: -1, overlap: 0 };
  const a = A.data, b = B.data, aw = A.w, bw = B.w;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y += stride) {
    const ao = y * aw, bo = (y - dy) * bw - dx;
    for (let x = x0; x < x1; x += stride) {
      const va = a[ao + x], vb = b[bo + x];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
      n++;
    }
  }
  const overlap = ((x1 - x0) * (y1 - y0)) / Math.min(A.w * A.h, B.w * B.h);
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va <= 1e-6 * n || vb <= 1e-6 * n) return { score: 0, overlap };
  // 平坦（情報が少ない）な重なりは信頼度を下げる
  const flat = Math.min(1, Math.sqrt(Math.min(va, vb) / n) / 4);
  return { score: ((sab - sa * sb / n) / Math.sqrt(va * vb)) * flat, overlap };
}

function strideFor(area) {
  return area > 400000 ? 3 : area > 100000 ? 2 : 1;
}

function searchLocal(A, B, cx, cy, r, minOverlap, stride, step = 1) {
  let best = null;
  const s = stride || strideFor(Math.min(A.w * A.h, B.w * B.h));
  for (let dy = cy - r; dy <= cy + r; dy += step) {
    for (let dx = cx - r; dx <= cx + r; dx += step) {
      const res = ncc(A, B, dx, dy, s);
      if (res.overlap < minOverlap) continue;
      if (!best || res.score > best.score) best = { dx, dy, score: res.score, overlap: res.overlap };
    }
  }
  return best;
}

// 粗い解像度の (dx,dy) を高解像度まで詰める
function refine(a, b, cdx, cdy, minOverlap) {
  // mid
  const rm = a.mid.scale / a.coarse.scale;
  let best = searchLocal(a.mid, b.mid, Math.round(cdx * rm), Math.round(cdy * rm),
    Math.ceil(rm) + 1, minOverlap * 0.8, 0, 2);
  if (!best) return null;
  best = searchLocal(a.mid, b.mid, best.dx, best.dy, 1, minOverlap * 0.8) || best;
  // full
  if (a.full && b.full && a.mid.scale < 1) {
    const rf = 1 / a.mid.scale;
    const cx = Math.round(best.dx * rf), cy = Math.round(best.dy * rf);
    const r = Math.ceil(rf) + 1;
    const big = Math.min(a.w * a.h, b.w * b.h);
    const s1 = big > 1500000 ? 4 : big > 400000 ? 3 : 2;
    let fb = searchLocal(a.full, b.full, cx, cy, r, minOverlap * 0.7, s1, 2);
    if (!fb) return null;
    fb = searchLocal(a.full, b.full, fb.dx, fb.dy, 1, minOverlap * 0.7, Math.max(1, s1 - 2)) || fb;
    return fb;
  }
  return best;
}

// a に対する b の位置 (dx,dy) を推定する
// opts: { minOverlap, hint:{dx,dy} (フル解像度), candidates }
export function register(a, b, opts = {}) {
  const minOverlap = opts.minOverlap ?? 0.08;
  const A = a.coarse, B = b.coarse;
  const nx = nextPow2(A.w + B.w), ny = nextPow2(A.h + B.h);
  const fa = coarseSpectrum(a, nx, ny), fb = coarseSpectrum(b, nx, ny);
  const n = nx * ny;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // A * conj(B)
    const r = fa.re[i] * fb.re[i] + fa.im[i] * fb.im[i];
    const m = fa.im[i] * fb.re[i] - fa.re[i] * fb.im[i];
    const mag = Math.hypot(r, m) + 1e-9;
    re[i] = r / mag; im[i] = m / mag;
  }
  fft2d(re, im, nx, ny, true);

  // 上位ピーク
  const K = opts.candidates ?? 10;
  const peaks = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = re[y * nx + x];
      if (peaks.length < K * 4 || v > peaks[peaks.length - 1].v) {
        peaks.push({ x, y, v });
        peaks.sort((p, q) => q.v - p.v);
        if (peaks.length > K * 4) peaks.pop();
      }
    }
  }
  const cands = [];
  for (const p of peaks) {
    let dx = p.x >= nx / 2 ? p.x - nx : p.x;
    let dy = p.y >= ny / 2 ? p.y - ny : p.y;
    if (cands.some((c) => Math.abs(c.dx - dx) <= 2 && Math.abs(c.dy - dy) <= 2)) continue;
    cands.push({ dx, dy });
    if (cands.length >= K) break;
  }
  if (opts.hint) {
    cands.push({ dx: Math.round(opts.hint.dx * A.scale), dy: Math.round(opts.hint.dy * A.scale) });
  }

  // 粗い解像度で NCC 検証（±1 の近傍も見る）
  const scored = [];
  for (const c of cands) {
    const r = searchLocal(A, B, c.dx, c.dy, 1, minOverlap, 1);
    if (r) scored.push(r);
  }
  scored.sort((p, q) => q.score - p.score);
  let best = null;
  for (const c of scored.slice(0, 3)) {
    const r = refine(a, b, c.dx, c.dy, minOverlap);
    if (r && (!best || r.score > best.score)) best = r;
    if (best && best.score > 0.85) break;
  }
  return best; // {dx, dy, score, overlap} | null
}

// 現在位置付近だけを探す（手動配置後のスナップ用）
export function registerNear(a, b, dx, dy, radiusFull, opts = {}) {
  const minOverlap = opts.minOverlap ?? 0.03;
  const s = a.coarse.scale;
  const r = Math.max(2, Math.ceil(radiusFull * s));
  const c = searchLocal(a.coarse, b.coarse, Math.round(dx * s), Math.round(dy * s), r, minOverlap, 1);
  if (!c) return null;
  return refine(a, b, c.dx, c.dy, minOverlap);
}
