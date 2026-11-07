package com.cornerdeli.cartablet

import android.content.Context

/**
 * Settings in device-protected storage, so the tracker can start before the tablet is unlocked
 * after a reboot (LOCKED_BOOT_COMPLETED).
 */
class Prefs(context: Context) {
    private val sp = context.createDeviceProtectedStorageContext().getSharedPreferences("car", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server", BuildConfig.DEFAULT_SERVER)!!
        set(value) = sp.edit().putString("server", value).apply()
    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit().putString("token", value).apply()
    var tabletName: String
        get() = sp.getString("name", "") ?: ""
        set(value) = sp.edit().putString("name", value).apply()
    var staffPinHash: String?
        get() = sp.getString("staffPin", null)
        set(value) = sp.edit().putString("staffPin", value).apply()
    var lastDeliveries: String?
        get() = sp.getString("deliveries", null)
        set(value) = sp.edit().putString("deliveries", value).apply()
    var batteryPrompted: Long
        get() = sp.getLong("batteryPrompted", 0)
        set(value) = sp.edit().putLong("batteryPrompted", value).apply()

    val paired get() = !token.isNullOrBlank()
}
