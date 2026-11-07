package com.cornerdeli.cartablet

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.SystemClock

/** Boot (before and after unlock), app update, unlock: get the tracker going. */
class BootReceiver : BroadcastReceiver() {
    private val actions = setOf(Intent.ACTION_LOCKED_BOOT_COMPLETED, Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_USER_UNLOCKED)

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in actions) return
        TrackerService.start(context, withCamera = false)
        Watchdog.schedule(context)
    }
}

/** Every 10 minutes: restart the tracker if Android or anyone stopped it. */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (TrackerService.instance == null) TrackerService.start(context, withCamera = false)
        Watchdog.schedule(context)
    }
}

object Watchdog {
    fun schedule(context: Context, delayMs: Long = 10 * 60_000L) {
        val alarm = context.getSystemService(AlarmManager::class.java)
        val pending = PendingIntent.getBroadcast(context, 0, Intent(context, WatchdogReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        alarm.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delayMs, pending)
    }
}

/** Device owner admin (see README: dpm set-device-owner). */
class AdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) = Kiosk.apply(context)
}

/** Result of an app self-update. A device owner installs silently; otherwise Android asks. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> CarApp.instance.toast("App updated")
            else -> CarApp.instance.toast("Update failed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown"}")
        }
    }
}
