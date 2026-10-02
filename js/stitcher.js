// 新しい画像（フレーム）をモザイクのどこに置くかを決める
import { makeFeatures, register, registerNear, scalesFor } from './register.js';
import { makeThumb, canvasToBlob, nextFrame } from './imageutil.js';

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export class Stitcher {
  constructor(mosaic, settings) {
    this.mosaic = mosaic;
    this.settings = settings;
    this.scales = null;
  }

  get threshold() { return this.settings.threshold; }

  features(frame) {
    if (!this.scales || !this.mosaic.tiles.length) this.scales = scalesFor(frame.w, frame.h);
    return makeFeatures(frame.gray, frame.w, frame.h, this.scales);
  }

  // frame.canvas の内容からタイルを作る。srcBlob があればそれを元画像として使う
  async makeTile(frame, feat, srcBlob, x, y, placed) {
    let src = srcBlob, sx = frame.rect.sx, sy = frame.rect.sy;
    if (!src) {
      src = await canvasToBlob(frame.canvas, 'image/jpeg', 0.95);
      sx = 0; sy = 0;
    }
    const { bmp, scale } = await makeThumb(frame.canvas, frame.w, frame.h, this.settings.thumbSize);
    const tile = { x, y, w: frame.w, h: frame.h, placed, thumb: bmp, thumbScale: scale, src, sx, sy, feat };
    this.mosaic.add(tile);
    this.mosaic.touchFullGray(tile);
    return tile;
  }

  // 既存タイル（order の順）に対して feat の位置を探す
  async locate(feat, order, maxTries = Infinity) {
    let best = null, tries = 0;
    for (const t of order) {
      if (!t.placed) continue;
      if (tries++ >= maxTries) break;
      await this.mosaic.ensureFullGray(t);
      const r = register(t.feat, feat);
      if (r && r.score >= this.threshold && (!best || r.score > best.score)) {
        best = { x: t.x + r.dx, y: t.y + r.dy, score: r.score, tile: t };
        if (r.score > 0.85) break;
      }
      await nextFrame();
    }
    return best;
  }

  // 位置 (x,y) 付近で、重なっている既存タイルとの位置合わせを詰める
  async refineAt(feat, x, y, radius, exclude = null) {
    const rect = { x, y, w: feat.w, h: feat.h };
    const others = this.mosaic.placed()
      .filter((t) => t !== exclude)
      .map((t) => ({ t, a: overlapArea(rect, t) }))
      .filter((o) => o.a > 0.03 * feat.w * feat.h)
      .sort((p, q) => q.a - p.a)
      .slice(0, 3);
    let best = null;
    for (const { t } of others) {
      await this.mosaic.ensureFullGray(t);
      const r = registerNear(t.feat, feat, x - t.x, y - t.y, radius);
      if (r && r.score >= this.threshold * 0.9 && (!best || r.score > best.score)) {
        best = { x: t.x + r.dx, y: t.y + r.dy, score: r.score };
      }
    }
    return best;
  }

  // スクリーンショット1枚を追加
  async addStill(frame, srcBlob) {
    const feat = this.features(frame);
    const placed = this.mosaic.placed();
    if (!placed.length) {
      await this.makeTile(frame, feat, srcBlob, 0, 0, true);
      return 'first';
    }
    const order = [...placed].sort((a, b) => b.id - a.id); // 新しい順
    const hit = await this.locate(feat, order);
    if (hit) {
      await this.makeTile(frame, feat, srcBlob, hit.x, hit.y, true);
      return 'placed';
    }
    const bb = this.mosaic.bbox(true);
    await this.makeTile(frame, feat, srcBlob, bb.x + bb.w + 60, bb.y, false);
    return 'unplaced';
  }

  // 手で動かしたタイルを周囲にピタッと合わせる
  async snap(tile) {
    await this.mosaic.ensureFullGray(tile);
    const radius = Math.max(80, 0.25 * Math.min(tile.w, tile.h));
    const hit = await this.refineAt(tile.feat, tile.x, tile.y, radius, tile);
    if (!hit) return false;
    tile.x = hit.x; tile.y = hit.y; tile.placed = true;
    this.mosaic.changed();
    return true;
  }

  // 周囲のどこかに合う場所がないか全体から探す
  async autoPlace(tile) {
    await this.mosaic.ensureFullGray(tile);
    const order = this.mosaic.placed().filter((t) => t !== tile).sort((a, b) => b.id - a.id);
    const hit = await this.locate(tile.feat, order);
    if (!hit) return false;
    tile.x = hit.x; tile.y = hit.y; tile.placed = true;
    this.mosaic.changed();
    return true;
  }
}

