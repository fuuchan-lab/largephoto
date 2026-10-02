// 貼り合わせ中の画像（タイル）の集合
import { decodeCrop, grayOf, newCanvas, canvasToBlob } from './imageutil.js';

// tile: {
//   id, x, y, w, h,          … モザイク座標（px）とサイズ
//   placed,                  … 位置が確定しているか（false=手動で合わせる必要あり）
//   thumb, thumbScale,       … 表示用の縮小画像
//   src, sx, sy,             … 元画像 Blob と切り抜き位置（フル解像度はここから再デコード）
//   feat,                    … 位置合わせ用特徴（register.js）
// }
export class Mosaic {
  constructor() {
    this.tiles = [];
    this.nextId = 1;
    this.listeners = new Set();
    this.cache = new Map();   // id -> フル解像度 ImageBitmap (LRU)
    this.cacheMax = 8;
    this.loading = new Set();
    this.fullGray = [];       // feat.full を保持しているタイル (LRU)
  }

  onChange(fn) { this.listeners.add(fn); }
  changed(kind = 'tiles') { for (const fn of this.listeners) fn(kind); }

  add(tile) {
    tile.id = this.nextId++;
    this.tiles.push(tile);
    this.changed();
    return tile;
  }

  remove(tile) {
    const i = this.tiles.indexOf(tile);
    if (i < 0) return;
    this.tiles.splice(i, 1);
    tile.thumb?.close?.();
    const b = this.cache.get(tile.id);
    b?.close?.();
    this.cache.delete(tile.id);
    this.fullGray = this.fullGray.filter((t) => t !== tile);
    this.changed();
  }

  clear() {
    for (const t of [...this.tiles]) this.remove(t);
    this.nextId = 1;
  }

  bringToFront(tile) {
    const i = this.tiles.indexOf(tile);
    if (i >= 0) { this.tiles.splice(i, 1); this.tiles.push(tile); this.changed(); }
  }

  placed() { return this.tiles.filter((t) => t.placed); }

  bbox(all = false) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of this.tiles) {
      if (!all && !t.placed) continue;
      x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
    }
    if (x0 === Infinity) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  covers(x, y) {
    for (const t of this.tiles) {
      if (t.placed && x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return true;
    }
    return false;
  }

  // 外接矩形のうち画像で埋まっている割合
  coverage() {
    const bb = this.bbox();
    if (!bb) return 0;
    const n = 120;
    const step = Math.max(bb.w, bb.h) / n;
    let tot = 0, hit = 0;
    for (let y = bb.y + step / 2; y < bb.y + bb.h; y += step) {
      for (let x = bb.x + step / 2; x < bb.x + bb.w; x += step) {
        tot++;
        if (this.covers(x, y)) hit++;
      }
    }
    return tot ? hit / tot : 0;
  }

  // 矩形のうち、まだどのタイルにも覆われていない割合
  uncoveredFraction(x, y, w, h) {
    const n = 12;
    let miss = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (!this.covers(x + (i + 0.5) * w / n, y + (j + 0.5) * h / n)) miss++;
      }
    }
    return miss / (n * n);
  }

  hitTest(x, y) {
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const t = this.tiles[i];
      if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return t;
    }
    return null;
  }

  // ---- フル解像度 ----
  loadFull(tile) { return decodeCrop(tile.src, tile.sx, tile.sy, tile.w, tile.h); }

  getFullCached(tile) {
    const b = this.cache.get(tile.id);
    if (b) {
      this.cache.delete(tile.id);
      this.cache.set(tile.id, b);
      return b;
    }
    this.requestFull(tile);
    return null;
  }

  requestFull(tile) {
    if (this.loading.has(tile.id) || this.loading.size >= 2) return;
    this.loading.add(tile.id);
    this.loadFull(tile).then((bmp) => {
      this.loading.delete(tile.id);
      if (!this.tiles.includes(tile)) { bmp.close?.(); return; }
      this.cache.set(tile.id, bmp);
      while (this.cache.size > this.cacheMax) {
        const [k, v] = this.cache.entries().next().value;
        v.close?.();
        this.cache.delete(k);
      }
      this.changed('redraw');
    }, () => this.loading.delete(tile.id));
  }

  // 位置合わせ用のフル解像度グレースケールを用意する（メモリ節約のため少数だけ保持）
  async ensureFullGray(tile) {
    if (!tile.feat.full) {
      const bmp = this.cache.get(tile.id) || await this.loadFull(tile);
      tile.feat.full = { data: grayOf(bmp), w: tile.w, h: tile.h, scale: 1 };
      if (!this.cache.has(tile.id)) bmp.close?.();
    }
    this.touchFullGray(tile);
  }

  touchFullGray(tile) {
    this.fullGray = this.fullGray.filter((t) => t !== tile);
    this.fullGray.push(tile);
    while (this.fullGray.length > 4) {
      const old = this.fullGray.shift();
      old.feat.full = null;
    }
  }

  // ---- 書き出し ----
  // region: 書き出す範囲（省略時は外接矩形）、circle: 丸く切り抜く（範囲の外は透明）
  async exportCanvas({ scale = 1, background = '#ffffff', region = null, circle = false, outside = null, onProgress } = {}) {
    const bb = region || this.bbox();
    if (!bb) throw new Error('画像がありません');
    const W = Math.max(1, Math.round(bb.w * scale)), H = Math.max(1, Math.round(bb.h * scale));
    const c = newCanvas(W, H);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('キャンバスを作成できません（サイズが大きすぎます）');
    if (circle) {
      if (outside) { ctx.fillStyle = outside; ctx.fillRect(0, 0, W, H); }
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, W / 2, H / 2, 0, 0, Math.PI * 2);
      ctx.clip();
    }
    if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, W, H); }
    ctx.imageSmoothingQuality = 'high';
    const tiles = this.placed().filter((t) =>
      t.x < bb.x + bb.w && t.y < bb.y + bb.h && t.x + t.w > bb.x && t.y + t.h > bb.y);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const useThumb = scale <= t.thumbScale;
      const bmp = useThumb ? t.thumb : (this.cache.get(t.id) || await this.loadFull(t));
      ctx.drawImage(bmp, (t.x - bb.x) * scale, (t.y - bb.y) * scale, t.w * scale, t.h * scale);
      if (!useThumb && !this.cache.has(t.id)) bmp.close?.();
      onProgress?.((i + 1) / tiles.length);
    }
    return c;
  }

  async exportBlob(opts) {
    const c = await this.exportCanvas(opts);
    try {
      return await canvasToBlob(c, opts.type || 'image/png', opts.quality);
    } finally {
      c.width = c.height = 0;
    }
  }
}
