package com.cornerdeli.cartablet

import android.app.Activity
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * The car's USB power is on the ignition (owner 2026-11-10): power on = car started. Then the screen
 * comes on, the app comes to the front and the lock screen goes away with no swipe; it stays on while
 * plugged in and times out and locks normally once unplugged. Not overnight (quiet time).
 *
 * Security: the app is never shown over a secure lock (no setShowWhenLocked). requestDismissKeyguard
 * removes a swipe-only lock or one Smart Lock / Extend Unlock is keeping open (trusted car Bluetooth);
 * with a PIN and nothing trusted it opens the PIN pad straight away instead.
 */
object CarPower {
    const val EXTRA_WAKE = "wake"
    private const val CHANNEL = "car-started"
    private const val NOTIFICATION_ID = 2

    fun plugged(context: Context): Boolean {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
    }

    /**
     * From the service: screen on and the app to the front. A device owner may start it directly; otherwise
     * Android blocks activity starts from the background, so a full-screen notification (the alarm-clock way)
     * opens it when the screen is off or locked, or shows "Car started" to tap when someone is using the tablet.
     */
    fun wakeApp(context: Context, reason: String) {
        @Suppress("DEPRECATION")
        runCatching {
            context.getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE, "cornerops:$reason")
                .acquire(10_000)
        }
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(EXTRA_WAKE, true)
        runCatching { context.startActivity(open) }
        if (Kiosk.isDeviceOwner(context) || MainActivity.inFront) return
        runCatching {
            val notifications = context.getSystemService(NotificationManager::class.java)
            notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Car started", NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null) })
            val pending = PendingIntent.getActivity(context, 1, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val notification = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Car started")
                .setContentText("Tap to open Corner Ops Car")
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setFullScreenIntent(pending, true)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setTimeoutAfter(60_000)
                .build()
            notifications.notify(NOTIFICATION_ID, notification)
        }
    }

    /** The app is up front: the "Car started" notification has done its job. */
    fun clearNotice(context: Context) {
        runCatching { context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID) }
    }

    /** Android 14+ can turn full-screen notifications off for an app (Settings › Apps › special access). */
    fun canOpenItself(context: Context): Boolean =
        Kiosk.isDeviceOwner(context) || Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE ||
            context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /**
     * Lock screen away with no swipe: dismissed when it isn't secure (or trusted), PIN pad straight away
     * when it is. Only works while this activity is the top one; retried once in case it was still starting.
     */
    fun dismissLockScreen(activity: Activity, retry: Boolean = true) {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (!keyguard.isKeyguardLocked || activity.isFinishing) return
        keyguard.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissError() {
                if (retry) Handler(Looper.getMainLooper()).postDelayed({ dismissLockScreen(activity, retry = false) }, 700)
            }
        })
    }
}
