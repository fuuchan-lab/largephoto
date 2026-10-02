package com.fuuchanlab.largepic;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.projection.MediaProjectionManager;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

/**
 * 画面収録プラグイン（JS 側は www/js/native.js を参照）
 *   start()       … MediaProjection の許可を取り、フォアグラウンドサービスで録画開始
 *   stop()        … 録画を止めて { path } を返す
 *   getPending()  … { recording, path? } 未取り込みの録画があれば path を返す
 *   clearPending()
 *   イベント recordingStopped { path }
 */
@CapacitorPlugin(
    name = "ScreenRecorder",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class ScreenRecorderPlugin extends Plugin {

    static final String PREFS = "screen_recorder";
    static final String KEY_PENDING = "pending_path";
    private static ScreenRecorderPlugin instance;
    private PluginCall stopCall;

    @Override
    public void load() {
        instance = this;
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // サービスから：録画ファイルの書き出しが終わった
    static void onRecordingFinished(String path) {
        ScreenRecorderPlugin p = instance;
        if (p == null) return;
        JSObject ret = new JSObject();
        if (path != null) ret.put("path", path);
        if (p.stopCall != null) {
            if (path != null) p.stopCall.resolve(ret);
            else p.stopCall.reject("録画ファイルを作成できませんでした");
            p.stopCall = null;
        }
        p.notifyListeners("recordingStopped", ret, true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (ScreenRecordService.isRecording()) {
            call.reject("すでに録画中です");
            return;
        }
        // Android 13 以降は通知の許可がないと［停止］ボタンが見えないので先に確認
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsCallback");
            return;
        }
        requestProjection(call);
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        requestProjection(call); // 拒否されても録画自体はできる
    }

    private void requestProjection(PluginCall call) {
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        Intent intent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, intent, "projectionResult");
    }

    @ActivityCallback
    private void projectionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("画面収録が許可されませんでした");
            return;
        }
        Intent svc = new Intent(getContext(), ScreenRecordService.class);
        svc.setAction(ScreenRecordService.ACTION_START);
        svc.putExtra(ScreenRecordService.EXTRA_RESULT_CODE, result.getResultCode());
        svc.putExtra(ScreenRecordService.EXTRA_DATA, result.getData());
        ContextCompat.startForegroundService(getContext(), svc);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!ScreenRecordService.isRecording()) {
            String path = prefs(getContext()).getString(KEY_PENDING, null);
            if (path != null) {
                JSObject ret = new JSObject();
                ret.put("path", path);
                call.resolve(ret);
            } else {
                call.reject("録画していません");
            }
            return;
        }
        stopCall = call;
        ScreenRecordService.requestStop(getContext());
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("recording", ScreenRecordService.isRecording());
        String path = prefs(getContext()).getString(KEY_PENDING, null);
        if (path != null && new File(path).exists() && !ScreenRecordService.isRecording()) ret.put("path", path);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearPending(PluginCall call) {
        prefs(getContext()).edit().remove(KEY_PENDING).apply();
        call.resolve();
    }
}
