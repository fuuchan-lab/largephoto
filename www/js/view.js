// モザイクの表示と、指・マウスでの操作（パン／ピンチ／タイルのドラッグ）

let hatch = null;
function hatchPattern(ctx) {
  if (hatch) return ctx.createPattern(hatch, 'repeat');
  hatch = document.createElement('canvas');
  hatch.width = hatch.height = 14;
  const h = hatch.getContext('2d');
  h.fillStyle = 'rgba(255,80,80,0.18)';
  h.fillRect(0, 0, 14, 14);
  h.strokeStyle = 'rgba(255,80,80,0.55)';
  h.lineWidth = 2;
  h.beginPath();
  h.moveTo(-2, 16); h.lineTo(16, -2);
  h.moveTo(-2, 2); h.lineTo(2, -2);
  h.moveTo(12, 16); h.lineTo(16, 12);
  h.stroke();
  return ctx.createPattern(hatch, 'repeat');
}

// 全体図（ミニマップ・別窓用）
// region を渡すとその範囲を表示する。戻り値は表示変換 { s, ox, oy }
export function drawOverview(canvas, mosaic, { viewRect, liveRect, lost, region } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || canvas.width / dpr, ch = canvas.clientHeight || canvas.height / dpr;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111418';
  ctx.fillRect(0, 0, cw, ch);
  let bb = region || mosaic.bbox(true);
  if (!bb) return null;
  if (liveRect) {
    const x0 = Math.min(bb.x, liveRect.x), y0 = Math.min(bb.y, liveRect.y);
    const x1 = Math.max(bb.x + bb.w, liveRect.x + liveRect.w), y1 = Math.max(bb.y + bb.h, liveRect.y + liveRect.h);
    bb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const pad = 6;
  const s = Math.min((cw - pad * 2) / bb.w, (ch - pad * 2) / bb.h);
  const ox = (cw - bb.w * s) / 2 - bb.x * s, oy = (ch - bb.h * s) / 2 - bb.y * s;
  const pb = mosaic.bbox();
  if (pb) {
    ctx.fillStyle = hatchPattern(ctx);
    ctx.fillRect(ox + pb.x * s, oy + pb.y * s, pb.w * s, pb.h * s);
  }
  for (const t of mosaic.tiles) {
    ctx.drawImage(t.thumb, ox + t.x * s, oy + t.y * s, t.w * s, t.h * s);
    if (!t.placed) {
      ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + t.x * s, oy + t.y * s, t.w * s, t.h * s);
    }
  }
  if (viewRect) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
    ctx.strokeRect(ox + viewRect.x * s, oy + viewRect.y * s, viewRect.w * s, viewRect.h * s);
  }
  if (liveRect) {
    ctx.strokeStyle = lost ? '#ffb020' : '#3da5ff'; ctx.lineWidth = 2.5;
    ctx.strokeRect(ox + liveRect.x * s, oy + liveRect.y * s, liveRect.w * s, liveRect.h * s);
  }
  return { s, ox, oy };
}

export class View {
  constructor(canvas, mosaic) {
    this.canvas = canvas;
    this.mosaic = mosaic;
    this.scale = 0.3;    // CSS px / モザイク px
    this.ox = 0; this.oy = 0;   // 画面左上のモザイク座標
    this.mode = 'pan';   // 'pan' | 'adjust'
    this.selected = null;
    this.liveRect = null;
    this.lost = false;
    this.onTap = null;
    this.onTileMoved = null;
    this.onViewChange = null;
    this.pointers = new Map();
    this.pending = false;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.draw();
  }

  get cw() { return this.canvas.clientWidth; }
  get ch() { return this.canvas.clientHeight; }

  toWorld(px, py) { return { x: this.ox + px / this.scale, y: this.oy + py / this.scale }; }

  visibleRect() { return { x: this.ox, y: this.oy, w: this.cw / this.scale, h: this.ch / this.scale }; }

  fit() {
    const bb = this.mosaic.bbox(true);
    if (!bb) { this.scale = 0.3; this.ox = -this.cw / 2 / this.scale; this.oy = -this.ch / 2 / this.scale; this.draw(); return; }
    const pad = 24;
    this.scale = Math.min((this.cw - pad * 2) / bb.w, (this.ch - pad * 2) / bb.h, 2);
    this.ox = bb.x + bb.w / 2 - this.cw / 2 / this.scale;
    this.oy = bb.y + bb.h / 2 - this.ch / 2 / this.scale;
    this.draw();
  }

  // 指定矩形が画面内に入るようにずらす（ライブ時の追従）
  follow(r) {
    const v = this.visibleRect();
    const m = 0.1;
    if (r.w > v.w * (1 - 2 * m) || r.h > v.h * (1 - 2 * m)) {
      this.scale = Math.min(this.cw / (r.w * 1.6), this.ch / (r.h * 1.6));
      this.ox = r.x + r.w / 2 - this.cw / 2 / this.scale;
      this.oy = r.y + r.h / 2 - this.ch / 2 / this.scale;
      return;
    }
    if (r.x < v.x + v.w * m) this.ox = r.x - v.w * m;
    if (r.x + r.w > v.x + v.w * (1 - m)) this.ox = r.x + r.w - v.w * (1 - m);
    if (r.y < v.y + v.h * m) this.oy = r.y - v.h * m;
    if (r.y + r.h > v.y + v.h * (1 - m)) this.oy = r.y + r.h - v.h * (1 - m);
  }