// 動画・画面キャプチャの連続フレームを追跡して、未取得の範囲に来たらタイルを追加する
export class Tracker {
  constructor(stitcher) {
    this.st = stitcher;
    this.mosaic = stitcher.mosaic;
    this.ref = null;
    this.pos = null;
    this.vel = null;
    this.lost = true;
    this.scan = 0;
  }

  get addThreshold() { return this.st.settings.addUncovered; }

  // opts.final: 最後のフレーム（少しでも未取得部分があれば取り込む）
  async process(frame, opts = {}) {
    const st = this.st;
    const feat = st.features(frame);
    const rectAt = (p) => (p ? { x: p.x, y: p.y, w: frame.w, h: frame.h } : null);

    if (!this.mosaic.placed().length) {
      await st.makeTile(frame, feat, null, 0, 0, true);
      this.ref = feat; this.pos = { x: 0, y: 0 }; this.lost = false; this.vel = null;
      return { state: 'added', rect: rectAt(this.pos) };
    }

    let still = false;
    if (!this.lost && this.ref) {
      const r = register(this.ref, feat, { hint: this.vel || undefined });
      if (r && r.score >= st.threshold) {
        still = Math.abs(r.dx) + Math.abs(r.dy) <= 2;
        this.vel = { dx: r.dx, dy: r.dy };
        this.pos = { x: this.pos.x + r.dx, y: this.pos.y + r.dy };
        this.ref = feat;
      } else {
        this.lost = true;
        this.ref = null;
        this.vel = null;
      }
    }

    if (this.lost) {
      // 近いタイル 2 枚 ＋ 全体を順番に 2 枚ずつ試す
      const tiles = this.mosaic.placed();
      const near = this.pos
        ? [...tiles].sort((a, b) => Math.hypot(a.x - this.pos.x, a.y - this.pos.y) - Math.hypot(b.x - this.pos.x, b.y - this.pos.y)).slice(0, 2)
        : [];
      const rot = [];
      for (let i = 0; i < Math.min(2, tiles.length); i++) rot.push(tiles[(this.scan + i) % tiles.length]);
      this.scan = (this.scan + 2) % Math.max(1, tiles.length);
      const order = [...new Set([...near, ...rot])];
      const hit = await st.locate(feat, order);
      if (!hit) return { state: 'lost', rect: rectAt(this.pos) };
      this.pos = { x: hit.x, y: hit.y };
      this.ref = feat;
      this.lost = false;
    }

    const unc = this.mosaic.uncoveredFraction(this.pos.x, this.pos.y, frame.w, frame.h);
    // 止まった場所・最後のフレームは、少しでも未取得なら取り込む
    const need = opts.final ? 0.01 : still ? Math.min(0.03, this.addThreshold) : this.addThreshold;
    if (unc > need) {
      // 既存タイルと直接合わせ直して誤差の蓄積を防ぐ
      const fix = await st.refineAt(feat, this.pos.x, this.pos.y, 24);
      if (fix) this.pos = { x: fix.x, y: fix.y };
      await st.makeTile(frame, feat, null, this.pos.x, this.pos.y, true);
      return { state: 'added', rect: rectAt(this.pos) };
    }
    return { state: 'tracking', rect: rectAt(this.pos) };
  }
}
