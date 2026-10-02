import UIKit
import Capacitor

/// アプリ内プラグイン（ScreenRecorder）を登録するためのビューコントローラ
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScreenRecorderPlugin())
    }
}