  draw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this._draw(); });
  }

  _draw() {
    const { canvas, mosaic } = this;
    const dpr = this.dpr || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a1d22';
    ctx.fillRect(0, 0, this.cw, this.ch);
    const s = this.scale;
    const sx = (x) => (x - this.ox) * s, sy = (y) => (y - this.oy) * s;

    const bb = mosaic.bbox();
    if (bb) {
      ctx.fillStyle = hatchPattern(ctx);
      ctx.fillRect(sx(bb.x), sy(bb.y), bb.w * s, bb.h * s);
    }
    ctx.imageSmoothingQuality = 'high';
    const v = this.visibleRect();
    for (const t of mosaic.tiles) {
      if (t.x > v.x + v.w || t.y > v.y + v.h || t.x + t.w < v.x || t.y + t.h < v.y) continue;
      let img = t.thumb;
      if (s * dpr > t.thumbScale * 1.15) img = mosaic.getFullCached(t) || t.thumb;
      ctx.globalAlpha = t.placed ? 1 : 0.85;
      ctx.drawImage(img, sx(t.x), sy(t.y), t.w * s, t.h * s);
      ctx.globalAlpha = 1;
      if (!t.placed) {
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 2;
        ctx.strokeRect(sx(t.x), sy(t.y), t.w * s, t.h * s);
        ctx.setLineDash([]);
      }
    }
    if (bb) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx(bb.x) - 0.5, sy(bb.y) - 0.5, bb.w * s + 1, bb.h * s + 1);
      ctx.setLineDash([]);
    }
    if (this.mode === 'adjust') {
      for (const t of mosaic.tiles) {
        if (t === this.selected) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
        ctx.strokeRect(sx(t.x), sy(t.y), t.w * s, t.h * s);
      }
    }
    if (this.selected) {
      const t = this.selected;
      ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 3;
      ctx.strokeRect(sx(t.x), sy(t.y), t.w * s, t.h * s);
    }
    if (this.liveRect) {
      const r = this.liveRect;
      ctx.strokeStyle = this.lost ? '#ffb020' : '#3da5ff'; ctx.lineWidth = 3;
      ctx.strokeRect(sx(r.x), sy(r.y), r.w * s, r.h * s);
    }
    this.onViewChange?.();
  }

  zoomAt(px, py, f) {
    const w = this.toWorld(px, py);
    this.scale = Math.min(8, Math.max(0.005, this.scale * f));
    this.ox = w.x - px / this.scale;
    this.oy = w.y - py / this.scale;
    this.draw();
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        this.gesture = { start: p, last: p, t: performance.now(), moved: false, drag: null };
        if (this.mode === 'adjust') {
          const w = this.toWorld(p.x, p.y);
          const hit = (this.selected && w.x >= this.selected.x && w.x < this.selected.x + this.selected.w &&
            w.y >= this.selected.y && w.y < this.selected.y + this.selected.h) ? this.selected : this.mosaic.hitTest(w.x, w.y);
          if (hit) {
            this.selected = hit;
            this.gesture.drag = { tile: hit, x0: hit.x, y0: hit.y, w0: w };
            this.draw();
          }
        }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        if (this.gesture) { this.gesture.moved = true; this.gesture.drag = null; }
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.ox -= (m.x - this.pinch.m.x) / this.scale;
        this.oy -= (m.y - this.pinch.m.y) / this.scale;
        this.zoomAt(m.x, m.y, d / this.pinch.d);
        this.pinch = { d, m };
        return;
      }
      const g = this.gesture;
      if (!g || this.pointers.size !== 1) return;
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 6) g.moved = true;
      if (g.drag) {
        const w = this.toWorld(p.x, p.y);
        g.drag.tile.x = Math.round(g.drag.x0 + (w.x - g.drag.w0.x));
        g.drag.tile.y = Math.round(g.drag.y0 + (w.y - g.drag.w0.y));
      } else {
        this.ox -= (p.x - g.last.x) / this.scale;
        this.oy -= (p.y - g.last.y) / this.scale;
      }
      g.last = p;
      this.draw();
    });

    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 1) {
        const p = [...this.pointers.values()][0];
        this.gesture = { start: p, last: p, t: 0, moved: true, drag: null };
        return;
      }
      const g = this.gesture;
      this.gesture = null;
      if (!g) return;
      if (g.drag && g.moved) this.onTileMoved?.(g.drag.tile);
      if (!g.moved) {
        const p = pos(e);
        this.onTap?.(this.toWorld(p.x, p.y));
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      // ホイール / トラックパッドのピンチ = ズーム、Shift+ホイール = 横移動
      if (e.shiftKey) {
        this.ox += (e.deltaX || e.deltaY) / this.scale; this.draw();
      } else {
        const k = e.deltaMode ? 0.05 : (e.ctrlKey ? 0.01 : 0.002);
        this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * k));
      }
    }, { passive: false });
  }
}
