// 作業中のプロジェクトを端末内 (IndexedDB) に自動保存する
// 撮影のために他のアプリへ切り替えている間にページが閉じられても、続きから再開できる
import { decodeCrop, grayOf, makeThumb } from './imageutil.js';
import { makeFeatures, scalesFor } from './register.js';

const DB = 'largepic';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta');
      db.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(db, stores, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class ProjectStore {
  constructor(mosaic) {
    this.mosaic = mosaic;
    this.saved = new Set(); // 保存済み blob の id
    this.timer = 0;
    this.enabled = typeof indexedDB !== 'undefined';
    this.saving = Promise.resolve();
  }

  // 変更のたびに呼ぶ（まとめて保存）
  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.saving = this.save().catch((e) => console.warn('save failed', e)); }, 600);
  }

  async flush() {
    clearTimeout(this.timer);
    await this.saving;
    if (this.enabled) await this.save();
  }

  async save() {
    const db = await open();
    const tiles = this.mosaic.tiles;
    const ids = new Set(tiles.map((t) => t.id));
    const meta = {
      version: 1,
      nextId: this.mosaic.nextId,
      tiles: tiles.map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, placed: t.placed, sx: t.sx, sy: t.sy })),
    };
    const add = tiles.filter((t) => !this.saved.has(t.id));
    const del = [...this.saved].filter((id) => !ids.has(id));
    await tx(db, ['meta', 'blobs'], 'readwrite', (t) => {
      const b = t.objectStore('blobs');
      for (const tile of add) b.put(tile.src, tile.id);
      for (const id of del) b.delete(id);
      t.objectStore('meta').put(meta, 'project');
    });
    for (const tile of add) this.saved.add(tile.id);
    for (const id of del) this.saved.delete(id);
  }

  async hasProject() {
    if (!this.enabled) return false;
    try {
      const db = await open();
      const m = await req(db.transaction('meta').objectStore('meta').get('project'));
      return !!(m && m.tiles && m.tiles.length);
    } catch {
      return false;
    }
  }

  async load(stitcher, onProgress) {
    const db = await open();
    const t = db.transaction(['meta', 'blobs']);
    const meta = await req(t.objectStore('meta').get('project'));
    if (!meta || !meta.tiles?.length) return 0;
    const blobs = new Map();
    for (const m of meta.tiles) blobs.set(m.id, await req(db.transaction('blobs').objectStore('blobs').get(m.id)));
    const first = meta.tiles[0];
    stitcher.scales = scalesFor(first.w, first.h);
    let n = 0;
    for (const m of meta.tiles) {
      const src = blobs.get(m.id);
      if (!src) continue;
      const bmp = await decodeCrop(src, m.sx, m.sy, m.w, m.h);
      const gray = grayOf(bmp);
      const { bmp: thumb, scale } = await makeThumb(bmp, m.w, m.h, stitcher.settings.thumbSize);
      bmp.close?.();
      const feat = makeFeatures(gray, m.w, m.h, stitcher.scales);
      feat.full = null;
      this.mosaic.tiles.push({ ...m, thumb, thumbScale: scale, src, feat });
      this.saved.add(m.id);
      onProgress?.(++n / meta.tiles.length);
    }
    this.mosaic.nextId = Math.max(meta.nextId || 1, ...this.mosaic.tiles.map((x) => x.id + 1));
    this.mosaic.changed();
    return n;
  }

  async clear() {
    if (!this.enabled) return;
    const db = await open();
    await tx(db, ['meta', 'blobs'], 'readwrite', (t) => {
      t.objectStore('meta').clear();
      t.objectStore('blobs').clear();
    });
    this.saved.clear();
  }
}
