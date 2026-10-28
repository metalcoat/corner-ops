package com.cornerdeli.cartablet

import android.Manifest
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import java.io.File

/**
 * Device-owner lockdown: this app is the home screen and runs in lock task mode, so nothing else
 * can be opened except Google Maps (navigation) and the phone dialer. Permissions are granted by
 * policy so no prompts appear, and the app can't be force-stopped or cleared from Settings.
 */
object Kiosk {
    private val ALLOWED_APPS = listOf(
        "com.google.android.apps.maps",
        "com.samsung.android.dialer", "com.google.android.dialer", "com.android.dialer",
        "com.samsung.android.incallui", "com.android.server.telecom",
    )

    fun admin(context: Context) = ComponentName(context, AdminReceiver::class.java)
    private fun dpm(context: Context) = context.getSystemService(DevicePolicyManager::class.java)
    fun isDeviceOwner(context: Context) = dpm(context).isDeviceOwnerApp(context.packageName)

    fun apply(context: Context) {
        if (!isDeviceOwner(context)) return
        val dpm = dpm(context)
        val admin = admin(context)
        runCatching { dpm.setLockTaskPackages(admin, (listOf(context.packageName) + ALLOWED_APPS).toTypedArray()) }
        runCatching {
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO or DevicePolicyManager.LOCK_TASK_FEATURE_HOME or
                DevicePolicyManager.LOCK_TASK_FEATURE_OVERVIEW or DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS)
        }
        runCatching {
            val home = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
            dpm.addPersistentPreferredActivity(admin, home, ComponentName(context, MainActivity::class.java))
        }
        runCatching { dpm.setKeyguardDisabled(admin, true) }
        runCatching {
            val plugged = BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB or BatteryManager.BATTERY_PLUGGED_WIRELESS
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, plugged.toString())
        }
        val permissions = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permissions += Manifest.permission.POST_NOTIFICATIONS
        permissions.forEach { runCatching { dpm.setPermissionGrantState(admin, context.packageName, it, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) } }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching { dpm.setUserControlDisabledPackages(admin, listOf(context.packageName)) }
            runCatching { dpm.setLocationEnabled(admin, true) }
        }
        runCatching { dpm.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT) }
        runCatching { dpm.addUserRestriction(admin, UserManager.DISALLOW_ADD_USER) }
    }

    /** Staff exit: hand the tablet back as a normal device until the app is opened again. */
    fun removeDeviceOwner(context: Context) {
        if (!isDeviceOwner(context)) return
        val dpm = dpm(context)
        val admin = admin(context)
        runCatching { dpm.clearPackagePersistentPreferredActivities(admin, context.packageName) }
        runCatching { dpm.setLockTaskPackages(admin, emptyArray()) }
        runCatching { dpm.setKeyguardDisabled(admin, false) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) runCatching { dpm.setUserControlDisabledPackages(admin, emptyList()) }
        runCatching { dpm.clearUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT) }
        runCatching { dpm.clearUserRestriction(admin, UserManager.DISALLOW_ADD_USER) }
        dpm.clearDeviceOwnerApp(context.packageName)
    }

    /** Installs a downloaded APK over this app (silently when device owner). */
    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(context.packageName) }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("app.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; session.fsync(out) }
            val callback = PendingIntent.getBroadcast(context, sessionId, Intent(context, InstallReceiver::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            session.commit(callback.intentSender)
        }
    }

    fun hasPermission(context: Context, permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}
