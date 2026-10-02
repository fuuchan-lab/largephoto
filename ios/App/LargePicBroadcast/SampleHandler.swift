import ReplayKit
import AVFoundation

/// Broadcast Upload Extension：画面の映像を MP4 にして App Group のコンテナへ保存する
/// （アプリ本体の ScreenRecorderPlugin が getPending() で受け取る）
class SampleHandler: RPBroadcastSampleHandler {
    private let appGroup = "group.com.fuuchanlab.largepic"
    private let queue = DispatchQueue(label: "com.fuuchanlab.largepic.writer")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var outputURL: URL?
    private var dir: URL?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            finishBroadcastWithError(NSError(domain: "LargePic", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "App Group が設定されていません"]))
            return
        }
        let d = base.appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        for f in (try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: f)
        }
        dir = d
        outputURL = d.appendingPathComponent("rec-\(Int(Date().timeIntervalSince1970)).mp4")
        writeState(recording: true, path: nil)
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        queue.sync { self.append(sampleBuffer) }
    }

    private func append(_ sb: CMSampleBuffer) {
        if writer == nil {
            guard let url = outputURL, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
            let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
            // 拡張機能はメモリ制限（約50MB）があるので、長辺 1920 以内に縮小して書き出す
            let s = min(1.0, 1920.0 / Double(max(w, h)))
            let ow = Int(Double(w) * s) / 2 * 2, oh = Int(Double(h) * s) / 2 * 2
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: ow,
                AVVideoHeightKey: oh,
                AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 10_000_000,
                    AVVideoMaxKeyFrameIntervalKey: 30,
                ],
            ]
            guard let wr = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return }
            let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            inp.expectsMediaDataInRealTime = true
            guard wr.canAdd(inp) else { return }
            wr.add(inp)
            wr.startWriting()
            wr.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb))
            writer = wr
            input = inp
        }
        if let inp = input, inp.isReadyForMoreMediaData, writer?.status == .writing {
            inp.append(sb)
        }
    }

    override func broadcastFinished() {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        queue.sync {
            guard let wr = writer, wr.status == .writing else { sem.signal(); return }
            input?.markAsFinished()
            wr.finishWriting {
                ok = wr.status == .completed
                sem.signal()
            }
        }
        _ = sem.wait(timeout: .now() + 10)
        writeState(recording: false, path: ok ? outputURL?.path : nil)
    }

    private func writeState(recording: Bool, path: String?) {
        guard let d = dir else { return }
        var obj: [String: Any] = ["recording": recording, "time": Date().timeIntervalSince1970]
        if let p = path { obj["path"] = p }
        if let data = try? JSONSerialization.data(withJSONObject: obj) {
            try? data.write(to: d.appendingPathComponent("state.json"), options: .atomic)
        }
    }
}
