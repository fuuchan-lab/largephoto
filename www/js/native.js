// ネイティブアプリ（Capacitor）との橋渡し
// ブラウザ版では何もしない。ネイティブ版では画面収録プラグイン ScreenRecorder を使う。
//
// ScreenRecorder プラグインの API（android/ と native/ios/ に実装）:
//   start()            画面収録を開始（Android: MediaProjection / iOS: ReplayKit の放送ピッカーを表示）
//   stop()             → { path }   収録を止めて動画ファイルのパスを返す（Android のみ。iOS はシステム側で停止）
//   getPending()       → { path? }  まだ取り込んでいない収録済み動画があれば返す
//   clearPending()
//   addListener('recordingStopped', ({ path }) => …)
import { isIOS } from './imageutil.js';

const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
export const nativePlatform = isNative ? Cap.getPlatform() : null; // 'android' | 'ios'
export const webPlatform = isNative ? null : isIOS ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop';

export const ScreenRecorder = isNative
  ? (Cap.registerPlugin ? Cap.registerPlugin('ScreenRecorder') : Cap.Plugins?.ScreenRecorder)
  : null;

export async function nativeFileToBlob(path) {
  const url = Cap.convertFileSrc(path.startsWith('file://') ? path : 'file://' + path);
  const r = await fetch(url);
  if (!r.ok) throw new Error('録画ファイルを読み込めませんでした');
  return r.blob();
}
