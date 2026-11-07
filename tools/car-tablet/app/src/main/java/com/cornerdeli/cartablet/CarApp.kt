package com.cornerdeli.cartablet

import android.app.Application

/** Shared state for the activity and the tracker service (one process). */
class CarApp : Application() {
    lateinit var prefs: Prefs
    lateinit var queue: QueueDb
    lateinit var api: Api

    /** What the status bar shows; written by the service, read by the screen. */
    @Volatile var status = Status()

    data class Status(
        val gps: String = "starting",
        val lastFixAt: Long = 0,
        val lat: Double? = null,
        val lng: Double? = null,
        val accuracy: Float? = null,
        val speedMps: Float? = null,
        val bearing: Float? = null,
        val connected: Boolean = false,
        val lastContactAt: Long = 0,
        val lastError: String = "",
        val driverName: String? = null,
        val driverAutomatic: Boolean = false,
        val toast: String = "",
        val toastAt: Long = 0,
        val updateVersion: String? = null,
        val updateUrl: String? = null,
        /** Overnight quiet time from the server (store hours): no GPS, few check-ins. */
        val quiet: Boolean = false,
        val wakeAt: Long = 0,
        /** Changes when the delivery list does; the screen reloads the list only then. */
        val feedVersion: String? = null,
    )

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = Prefs(this)
        queue = QueueDb(this)
        api = Api(prefs) {
            // Unpaired from the POS: forget the token; the screen goes back to pairing.
            prefs.token = null
            update { it.copy(lastError = "Unpaired from the POS", driverName = null) }
        }
    }

    @Synchronized fun update(change: (Status) -> Status) { status = change(status) }

    fun toast(message: String) = update { it.copy(toast = message, toastAt = System.currentTimeMillis()) }

    companion object {
        lateinit var instance: CarApp
            private set
    }
}
