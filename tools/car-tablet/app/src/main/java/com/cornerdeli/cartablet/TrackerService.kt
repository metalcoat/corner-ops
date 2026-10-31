package com.cornerdeli.cartablet

import android.Manifest
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.os.Build
import android.telephony.TelephonyManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Runs all the time: GPS into the offline queue, uploads in batches with retry, a heartbeat every
 * 30 s, and a long poll for "snap now" requests from the POS. Restarted by boot, the watchdog alarm
 * and the activity if anything kills it.
 */
class TrackerService : LifecycleService() {
    private val app get() = application as CarApp
    private val scheduler = Executors.newScheduledThreadPool(3)
    private lateinit var location: LocationSource
    private lateinit var camera: PhotoTaker
    private var lastKept: Rules.Fix? = null
    private val uploadLock = Any()
    private var uploadFailures = 0
    private var nextUploadAt = 0L
    @Volatile private var running = true
    private var commandThread: Thread? = null
    private var lastHeartbeatAt = 0L
    private var locationOn = false
    private val handledCommands = object : LinkedHashMap<String, Boolean>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?) = size > 100
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Car tracking", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        )
        if (!promote(false)) return
        camera = PhotoTaker(this, this)
        location = LocationSource(this, ::onFix)
        location.start()
        locationOn = true
        scheduler.scheduleWithFixedDelay({ safely { upload() } }, 3, 10, TimeUnit.SECONDS)
        scheduler.scheduleWithFixedDelay({ safely { heartbeat() } }, 1, 30, TimeUnit.SECONDS)
        scheduler.scheduleWithFixedDelay({ safely { checkForUpdate() } }, 20, 6 * 3600, TimeUnit.SECONDS)
        commandThread = Thread(::commandLoop, "car-commands").apply { isDaemon = true; start() }
        Watchdog.schedule(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.getBooleanExtra(EXTRA_CAMERA, false) == true) promote(true)
        // Play services isn't usable before the first unlock after boot; switch once it is.
        if (::location.isInitialized && locationOn && !location.usingFused && location.fusedAvailable()) location.start()
        scheduler.execute { safely { upload(force = true) } }
        return START_STICKY
    }

    /** Foreground with location, plus camera once the screen has been up (Android won't allow camera from boot). */
    private fun promote(withCamera: Boolean): Boolean {
        val granted = { permission: String -> ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED }
        var types = if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        if (withCamera && granted(Manifest.permission.CAMERA) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (types == 0) { stopSelf(); return false }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), types)
            if (withCamera) cameraReady = true
            true
        } catch (_: Exception) {
            if (withCamera) promote(false) else { stopSelf(); false }
        }
    }

    private fun notification(): Notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle("Corner Ops car tablet")
        .setContentText("Tracking the delivery car")
        .setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .build()

    private fun onFix(fix: Location) {
        val accuracy = if (fix.hasAccuracy()) fix.accuracy else null
        app.update { it.copy(gps = "ok", lastFixAt = System.currentTimeMillis(), lat = fix.latitude, lng = fix.longitude, accuracy = accuracy, speedMps = if (fix.hasSpeed()) fix.speed else null, bearing = if (fix.hasBearing()) fix.bearing else it.bearing) }
        val candidate = Rules.Fix(fix.time, fix.latitude, fix.longitude, accuracy)
        if (!Rules.keepFix(lastKept, candidate)) return
        lastKept = candidate
        app.queue.addPoint(QueuedPoint(UUID.randomUUID().toString(), fix.time, fix.latitude, fix.longitude, accuracy,
            if (fix.hasSpeed()) fix.speed else null, if (fix.hasBearing()) fix.bearing else null))
    }

    /** Sends queued points (oldest first) then photos. Backs off after failures unless forced. */
    fun upload(force: Boolean = false) {
        if (!app.prefs.paired) return
        synchronized(uploadLock) {
            if (!force && System.currentTimeMillis() < nextUploadAt) return
            try {
                for (round in 1..10) {
                    val batch = app.queue.oldestPoints(200)
                    if (batch.isEmpty()) break
                    try {
                        app.api.uploadPoints(batch)
                    } catch (error: ApiException) {
                        if (!error.permanent) throw error
                    }
                    app.queue.deletePoints(batch.map { it.id })
                    if (batch.size < 200) break
                }
                for (photo in app.queue.photos(20)) sendPhoto(photo)
                uploadFailures = 0
                nextUploadAt = 0
                contact(true)
            } catch (error: IOException) {
                uploadFailures++
                nextUploadAt = System.currentTimeMillis() + Rules.backoffMs(uploadFailures)
                contact(false, error.message ?: "Upload failed")
            }
        }
    }

    private fun sendPhoto(photo: QueuedPhoto) {
        if (!File(photo.path).exists()) { app.queue.deletePhoto(photo); return }
        try {
            app.api.uploadPhoto(photo)
        } catch (error: ApiException) {
            if (!error.permanent) throw error
        }
        app.queue.deletePhoto(photo)
    }

    /** For the Delivered button: send this photo right now. False if there's no signal. */
    fun uploadPhotoNow(id: String): Boolean = synchronized(uploadLock) {
        val photo = app.queue.photo(id) ?: return true
        try { sendPhoto(photo); contact(true); true } catch (error: IOException) { contact(false, error.message ?: ""); false }
    }

    private fun contact(ok: Boolean, error: String = "") {
        app.update { if (ok) it.copy(connected = true, lastContactAt = System.currentTimeMillis(), lastError = "") else it.copy(connected = false, lastError = error) }
    }

    private var fastGps = false

    /** A fix every second while the Drive screen is navigating; back to every 5 s after. */
    fun setFastGps(on: Boolean) {
        if (on == fastGps || !::location.isInitialized || !locationOn) return
        fastGps = on
        location.start(if (on) 1_000L else Rules.MOVING_INTERVAL_MS)
    }

    /** Quiet time (overnight, car parked at the deli): GPS off. Back on when the server says it's over. */
    private fun applyQuiet(reply: JSONObject) {
        if (!reply.has("quiet")) return
        val quiet = reply.optBoolean("quiet")
        val wakeAt = if (quiet) System.currentTimeMillis() + reply.optLong("wakeInMinutes") * 60_000 else 0L
        app.update { it.copy(quiet = quiet, wakeAt = wakeAt, gps = if (quiet) "off overnight" else it.gps) }
        if (!::location.isInitialized) return
        if (quiet && locationOn) { location.stop(); locationOn = false; Kiosk.screenOff(this) }
        if (!quiet && !locationOn) {
            location.start(); locationOn = true; lastKept = null
            // Morning: screen back on, on the app.
            Kiosk.nightOver(this)
            @Suppress("DEPRECATION")
            runCatching {
                getSystemService(PowerManager::class.java).newWakeLock(PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE, "cornerops:morning").acquire(10_000)
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }

    private fun heartbeat() {
        // Every 30 s while open; every 15 minutes overnight.
        if (app.status.quiet && System.currentTimeMillis() - lastHeartbeatAt < 15 * 60_000L) return
        lastHeartbeatAt = System.currentTimeMillis()
        val status = app.status
        if (status.lastFixAt > 0 && System.currentTimeMillis() - status.lastFixAt > 60_000 && status.gps == "ok") app.update { it.copy(gps = "no fix") }
        if (!app.prefs.paired) return
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) }
        val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val body = JSONObject()
            .put("battery", level ?: JSONObject.NULL)
            .put("charging", plugged)
            .put("network", networkType())
            .put("signal", signalLevel() ?: JSONObject.NULL)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("deviceOwner", Kiosk.isDeviceOwner(this))
            .put("kiosk", getSystemService(ActivityManager::class.java).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE)
            .put("gpsState", "${app.status.gps}${if (::location.isInitialized && location.usingFused) " (fused)" else " (gps)"}")
            .put("queuedPoints", app.queue.pointCount())
            .put("queuedPhotos", app.queue.photoCount())
        try {
            val reply = app.api.post("/api/car-tablet/heartbeat", body)
            val driver = reply.optJSONObject("driver")
            app.update { it.copy(driverName = driver?.optString("name"), driverAutomatic = driver?.optBoolean("automatic") ?: false, feedVersion = reply.optString("feedVersion").ifBlank { it.feedVersion }) }
            applyQuiet(reply)
            contact(true)
        } catch (error: IOException) {
            contact(false, error.message ?: "No connection")
        }
    }

    private fun networkType(): String {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return "offline"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            else -> "Other"
        }
    }

    private fun signalLevel(): Int? = try {
        getSystemService(TelephonyManager::class.java).signalStrength?.level
    } catch (_: Exception) {
        null
    }

    private fun checkForUpdate() {
        if (!app.prefs.paired) return
        try {
            val info = app.api.get("/api/car-tablet/app")
            if (info.optInt("versionCode") > BuildConfig.VERSION_CODE)
                app.update { it.copy(updateVersion = info.optString("versionName"), updateUrl = app.prefs.serverUrl.trimEnd('/') + info.optString("downloadPath")) }
        } catch (_: IOException) {
        }
    }

    private fun commandLoop() {
        var failures = 0
        while (running) {
            if (!app.prefs.paired) { sleep(5_000); continue }
            try {
                val reply = app.api.get("/api/car-tablet/commands?wait=25&feed=${java.net.URLEncoder.encode(app.status.feedVersion ?: "", "UTF-8")}")
                val commands = reply.optJSONArray("commands")
                failures = 0
                contact(true)
                reply.optString("feedVersion").takeIf { it.isNotBlank() }?.let { version -> app.update { it.copy(feedVersion = version) } }
                applyQuiet(reply)
                for (index in 0 until (commands?.length() ?: 0)) {
                    val command = commands!!.getJSONObject(index)
                    val id = command.getString("id")
                    synchronized(handledCommands) { if (handledCommands.put(id, true) != null) null else id } ?: continue
                    if (command.optString("kind") == "snap") scheduler.execute { safely { snap(id, command.optJSONObject("payload") ?: JSONObject()) } }
                }
                // Overnight: ask again every 5 minutes instead of straight away (a POS snap waits that long).
                if (app.status.quiet && (commands?.length() ?: 0) == 0) sleep(5 * 60_000L)
            } catch (error: IOException) {
                failures++
                contact(false, error.message ?: "No connection")
                sleep(Rules.backoffMs(failures))
            }
        }
    }

    private fun snap(commandId: String, payload: JSONObject) {
        val cameras = payload.optJSONArray("cameras") ?: return
        val orderId = payload.optString("orderId").takeIf { it.isNotBlank() && it != "null" }
        for (index in 0 until cameras.length()) {
            val which = cameras.getString(index)
            try {
                takePhoto(which, "remote_request", orderId = orderId, commandId = commandId)
                app.toast("The store took a ${which} photo")
            } catch (error: Exception) {
                runCatching { app.api.post("/api/car-tablet/commands/$commandId", JSONObject().put("status", "failed").put("error", "$which: ${error.message}")) }
            }
        }
        upload(force = true)
    }

    /** Takes a photo and queues it for upload. Blocking; background threads only. */
    fun takePhoto(which: String, reason: String, orderId: String? = null, deliveryId: String? = null, commandId: String? = null): QueuedPhoto {
        val id = UUID.randomUUID().toString()
        val file = File(app.queue.photoDir, "$id.jpg")
        camera.capture(which, file)
        val status = app.status
        val fresh = System.currentTimeMillis() - status.lastFixAt < 120_000
        val photo = QueuedPhoto(id, file.absolutePath, which, reason, System.currentTimeMillis(),
            if (fresh) status.lat else null, if (fresh) status.lng else null, if (fresh) status.accuracy else null, orderId, deliveryId, commandId)
        app.queue.addPhoto(photo)
        return photo
    }

    private fun sleep(ms: Long) { try { Thread.sleep(ms) } catch (_: InterruptedException) { } }

    private fun safely(block: () -> Unit) { try { block() } catch (error: Throwable) { app.update { it.copy(lastError = error.message ?: error.javaClass.simpleName) } } }

    override fun onTaskRemoved(rootIntent: Intent?) {
        Watchdog.schedule(this, 5_000)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running = false
        if (::location.isInitialized) location.stop()
        scheduler.shutdownNow()
        commandThread?.interrupt()
        instance = null
        cameraReady = false
        Watchdog.schedule(this, 10_000)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "tracking"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_CAMERA = "camera"
        @Volatile var instance: TrackerService? = null
            private set
        @Volatile var cameraReady = false
            private set

        /** Starts (or nudges) the service. withCamera only from the visible screen. */
        fun start(context: Context, withCamera: Boolean): Boolean {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return false
            return try {
                ContextCompat.startForegroundService(context, Intent(context, TrackerService::class.java).putExtra(EXTRA_CAMERA, withCamera))
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
