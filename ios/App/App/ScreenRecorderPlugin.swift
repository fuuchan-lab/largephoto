import Foundation
import Capacitor
import ReplayKit

/// 画面収録プラグイン（JS 側は www/js/native.js を参照）
/// 他のアプリの画面を録画するため、ReplayKit の Broadcast Upload Extension（LargePicBroadcast）を使う。
/// 拡張機能が App Group のコンテナに MP4 を書き出し、アプリに戻ったときに getPending() で受け取る。
@objc(ScreenRecorderPlugin)
public class ScreenRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenRecorderPlugin"
    public let jsName = "ScreenRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPending", returnType: CAPPluginReturnPromise),
    ]

    static let appGroup = "group.com.fuuchanlab.largepic"
    static let extensionBundleId = "com.fuuchanlab.largepic.Broadcast"
    private var picker: RPSystemBroadcastPickerView?

    private var recordingsDir: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)?
            .appendingPathComponent("Recordings", isDirectory: true)
    }

    private func readState() -> [String: Any] {
        guard let url = recordingsDir?.appendingPathComponent("state.json"),
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    /// システムの放送ピッカーを表示する（ユーザーが「ブロードキャストを開始」を押すと録画が始まる）
    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.picker?.removeFromSuperview()
            let p = RPSystemBroadcastPickerView(frame: CGRect(x: -100, y: -100, width: 44, height: 44))
            p.preferredExtension = Self.extensionBundleId
            p.showsMicrophoneButton = false
            self.bridge?.viewController?.view.addSubview(p)
            self.picker = p
            for v in p.subviews {
                if let b = v as? UIButton { b.sendActions(for: .touchUpInside) }
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        call.unimplemented("iOS では画面上部の赤い表示（またはコントロールセンター）から停止してください")
    }

    /// 未取り込みの録画があれば、一時フォルダへコピーしてパスを返す
    @objc func getPending(_ call: CAPPluginCall) {
        let state = readState()
        let recording = state["recording"] as? Bool ?? false
        var ret: [String: Any] = ["recording": recording]
        if !recording, let path = state["path"] as? String, FileManager.default.fileExists(atPath: path) {
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent("largepic-rec.mp4")
            try? FileManager.default.removeItem(at: dest)
            do {
                try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: dest)
                ret["path"] = dest.path
            } catch {
                call.reject("録画ファイルをコピーできませんでした: \(error.localizedDescription)")
                return
            }
        }
        call.resolve(ret)
    }

    @objc func clearPending(_ call: CAPPluginCall) {
        if let dir = recordingsDir,
           let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            for f in files { try? FileManager.default.removeItem(at: f) }
        }
        call.resolve()
    }
}
