package com.aster.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Foreground keep-alive service (remoteMessaging) that holds a lightweight native SSE connection
 * to `/api/v1/events` while Aster is backgrounded or screen-locked, dispatching native Android
 * heads-up notifications for routines, watchers, reminders, and pending approvals.
 */
public class AsterKeepAliveService extends Service {

    private static final String TAG = "AsterKeepAliveService";

    public static final String ACTION_START = "com.aster.mobile.action.START_KEEPALIVE";
    public static final String ACTION_UPDATE = "com.aster.mobile.action.UPDATE_KEEPALIVE";
    public static final String ACTION_STOP = "com.aster.mobile.action.STOP_KEEPALIVE";

    public static final String EXTRA_BASE_URL = "baseUrl";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_MUTED = "muted";
    public static final String EXTRA_NOTIFY_ENABLED = "notifyEnabled";

    private static final String CHANNEL_KEEPALIVE = "aster_keepalive";
    private static final String CHANNEL_ALERTS = "aster_alerts";
    private static final String CHANNEL_ALERTS_SILENT = "aster_alerts_silent";

    private static final int KEEPALIVE_NOTIFICATION_ID = 101;
    private static final int MAX_DEDUP_KEYS = 128;

    private static volatile boolean appForeground = true;
    private static volatile boolean serviceRunning = false;

    private final AtomicBoolean active = new AtomicBoolean(false);
    private final AtomicInteger nextAlertId = new AtomicInteger(2000);
    private final LinkedHashSet<String> seenKeys = new LinkedHashSet<>();

    private volatile String baseUrl = "";
    private volatile String token = "";
    private volatile boolean muted = false;
    private volatile boolean notifyEnabled = true;
    private volatile HttpURLConnection currentConnection = null;
    private Thread workerThread = null;

    public static void setAppForeground(boolean foreground) {
        appForeground = foreground;
    }

    public static boolean isRunning() {
        return serviceRunning;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopWorker();
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent.hasExtra(EXTRA_MUTED)) {
            this.muted = intent.getBooleanExtra(EXTRA_MUTED, false);
        }
        if (intent.hasExtra(EXTRA_NOTIFY_ENABLED)) {
            this.notifyEnabled = intent.getBooleanExtra(EXTRA_NOTIFY_ENABLED, true);
        }

        if (ACTION_UPDATE.equals(action)) {
            if (!serviceRunning) {
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        String nextUrl = intent.getStringExtra(EXTRA_BASE_URL);
        String nextToken = intent.getStringExtra(EXTRA_TOKEN);
        if (nextUrl == null || nextUrl.trim().isEmpty() || nextToken == null || nextToken.trim().isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean connectionChanged = !nextUrl.equals(this.baseUrl) || !nextToken.equals(this.token);
        this.baseUrl = nextUrl.replaceAll("/+$", "");
        this.token = nextToken;

        if (!promoteToForeground()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        serviceRunning = true;
        if (connectionChanged || workerThread == null || !workerThread.isAlive()) {
            startWorker();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWorker();
        serviceRunning = false;
        super.onDestroy();
    }

    private boolean promoteToForeground() {
        try {
            Notification notification = buildKeepAliveNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    KEEPALIVE_NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                );
            } else {
                startForeground(KEEPALIVE_NOTIFICATION_ID, notification);
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Failed to start foreground keep-alive service", e);
            return false;
        }
    }

    private void stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception ignored) {
            // ignore
        }
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel keepAlive = new NotificationChannel(
            CHANNEL_KEEPALIVE,
            "Aster 后台保活",
            NotificationManager.IMPORTANCE_MIN
        );
        keepAlive.setDescription("保持后台连接以实时接收定时任务、监控和提醒通知");
        keepAlive.setShowBadge(false);
        keepAlive.setSound(null, null);
        keepAlive.enableVibration(false);
        manager.createNotificationChannel(keepAlive);

        if (manager.getNotificationChannel(CHANNEL_ALERTS) == null) {
            NotificationChannel alerts = new NotificationChannel(
                CHANNEL_ALERTS,
                "Aster 提醒",
                NotificationManager.IMPORTANCE_HIGH
            );
            alerts.setDescription("敏感操作审批、定时提醒与后台任务通知");
            alerts.enableVibration(true);
            manager.createNotificationChannel(alerts);
        }

        if (manager.getNotificationChannel(CHANNEL_ALERTS_SILENT) == null) {
            NotificationChannel silent = new NotificationChannel(
                CHANNEL_ALERTS_SILENT,
                "Aster 静音提醒",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            silent.setDescription("静音模式下的系统通知");
            silent.setSound(null, null);
            silent.enableVibration(false);
            manager.createNotificationChannel(silent);
        }
    }

    private Notification buildKeepAliveNotification() {
        PendingIntent openApp = buildLaunchIntent();
        return new NotificationCompat.Builder(this, CHANNEL_KEEPALIVE)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("Aster 后台运行中")
            .setContentText("实时监听定时任务、监控与提醒通知")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp)
            .build();
    }

    private PendingIntent buildLaunchIntent() {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, launch, flags);
    }

