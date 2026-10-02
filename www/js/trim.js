// 書き出し範囲（トリミング）：四角形／丸 × 外接／内接／自由
// 範囲はモザイク座標の {x, y, w, h}（丸の場合は w = h の正方形に内接する円）

// 覆われているかどうかのグリッド（セル中心でサンプル）
function coverGrid(mosaic, maxCells = 360) {
  const bb = mosaic.bbox();
  if (!bb) return null;
  const cell = Math.max(bb.w, bb.h) / maxCells;
  const gw = Math.max(1, Math.ceil(bb.w / cell)), gh = Math.max(1, Math.ceil(bb.h / cell));
  const g = new Uint8Array(gw * gh);
  // タイルの矩形を塗る（セル中心が入るものだけ）
  for (const t of mosaic.placed()) {
    const i0 = Math.max(0, Math.ceil((t.x - bb.x) / cell - 0.5));
    const i1 = Math.min(gw - 1, Math.floor((t.x + t.w - bb.x) / cell - 0.5));
    const j0 = Math.max(0, Math.ceil((t.y - bb.y) / cell - 0.5));
    const j1 = Math.min(gh - 1, Math.floor((t.y + t.h - bb.y) / cell - 0.5));
    for (let j = j0; j <= j1; j++) g.fill(1, j * gw + i0, j * gw + i1 + 1);
  }
  return { g, gw, gh, cell, bb };
}

// 1 のセルだけでできた最大の長方形（ヒストグラム法）
function maxRect(g, gw, gh) {
  const h = new Int32Array(gw);
  let best = { area: 0, i: 0, j: 0, w: 0, h: 0 };
  const stack = [];
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) h[i] = g[j * gw + i] ? h[i] + 1 : 0;
    stack.length = 0;
    for (let i = 0; i <= gw; i++) {
      const cur = i < gw ? h[i] : 0;
      let start = i;
      while (stack.length && stack[stack.length - 1][1] >= cur) {
        const [si, sh] = stack.pop();
        const area = sh * (i - si);
        if (area > best.area) best = { area, i: si, j: j - sh + 1, w: i - si, h: sh };
        start = si;
      }
      stack.push([start, cur]);
    }
  }
  return best;
}

// 未取得セルからの距離（2パスの近似ユークリッド距離）
function distField(g, gw, gh) {
  const INF = 1e9;
  const d = new Float32Array(gw * gh);
  for (let k = 0; k < d.length; k++) d[k] = g[k] ? INF : 0;
  const at = (i, j) => (i < 0 || j < 0 || i >= gw || j >= gh ? 0 : d[j * gw + i]);
  const D = Math.SQRT2;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      if (!d[k]) continue;
      d[k] = Math.min(d[k], at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + D, at(i + 1, j - 1) + D);
    }
  }
  for (let j = gh - 1; j >= 0; j--) {
    for (let i = gw - 1; i >= 0; i--) {
      const k = j * gw + i;
      if (!d[k]) continue;
      d[k] = Math.min(d[k], at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + D, at(i - 1, j + 1) + D);
    }
  }
  return d;
}

// 端にはみ出しが残らないよう、境界上に未取得があれば 1px ずつ縮める
function tightenRect(mosaic, r) {
  const edgeOk = (x0, y0, x1, y1) => {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
    for (let k = 0; k <= n; k++) {
      if (!mosaic.covers(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n)) return false;
    }
    return true;
  };
  let { x, y, w, h } = r;
  for (let it = 0; it < 200 && w > 4 && h > 4; it++) {
    let changed = false;
    if (!edgeOk(x + 0.5, y + 0.5, x + w - 0.5, y + 0.5)) { y++; h--; changed = true; }
    if (!edgeOk(x + 0.5, y + h - 0.5, x + w - 0.5, y + h - 0.5)) { h--; changed = true; }
    if (!edgeOk(x + 0.5, y + 0.5, x + 0.5, y + h - 0.5)) { x++; w--; changed = true; }
    if (!edgeOk(x + w - 0.5, y + 0.5, x + w - 0.5, y + h - 0.5)) { w--; changed = true; }
    if (!changed) break;
  }
  return { x, y, w, h };
}

