package com.aster.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AsterKeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        AsterKeepAliveService.setAppForeground(true);
    }

    @Override
    public void onPause() {
        AsterKeepAliveService.setAppForeground(false);
        super.onPause();
    }
}
