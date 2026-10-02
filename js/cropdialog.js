// 切り抜き範囲（検索バーやボタンなど、動かない部分を除外）の設定ダイアログ
import { newCanvas } from './imageutil.js';

export const PRESETS = {
  none: { top: 0, bottom: 0, left: 0, right: 0 },
  phone: { top: 0.13, bottom: 0.14, left: 0, right: 0 },
  desktop: { top: 0.08, bottom: 0.03, left: 0, right: 0 },
};

export function editCrop(dlg, source, sw, sh, initial) {
  return new Promise((resolve) => {
    const canvas = dlg.querySelector('canvas');
    const crop = { ...initial };
    // 元画像を縮小して保持
    const maxW = Math.min(window.innerWidth - 48, 520);
    const maxH = Math.min(window.innerHeight * 0.58, 640);
    const s = Math.min(maxW / sw, maxH / sh);
    const cw = Math.round(sw * s), ch = Math.round(sh * s);
    const img = newCanvas(cw, ch);
    img.getContext('2d').drawImage(source, 0, 0, sw, sh, 0, 0, cw, ch);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    const ctx = canvas.getContext('2d');

    const edges = () => ({
      top: crop.top * ch, bottom: ch - crop.bottom * ch,
      left: crop.left * cw, right: cw - crop.right * cw,
    });

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(img, 0, 0);
      const e = edges();
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(0, 0, cw, e.top);
      ctx.fillRect(0, e.bottom, cw, ch - e.bottom);
      ctx.fillRect(0, e.top, e.left, e.bottom - e.top);
      ctx.fillRect(e.right, e.top, cw - e.right, e.bottom - e.top);
      ctx.strokeStyle = '#3da5ff'; ctx.lineWidth = 2;
      ctx.strokeRect(e.left, e.top, e.right - e.left, e.bottom - e.top);
      ctx.fillStyle = '#3da5ff';
      const hx = (e.left + e.right) / 2, hy = (e.top + e.bottom) / 2;
      const knob = (x, y, w, h) => { ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 4); ctx.fill(); };
      knob(hx, e.top, 44, 10); knob(hx, e.bottom, 44, 10);
      knob(e.left, hy, 10, 44); knob(e.right, hy, 10, 44);
    }

    let drag = null;
    const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const down = (ev) => {
      const p = pos(ev), e = edges();
      const d = [
        ['top', Math.abs(p.y - e.top)], ['bottom', Math.abs(p.y - e.bottom)],
        ['left', Math.abs(p.x - e.left)], ['right', Math.abs(p.x - e.right)],
      ].sort((a, b) => a[1] - b[1])[0];
      if (d[1] < 36) { drag = d[0]; canvas.setPointerCapture(ev.pointerId); }
    };
    const move = (ev) => {
      if (!drag) return;
      const p = pos(ev);
      const cl = (v, max) => Math.max(0, Math.min(max, v));
      if (drag === 'top') crop.top = cl(p.y / ch, 0.9 - crop.bottom);
      if (drag === 'bottom') crop.bottom = cl(1 - p.y / ch, 0.9 - crop.top);
      if (drag === 'left') crop.left = cl(p.x / cw, 0.9 - crop.right);
      if (drag === 'right') crop.right = cl(1 - p.x / cw, 0.9 - crop.left);
      draw();
    };
    const up = () => { drag = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    const presetBtns = dlg.querySelectorAll('[data-preset]');
    const onPreset = (ev) => { Object.assign(crop, PRESETS[ev.currentTarget.dataset.preset]); draw(); };
    presetBtns.forEach((b) => b.addEventListener('click', onPreset));

    const finish = (val) => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      presetBtns.forEach((b) => b.removeEventListener('click', onPreset));
      dlg.querySelector('[data-ok]').onclick = null;
      dlg.querySelector('[data-cancel]').onclick = null;
      dlg.onclose = null;
      img.width = img.height = 0;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    dlg.querySelector('[data-ok]').onclick = () => finish({ ...crop });
    dlg.querySelector('[data-cancel]').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    draw();
    dlg.showModal();
  });
}
