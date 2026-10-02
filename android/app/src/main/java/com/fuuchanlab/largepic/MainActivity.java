package com.fuuchanlab.largepic;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenRecorderPlugin.class);
        super.onCreate(savedInstanceState);
        handleStopIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleStopIntent(intent);
    }

    // 通知の［停止して取り込む］から起動されたら録画を止める
    private void handleStopIntent(Intent intent) {
        if (intent != null && ScreenRecordService.ACTION_STOP.equals(intent.getAction())) {
            ScreenRecordService.requestStop(this);
            intent.setAction(Intent.ACTION_MAIN);
        }
    }
}
