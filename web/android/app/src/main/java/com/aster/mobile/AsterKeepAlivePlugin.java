package com.aster.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge exposing Android foreground keep-alive service control and battery optimization
 * whitelist shortcut to the Aster web UI.
 */
@CapacitorPlugin(name = "AsterKeepAlive")
public class AsterKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String token = call.getString("token", "");
        boolean muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
        boolean notifyEnabled = Boolean.TRUE.equals(call.getBoolean("notifyEnabled", true));

        if (baseUrl == null || baseUrl.trim().isEmpty() || token == null || token.trim().isEmpty()) {
            call.reject("baseUrl and token are required");
            return;
        }

        Context context = getContext();
        Intent intent = new Intent(context, AsterKeepAliveService.class);
        intent.setAction(AsterKeepAliveService.ACTION_START);
        intent.putExtra(AsterKeepAliveService.EXTRA_BASE_URL, baseUrl.trim());
        intent.putExtra(AsterKeepAliveService.EXTRA_TOKEN, token.trim());
        intent.putExtra(AsterKeepAliveService.EXTRA_MUTED, muted);
        intent.putExtra(AsterKeepAliveService.EXTRA_NOTIFY_ENABLED, notifyEnabled);

        try {
            ContextCompat.startForegroundService(context, intent);
            JSObject result = new JSObject();
            result.put("started", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to start keep-alive service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void updateConfig(PluginCall call) {
        if (!AsterKeepAliveService.isRunning()) {
            JSObject result = new JSObject();
            result.put("running", false);
            call.resolve(result);
            return;
        }
        Context context = getContext();
        Intent intent = new Intent(context, AsterKeepAliveService.class);
        intent.setAction(AsterKeepAliveService.ACTION_UPDATE);
        if (call.hasOption("muted")) {
            intent.putExtra(AsterKeepAliveService.EXTRA_MUTED, Boolean.TRUE.equals(call.getBoolean("muted", false)));
        }
        if (call.hasOption("notifyEnabled")) {
            intent.putExtra(
                AsterKeepAliveService.EXTRA_NOTIFY_ENABLED,
                Boolean.TRUE.equals(call.getBoolean("notifyEnabled", true))
            );
        }
        context.startService(intent);
        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, AsterKeepAliveService.class);
        intent.setAction(AsterKeepAliveService.ACTION_STOP);
        try {
            context.startService(intent);
        } catch (Exception ignored) {
            context.stopService(new Intent(context, AsterKeepAliveService.class));
        }
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", AsterKeepAliveService.isRunning());
        result.put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations());
        call.resolve(result);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || isIgnoringBatteryOptimizations()) {
            JSObject result = new JSObject();
            result.put("ignoringBatteryOptimizations", true);
            call.resolve(result);
            return;
        }

        Context context = getContext();
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
                JSObject result = new JSObject();
                result.put("opened", true);
                call.resolve(result);
            } catch (Exception fallbackError) {
                call.reject("Unable to open battery optimization settings");
            }
        }
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
}