export function computeTrim(mosaic, shape, fit) {
  const bb = mosaic.bbox();
  if (!bb) return null;
  if (fit === 'outer') {
    if (shape === 'rect') return { ...bb };
    const d = Math.ceil(Math.hypot(bb.w, bb.h));
    return { x: Math.floor(bb.x + bb.w / 2 - d / 2), y: Math.floor(bb.y + bb.h / 2 - d / 2), w: d, h: d };
  }
  const cg = coverGrid(mosaic);
  const { g, gw, gh, cell } = cg;
  if (shape === 'rect') {
    const m = maxRect(g, gw, gh);
    if (!m.area) return null;
    const r = {
      x: Math.round(bb.x + m.i * cell), y: Math.round(bb.y + m.j * cell),
      w: Math.round(m.w * cell), h: Math.round(m.h * cell),
    };
    // グリッドの粗さぶん外へ広げてから、ぴったりまで縮める
    const e = Math.ceil(cell);
    return tightenRect(mosaic, { x: r.x - e, y: r.y - e, w: r.w + 2 * e, h: r.h + 2 * e });
  }
  const d = distField(g, gw, gh);
  let bi = 0;
  for (let k = 1; k < d.length; k++) if (d[k] > d[bi]) bi = k;
  if (!d[bi]) return null;
  const cx = bb.x + ((bi % gw) + 0.5) * cell, cy = bb.y + (Math.floor(bi / gw) + 0.5) * cell;
  let rad = (d[bi] - 0.5) * cell;
  // 円周上に未取得があれば縮める
  for (let it = 0; it < 100 && rad > 4; it++) {
    let ok = true;
    const n = Math.max(32, Math.ceil(rad));
    for (let k = 0; k < n && ok; k++) {
      const a = (k / n) * Math.PI * 2;
      if (!mosaic.covers(cx + Math.cos(a) * (rad - 0.5), cy + Math.sin(a) * (rad - 0.5))) ok = false;
    }
    if (ok) break;
    rad -= Math.max(1, cell / 2);
  }
  const r = Math.floor(rad);
  return { x: Math.round(cx - r), y: Math.round(cy - r), w: 2 * r, h: 2 * r };
}

// プレビュー上で範囲をドラッグ／リサイズする
export class TrimEditor {
  constructor(canvas, mosaic, drawOverviewFn) {
    this.canvas = canvas;
    this.mosaic = mosaic;
    this.drawOverview = drawOverviewFn;
    this.shape = 'rect';
    this.rect = null;
    this.editable = false;
    this.onChange = null;
    this._bind();
  }

  // 表示範囲：モザイク全体（＋トリミング範囲）
  region() {
    let bb = this.mosaic.bbox(true);
    if (!bb) return null;
    if (this.rect) {
      const r = this.rect;
      const x0 = Math.min(bb.x, r.x), y0 = Math.min(bb.y, r.y);
      bb = { x: x0, y: y0, w: Math.max(bb.x + bb.w, r.x + r.w) - x0, h: Math.max(bb.y + bb.h, r.y + r.h) - y0 };
    }
    return bb;
  }

  draw(region = this.region()) {
    if (!region) return;
    const T = this.drawOverview(this.canvas, this.mosaic, { region });
    const L = this.L = { ...T, bb: region };
    const ctx = this.canvas.getContext('2d');
    const r = this.rect;
    if (!r) return;
    const x = L.ox + r.x * L.s, y = L.oy + r.y * L.s, w = r.w * L.s, h = r.h * L.s;
    ctx.save();
    // 範囲外を暗く
    ctx.beginPath();
    ctx.rect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    if (this.shape === 'circle') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2, true);
    else { ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y); ctx.closePath(); }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#3da5ff'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (this.shape === 'circle') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(x, y, w, h);
    ctx.stroke();
    if (this.editable) {
      ctx.fillStyle = '#3da5ff';
      for (const [hx, hy] of this.handles(x, y, w, h)) { ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }

  handles(x, y, w, h) {
    if (this.shape === 'circle') return [[x + w / 2 + (w / 2) * Math.SQRT1_2, y + h / 2 + (h / 2) * Math.SQRT1_2]];
    return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const pos = (e) => { const b = c.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    c.addEventListener('pointerdown', (e) => {
      if (!this.editable || !this.rect || !this.L) return;
      const p = pos(e), L = this.L, r = this.rect;
      const x = L.ox + r.x * L.s, y = L.oy + r.y * L.s, w = r.w * L.s, h = r.h * L.s;
      const hs = this.handles(x, y, w, h);
      let hi = -1;
      hs.forEach(([hx, hy], i) => { if (Math.hypot(p.x - hx, p.y - hy) < 22) hi = i; });
      const inside = p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
      if (hi < 0 && !inside) return;
      c.setPointerCapture(e.pointerId);
      this.drag = { hi, p0: p, r0: { ...r } };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = pos(e), L = this.L, d = this.drag, r0 = d.r0;
      const dx = (p.x - d.p0.x) / L.s, dy = (p.y - d.p0.y) / L.s;
      const min = 20;
      let r = { ...r0 };
      if (d.hi < 0) { r.x = r0.x + dx; r.y = r0.y + dy; }
      else if (this.shape === 'circle') {
        const k = Math.max(min, r0.w + (dx + dy) * Math.SQRT1_2 * 2);
        r = { x: r0.x + (r0.w - k) / 2, y: r0.y + (r0.h - k) / 2, w: k, h: k };
      } else {
        const left = d.hi === 0 || d.hi === 2, top = d.hi === 0 || d.hi === 1;
        if (left) { r.x = Math.min(r0.x + dx, r0.x + r0.w - min); r.w = r0.x + r0.w - r.x; } else r.w = Math.max(min, r0.w + dx);
        if (top) { r.y = Math.min(r0.y + dy, r0.y + r0.h - min); r.h = r0.y + r0.h - r.y; } else r.h = Math.max(min, r0.h + dy);
      }
      this.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      // ドラッグ中は表示倍率を動かさない
      this.draw(L.bb);
    });
    const end = () => { if (this.drag) { this.drag = null; this.draw(); this.onChange?.(); } };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}