    private synchronized void startWorker() {
        stopWorker();
        active.set(true);
        workerThread = new Thread(this::runSseLoop, "aster-sse-keepalive");
        workerThread.setDaemon(true);
        workerThread.start();
    }

    private synchronized void stopWorker() {
        active.set(false);
        HttpURLConnection conn = currentConnection;
        currentConnection = null;
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // ignore
            }
        }
        if (workerThread != null) {
            workerThread.interrupt();
            workerThread = null;
        }
    }

    private void runSseLoop() {
        long backoffMs = 2_000L;
        while (active.get()) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(this.baseUrl + "/api/v1/events");
                conn = (HttpURLConnection) url.openConnection();
                currentConnection = conn;
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Authorization", "Bearer " + this.token);
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setRequestProperty("Cache-Control", "no-cache");
                conn.setConnectTimeout(15_000);
                // Server sends `: heartbeat` every 15s; 45s timeout detects stalled mobile NAT sockets.
                conn.setReadTimeout(45_000);
                conn.setDoInput(true);

                int status = conn.getResponseCode();
                if (status == 401 || status == 403) {
                    Log.w(TAG, "Auth rejected (" + status + "), stopping keep-alive service");
                    active.set(false);
                    stopForegroundCompat();
                    stopSelf();
                    return;
                }
                if (status < 200 || status >= 300) {
                    throw new IllegalStateException("Unexpected SSE HTTP status " + status);
                }

                backoffMs = 2_000L;
                SseEventParser parser = new SseEventParser();
                try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8)
                )) {
                    String line;
                    while (active.get() && (line = reader.readLine()) != null) {
                        parser.feedLine(line, this::handleServerEvent);
                    }
                    parser.flush(this::handleServerEvent);
                }
            } catch (Exception e) {
                if (!active.get()) return;
                Log.d(TAG, "SSE keep-alive disconnected, retrying in " + backoffMs + "ms");
            } finally {
                if (conn != null) {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {
                        // ignore
                    }
                }
                if (currentConnection == conn) {
                    currentConnection = null;
                }
            }

            if (!active.get()) return;
            try {
                Thread.sleep(backoffMs);
            } catch (InterruptedException ignored) {
                if (!active.get()) return;
            }
            backoffMs = Math.min(backoffMs * 2L, 30_000L);
        }
    }

    private void handleServerEvent(String eventType, String data) {
        // When Aster is already visible in the foreground, WebView displays the in-app banner & audio.
        if (appForeground || !notifyEnabled) return;
        SseEventParser.AlertPayload alert = SseEventParser.extractAlert(eventType, data);
        if (alert == null) return;
        if (!rememberDedupKey(alert.dedupKey)) return;
        postSystemNotification(alert.title, alert.body);
    }

    private synchronized boolean rememberDedupKey(String key) {
        if (seenKeys.contains(key)) return false;
        seenKeys.add(key);
        while (seenKeys.size() > MAX_DEDUP_KEYS) {
            Iterator<String> it = seenKeys.iterator();
            if (it.hasNext()) {
                it.next();
                it.remove();
            } else {
                break;
            }
        }
        return true;
    }

    private void postSystemNotification(String title, String body) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                return;
            }
        }

        String channelId = muted ? CHANNEL_ALERTS_SILENT : CHANNEL_ALERTS;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channelId)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(muted ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(buildLaunchIntent());

        if (muted) {
            builder.setSilent(true);
        }

        try {
            NotificationManagerCompat.from(this).notify(nextAlertId.incrementAndGet(), builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Missing POST_NOTIFICATIONS permission when dispatching alert", e);
        }
    }
}
