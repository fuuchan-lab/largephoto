// 新しい画像（フレーム）をモザイクのどこに置くかを決める
import { makeFeatures, register, registerNear, coarseMatch, scalesFor } from './register.js';
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
  // タイルが多いときは、粗い解像度で全部を素早く採点してから有望なものだけ詰める
  async locate(feat, order) {
    order = order.filter((t) => t.placed);
    if (order.length > 3) {
      const scored = [];
      for (let i = 0; i < order.length; i++) {
        const c = coarseMatch(order[i].feat, feat);
        if (c && c.score > 0.25) scored.push({ t: order[i], s: c.score });
        if (i % 8 === 7) await nextFrame();
      }
      scored.sort((p, q) => q.s - p.s);
      order = scored.slice(0, 3).map((o) => o.t);
    }
    let best = null;
    for (const t of order) {
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
// スクロール中のコマはブレやすいので、止まったコマを優先して取り込む
export class Tracker {
  constructor(stitcher) {
    this.st = stitcher;
    this.mosaic = stitcher.mosaic;
    this.ref = null;
    this.pos = null;
    this.vel = null;
    this.lost = true;
    this.stats = { added: 0, lost: 0, frames: 0 };
  }

  get addThreshold() { return this.st.settings.addUncovered; }

  // opts.final: 最後のフレーム（少しでも未取得部分があれば取り込む）
  async process(frame, opts = {}) {
    const st = this.st;
    const feat = st.features(frame);
    const rectAt = (p) => (p ? { x: p.x, y: p.y, w: frame.w, h: frame.h } : null);
    this.stats.frames++;

    if (!this.mosaic.placed().length) {
      // 最初の1枚は「同じ画面が続けて追跡でき、実際にスクロールされた」ことを確認してから確定する
      // （収録開始直後のこのアプリの画面や、アプリ切り替え中の画面を取り込まないため）
      if (this.cand) {
        const r = register(this.cand, feat);
        if (r && r.score >= st.threshold) { this.chain++; this.chainMove += Math.hypot(r.dx, r.dy); }
        else { this.chain = 0; this.chainMove = 0; }
      } else { this.chain = 0; this.chainMove = 0; }
      this.cand = feat;
      const small = Math.min(frame.w, frame.h);
      if (!(opts.final || opts.immediate || (this.chain >= 2 && this.chainMove > small * 0.03))) {
        return { state: 'waiting', rect: null };
      }
      await st.makeTile(frame, feat, null, 0, 0, true);
      this.ref = feat; this.pos = { x: 0, y: 0 }; this.lost = false; this.vel = null; this.cand = null;
      this.stats.added++;
      return { state: 'added', rect: rectAt(this.pos) };
    }

    let motion = Infinity;
    if (!this.lost && this.ref) {
      const r = register(this.ref, feat, { hint: this.vel || undefined });
      if (r && r.score >= st.threshold) {
        motion = Math.hypot(r.dx, r.dy);
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
      // 近い順に並べて全タイルから探す（追加動画で不足部分を埋めるときもここで復帰）
      let order = this.mosaic.placed();
      if (this.pos) order = [...order].sort((a, b) => Math.hypot(a.x - this.pos.x, a.y - this.pos.y) - Math.hypot(b.x - this.pos.x, b.y - this.pos.y));
      const hit = await st.locate(feat, order);
      if (!hit) { this.stats.lost++; return { state: 'lost', rect: rectAt(this.pos) }; }
      this.pos = { x: hit.x, y: hit.y };
      this.ref = feat;
      this.lost = false;
      motion = Infinity;
    }

    const unc = this.mosaic.uncoveredFraction(this.pos.x, this.pos.y, frame.w, frame.h);
    const small = Math.min(frame.w, frame.h);
    const still = motion <= Math.max(2, small * 0.01);
    const fast = motion > small * 0.08;
    // 止まったコマ：少しでも新しければ取り込む／速く動いているコマ：かなり欠けるまで待つ
    let need = this.addThreshold;
    if (opts.final) need = 0.01;
    else if (still) need = Math.min(0.03, need);
    else if (fast) need = Math.max(need, 0.45);
    if (unc > need) {
      // 既存タイルと直接合わせ直して誤差の蓄積を防ぐ
      const fix = await st.refineAt(feat, this.pos.x, this.pos.y, 24);
      if (fix) this.pos = { x: fix.x, y: fix.y };
      await st.makeTile(frame, feat, null, this.pos.x, this.pos.y, true);
      this.stats.added++;
      return { state: 'added', rect: rectAt(this.pos) };
    }
    return { state: 'tracking', rect: rectAt(this.pos) };
  }
}
