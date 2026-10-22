package com.cornerdeli.display;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps the Corner Deli page on screen "no matter what": whenever the display is pushed to the back
 * (Home, an HDMI input, Live TV, another app) or the TV wakes up, it brings the display back a few
 * seconds later. Needs "display over other apps" (granted once over adb:
 * appops set com.cornerdeli.display SYSTEM_ALERT_WINDOW allow). Switch off for maintenance with
 *   adb shell am start -n com.cornerdeli.display/.MainActivity --ez keep false
 */
public class KeeperService extends Service {
    static final String PREFS = "display";
    static final String KEY_KEEP = "keep";
    private static final long BACK_MS = 4_000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable bringBack = this::bringBack;

    private final BroadcastReceiver screenOn = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { schedule(); }
    };

    static boolean keeping(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_KEEP, true);
    }

    /** Called when the display leaves the screen: come back shortly if keeping is on. */
    static void displayLeft(Context context) {
        if (!keeping(context)) return;
        Intent intent = new Intent(context, KeeperService.class).setAction("left");
        context.startForegroundService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("keeper", "Corner Deli display", NotificationManager.IMPORTANCE_MIN));
        Notification notification = new Notification.Builder(this, "keeper").setContentTitle("Corner Deli display")
            .setSmallIcon(android.R.drawable.ic_menu_view).build();
        startForeground(1, notification);
        registerReceiver(screenOn, new IntentFilter(Intent.ACTION_SCREEN_ON));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "left".equals(intent.getAction())) schedule();
        return START_STICKY;
    }

    private void schedule() {
        handler.removeCallbacks(bringBack);
        handler.postDelayed(bringBack, BACK_MS);
    }

    private void bringBack() {
        if (!keeping(this) || MainActivity.visible) return;
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        startActivity(open);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        unregisterReceiver(screenOn);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
