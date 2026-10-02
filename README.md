# 画像つなぎ LargePic

スクロールした画面（地図アプリなど）を**画面収録 / スクリーンショット**から自動でつなぎ合わせ、**1枚の大きな画像**として保存するアプリ。
Web アプリ（PWA）として動き、Capacitor で **Android / iOS のネイティブアプリ**（Play ストア / App Store 公開用）にもなります。画像はすべて端末内で処理され、送信しません。

## できること

- **撮影ボタン** → 画面収録を開始（ネイティブ版：アプリ内ボタン / Web 版：OS の画面収録 → 動画を選択 / PC：ライブ取り込み）
- 収録動画を再生しながら位置を追跡し、**未取得範囲が出たコマだけ**取り込んで連結（止まったコマを優先）
- **赤い斜線 = まだ埋まっていない範囲**。［不足部分を追加撮影］で追加の動画を撮ると、取り込み済みの場所を目印に位置を合わせて埋まる
- 作業内容は端末内に**自動保存**（撮影のため他アプリへ切り替えても続きから再開）
- 保存時のトリミング：**四角 / 丸** × **外接 / 内接 / 自由**（ドラッグで調整）
- 撮影のコツ・使い方ヘルプ内蔵

## 構成

```
www/                 Web アプリ本体（ビルド不要の静的ファイル）
  js/register.js       位置合わせ（位相相関 FFT → NCC → 1px 精度）
  js/stitcher.js       タイル配置・動画追跡（Tracker）
  js/mosaic.js         タイル集合・書き出し
  js/trim.js           内接/外接/自由 トリミング
  js/store.js          IndexedDB 自動保存
  js/native.js         ネイティブ（Capacitor）橋渡し
android/             Android（ScreenRecorder プラグイン：MediaProjection + 前面サービス）
ios/                 iOS（ScreenRecorder プラグイン + ReplayKit 拡張の手順は下記）
resources/           アイコン元画像・生成スクリプト・ストア用画像
test/                単体テスト・ブラウザ通し試験
```

## 開発

```sh
npm install
npm start            # http://localhost:8000
npm test             # 位置合わせの単体テスト
npm run test:e2e     # Playwright 通し試験（スクショ/動画/追加動画/トリミング/自動保存）
npm run icons        # resources/icon-source.jpg から全アイコン・スプラッシュ・ストア画像を再生成
```

## Android（Play ストア）

必要：Android Studio（または Android SDK + JDK 17+）

```sh
npm install
npx cap sync android
npx cap open android          # Android Studio で開く → ▶ で実機実行
```

- 録画：［● 録画を開始］→ 許可ダイアログ → ホームに戻って地図で撮影 → 通知の［停止して取り込む］（またはアプリに戻って停止）
- **公開**：Android Studio の *Build > Generate Signed App Bundle* で `.aab` を作成し Play Console へ。`applicationId` は `com.fuuchanlab.largepic`（`capacitor.config.json` と `android/app/build.gradle`。変更するなら両方＋`MainActivity` のパッケージ）。
- ストア素材：`resources/store/play-icon-512.png`（アイコン）、`feature-graphic-1024x500.png`（フィーチャー画像）
- 権限の申告：Play Console の「フォアグラウンド サービス（mediaProjection）」宣言で、用途＝「ユーザーが開始した画面収録を地図画像の作成に使う」と記載。

## iOS（App Store）

必要：Mac + Xcode 15 以上、Apple Developer アカウント

iOS は他アプリの画面を録画できるのが **ReplayKit のブロードキャスト拡張**だけのため、Xcode で拡張ターゲットを1つ追加します（雛形は `ios/App/LargePicBroadcast/` に用意済み）。

```sh
npm install
npx cap sync ios
npx cap open ios
```

1. **File > New > Target > Broadcast Upload Extension** を選び、名前 `LargePicBroadcast`、*Include UI Extension* は**オフ**、Bundle Identifier は `com.fuuchanlab.largepic.Broadcast`。
2. 自動生成された `SampleHandler.swift` / `Info.plist` を、`ios/App/LargePicBroadcast/` の同名ファイルの内容で置き換え（またはそのファイルをターゲットに追加）。
3. **App と LargePicBroadcast の両ターゲット**で *Signing & Capabilities > + Capability > App Groups* を追加し、`group.com.fuuchanlab.largepic` を有効化（Entitlements は `App/App.entitlements`・`LargePicBroadcast/LargePicBroadcast.entitlements`）。
4. 実機で実行 → ［● 録画を開始］→「LargePic」を選んで「ブロードキャストを開始」→ 地図アプリで撮影 → 画面上部の赤い表示から停止 → アプリに戻ると自動で取り込み。
5. **公開**：Product > Archive → App Store Connect。アイコンは `AppIcon-512@2x.png`（1024px）設定済み。

> Android の Capacitor は SPM ではなく Gradle、iOS は Swift Package Manager（CocoaPods 不要）です。

## 仕様メモ

- 平行移動のみ対応。撮影中の拡大縮小・回転があると位置が合いません（ヘルプに注意書きあり）。
- iPhone の書き出し上限は約 1,670 万画素。超える場合は自動で縮小サイズを提案します。
