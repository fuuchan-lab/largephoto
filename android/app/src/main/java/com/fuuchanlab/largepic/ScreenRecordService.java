package com.fuuchanlab.largepic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;

import java.io.File;

/**
 * MediaProjection で画面を MP4 に録画するフォアグラウンドサービス。
 * 録画中は通知に［停止して取り込む］ボタンを出す（押すとアプリが前面に戻って取り込みが始まる）。
 */
public class ScreenRecordService extends Service {

    static final String ACTION_START = "com.fuuchanlab.largepic.START_RECORDING";
    static final String ACTION_STOP = "com.fuuchanlab.largepic.STOP_RECORDING";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_DATA = "data";
    private static final String CHANNEL = "recording";
    private static final int NOTIF_ID = 1001;
    private static final String TAG = "LargePicRecorder";

    private static volatile boolean recording = false;

    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaRecorder recorder;
    private File output;
    private final Handler handler = new Handler(Looper.getMainLooper());

    static boolean isRecording() {
        return recording;
    }

    static void requestStop(Context c) {
        if (!recording) return;
        Intent i = new Intent(c, ScreenRecordService.class);
        i.setAction(ACTION_STOP);
        c.startService(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) {
            startForegroundCompat();
            int code = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(EXTRA_DATA, Intent.class)
                : intent.getParcelableExtra(EXTRA_DATA);
            try {
                startRecording(code, data);
            } catch (Exception e) {
                Log.e(TAG, "start failed", e);
                cleanup(false);
                ScreenRecorderPlugin.onRecordingFinished(null);
                stopSelf();
            }
        } else if (ACTION_STOP.equals(action)) {
            stopRecording();
        }
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "画面収録", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent stop = new Intent(this, MainActivity.class).setAction(ACTION_STOP).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("LargePic 録画中")
            .setContentText("地図アプリでスクロールしてください。終わったら［停止して取り込む］")
            .setOngoing(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, piFlags))
            .addAction(0, "停止して取り込む", PendingIntent.getActivity(this, 1, stop, piFlags))
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void startRecording(int code, Intent data) throws Exception {
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projection = mpm.getMediaProjection(code, data);
        if (projection == null) throw new IllegalStateException("no projection");
        // Android 14 以降は createVirtualDisplay の前にコールバック登録が必須
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                handler.post(ScreenRecordService.this::stopRecording);
            }
        }, handler);

        DisplayMetrics m = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        wm.getDefaultDisplay().getRealMetrics(m);
        int w = m.widthPixels, h = m.heightPixels;
        // 多くの端末のエンコーダが扱えるサイズ（長辺 1920 / 短辺 1088 以内）に縮小し、16 の倍数に
        double s = Math.min(1.0, Math.min(1920.0 / Math.max(w, h), 1088.0 / Math.min(w, h)));
        int vw = Math.max(16, (int) Math.round(w * s / 16) * 16);
        int vh = Math.max(16, (int) Math.round(h * s / 16) * 16);

        File dir = new File(getFilesDir(), "recordings");
        if (!dir.exists()) dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        output = new File(dir, "rec-" + System.currentTimeMillis() + ".mp4");

        recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
        recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
        recorder.setVideoSize(vw, vh);
        recorder.setVideoFrameRate(30);
        recorder.setVideoEncodingBitRate(12_000_000);
        recorder.setOutputFile(output.getAbsolutePath());
        recorder.prepare();

        display = projection.createVirtualDisplay("LargePic", vw, vh, m.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, recorder.getSurface(), null, handler);
        recorder.start();
        recording = true;
        ScreenRecorderPlugin.prefs(this).edit().remove(ScreenRecorderPlugin.KEY_PENDING).apply();
    }

    private void stopRecording() {
        if (!recording) return;
        recording = false;
        boolean ok = cleanup(true);
        String path = ok && output != null && output.exists() && output.length() > 0 ? output.getAbsolutePath() : null;
        if (path != null) {
            ScreenRecorderPlugin.prefs(this).edit().putString(ScreenRecorderPlugin.KEY_PENDING, path).apply();
        }
        ScreenRecorderPlugin.onRecordingFinished(path);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private boolean cleanup(boolean finish) {
        boolean ok = true;
        if (recorder != null) {
            try {
                if (finish) recorder.stop();
            } catch (RuntimeException e) {
                Log.w(TAG, "recorder.stop failed (録画時間が短すぎる可能性)", e);
                ok = false;
            }
            recorder.release();
            recorder = null;
        }
        if (display != null) { display.release(); display = null; }
        if (projection != null) { projection.stop(); projection = null; }
        return ok;
    }

    @Override
    public void onDestroy() {
        if (recording) stopRecording();
        super.onDestroy();
    }
}
