package com.cornerdeli.cartablet

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

/**
 * The only screen: pairing, driver sign-in, then the current delivery with big buttons.
 * Also the tablet's home screen and lock-task owner when provisioned as device owner.
 */
class MainActivity : Activity() {
    private val app get() = application as CarApp
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var title: TextView
    private lateinit var statusLine: TextView
    private lateinit var toastLine: TextView
    private lateinit var content: FrameLayout
    private var deliveries = JSONArray()
    private var route: JSONObject? = null
    private var feedDriver: JSONObject? = null
    private var selectedId: String? = null
    private var busy = false
    private var screen = ""
    private var staffUnlocked = false
    private var askedPermissions = false
    private var lastFeedAt = 0L
    private var lastFeedJson = ""
    private var pairServer: String? = null
    private var pairCode: String? = null

    private val tick = object : Runnable {
        override fun run() {
            renderStatus()
            if (app.prefs.paired && System.currentTimeMillis() - lastFeedAt > 10_000) refreshFeed()
            val wanted = when {
                !app.prefs.paired -> "pair"
                feedDriver == null && app.status.driverName == null -> "signin"
                else -> "main"
            }
            if (wanted != screen) show(wanted)
            main.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleLink(intent)
        app.prefs.lastDeliveries?.let { runCatching { deliveries = JSONObject(it).optJSONArray("deliveries") ?: JSONArray() } }
        buildFrame()
        Kiosk.apply(this)
        // Back (button or gesture) does nothing in the car.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {}
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
        if (screen == "pair") show("pair")
    }

    private fun handleLink(intent: Intent?) {
        val link = intent?.dataString ?: return
        Rules.parsePairLink(link)?.let { (server, code) -> pairServer = server; pairCode = code }
    }

    override fun onResume() {
        super.onResume()
        val asking = askForPermissions()
        TrackerService.start(this, withCamera = true)
        // Android's permission and battery dialogs can't open inside lock task, so lock only once they're done.
        val needsBatteryPrompt = !asking && askBatteryExemption()
        if (Kiosk.isDeviceOwner(this) && !staffUnlocked && !asking && !needsBatteryPrompt && !inLockTask()) runCatching { startLockTask() }
        main.post(tick)
    }

    override fun onPause() {
        main.removeCallbacks(tick)
        super.onPause()
    }

    @Deprecated("Back does nothing in the car")
    override fun onBackPressed() {}

    private fun inLockTask() = getSystemService(ActivityManager::class.java).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE

    /** Device owner grants these by policy; otherwise (or if Android refuses that) ask. True while asking. */
    private fun askForPermissions(): Boolean {
        if (askedPermissions) return false
        val wanted = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) wanted += Manifest.permission.POST_NOTIFICATIONS
        val missing = wanted.filterNot { Kiosk.hasPermission(this, it) }
        when {
            missing.isNotEmpty() -> requestPermissions(missing.toTypedArray(), 1)
            !Kiosk.hasPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 2)
            else -> return false
        }
        askedPermissions = true
        return true
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Background location is a second request (Android 11+ sends it to a settings page).
        askedPermissions = requestCode == 2
        TrackerService.start(this, withCamera = true)
    }

    /** Once a day until granted. Returns true when the prompt is up (lock task would block it). */
    private fun askBatteryExemption(): Boolean {
        if (getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)) return false
        if (System.currentTimeMillis() - app.prefs.batteryPrompted < 24 * 3600_000L) return false
        app.prefs.batteryPrompted = System.currentTimeMillis()
        return runCatching {
            @Suppress("BatteryLife")
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            true
        }.getOrDefault(false)
    }

    // ---------- layout helpers ----------

    private val dp get() = resources.displayMetrics.density
    private fun px(value: Int) = (value * dp).toInt()

    private fun text(value: String, size: Float = 22f, color: Int = Color.WHITE, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun button(label: String, color: Int, onClick: () -> Unit) = Button(this).apply {
        text = label
        textSize = 22f
        isAllCaps = true
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(Color.WHITE)
        setBackgroundColor(color)
        minHeight = px(84)
        setOnClickListener { if (!busy) onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(0, px(6), 0, px(6)) }
    }

    private fun input(hint: String, value: String = "", type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint
        setText(value)
        inputType = type
        textSize = 24f
        setTextColor(Color.BLACK)
        setHintTextColor(Color.GRAY)
        setBackgroundColor(Color.WHITE)
        setPadding(px(12), px(10), px(12), px(10))
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(0, px(6), 0, px(6)) }
    }

    private fun column(padding: Int = 16) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(padding), px(padding), px(padding), px(padding)) }

    private fun buildFrame() {
        val root = column(0).apply { setBackgroundColor(Color.rgb(17, 24, 39)) }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.rgb(31, 41, 55))
            setPadding(px(14), px(8), px(14), px(8))
        }
        title = text("CORNER DELI CAR", 20f, Color.rgb(134, 239, 172), true)
        // Staff exit: hold the title for 3 seconds.
        val hold = Runnable { staffMenu() }
        title.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> main.postDelayed(hold, 3_000)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> main.removeCallbacks(hold)
            }
            true
        }
        statusLine = text("", 17f, Color.rgb(229, 231, 235)).apply { setPadding(px(18), 0, 0, 0) }
        bar.addView(title)
        bar.addView(statusLine, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        toastLine = text("", 18f, Color.BLACK, true).apply { setBackgroundColor(Color.rgb(253, 224, 71)); setPadding(px(14), px(6), px(14), px(6)); visibility = View.GONE }
        content = FrameLayout(this)
        root.addView(bar)
        root.addView(toastLine)
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
    }

    private fun renderStatus() {
        val status = app.status
        val now = System.currentTimeMillis()
        val gps = when {
            status.lastFixAt == 0L -> "GPS: searching"
            now - status.lastFixAt > 60_000 -> "GPS: no fix ${(now - status.lastFixAt) / 60_000}m"
            else -> "GPS ±${status.accuracy?.toInt() ?: "?"} m${status.speedMps?.let { " · ${(it * 2.23694).toInt()} mph" } ?: ""}"
        }
        val net = if (status.connected) "● Online" else "○ Offline${status.lastContactAt.takeIf { it > 0 }?.let { " ${(now - it) / 60_000}m" } ?: ""}"
        val waiting = app.queue.pointCount() + app.queue.photoCount()
        val driver = feedDriver?.optString("name") ?: status.driverName
        statusLine.text = listOfNotNull(net, gps, if (waiting > 0) "$waiting waiting to upload" else "all uploaded",
            driver?.let { "Driver: $it${if (status.driverAutomatic) " (auto)" else ""}" },
            if (status.updateVersion != null) "update ${status.updateVersion} ready" else null,
            if (staffUnlocked) "KIOSK OFF" else null).joinToString("   ")
        statusLine.setTextColor(if (status.connected) Color.rgb(229, 231, 235) else Color.rgb(252, 165, 165))
        val showToast = now - status.toastAt < 8_000 && status.toast.isNotBlank()
        toastLine.visibility = if (showToast) View.VISIBLE else View.GONE
        if (showToast) toastLine.text = status.toast
    }

    private fun show(which: String) {
        screen = which
        content.removeAllViews()
        content.addView(when (which) {
            "pair" -> pairingView()
            "signin" -> signInView()
            else -> mainView()
        })
    }

    // ---------- pairing ----------

    private fun pairingView(): View {
        val box = column(32)
        box.addView(text("Pair this tablet", 30f, bold = true))
        box.addView(text("On the POS: Settings › Car tablet › Pair car tablet. Enter the code shown there (or scan its QR with the camera).", 20f, Color.LTGRAY))
        val server = input("Server", pairServer ?: app.prefs.serverUrl, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val code = input("Pairing code (ABCD-EFGH)", pairCode ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        val pin = input("Staff exit PIN (4–8 digits, to leave kiosk mode)", "", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        box.addView(server)
        box.addView(code)
        if (app.prefs.staffPinHash == null) box.addView(pin)
        val message = text("", 20f, Color.rgb(252, 165, 165))
        box.addView(button("Pair", Color.rgb(31, 107, 58)) {
            val staffPin = pin.text.toString()
            if (app.prefs.staffPinHash == null && !Rules.validStaffPin(staffPin)) { message.text = "Choose a staff exit PIN of 4 to 8 digits."; return@button }
            val serverUrl = Rules.normalizeServer(server.text.toString())
            background(message, "Pairing…") {
                val reply = app.api.pair(serverUrl, Rules.normalizeCode(code.text.toString()), "${Build.MANUFACTURER} ${Build.MODEL}")
                app.prefs.serverUrl = serverUrl
                app.prefs.token = reply.getString("token")
                app.prefs.tabletName = reply.optString("name")
                if (app.prefs.staffPinHash == null) app.prefs.staffPinHash = Rules.sha256(staffPin)
                app.update { it.copy(lastError = "") }
                TrackerService.start(this, withCamera = true)
                "Paired as ${reply.optString("name")}."
            }
        })
        box.addView(message)
        return ScrollView(this).apply { addView(box) }
    }

    // ---------- driver sign-in ----------

    private fun signInView(): View {
        val box = column(32)
        box.addView(text("Driver sign-in", 30f, bold = true))
        box.addView(text("Enter your POS PIN. (When only one driver is clocked in, the tablet uses them automatically.)", 20f, Color.LTGRAY))
        val pin = input("PIN", "", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        box.addView(pin)
        val message = text("", 20f, Color.rgb(252, 165, 165))
        box.addView(button("Sign in", Color.rgb(31, 107, 58)) {
            background(message, "Signing in…") {
                val reply = app.api.post("/api/car-tablet/driver", JSONObject().put("pin", pin.text.toString()))
                val driver = reply.optJSONObject("driver")
                app.update { it.copy(driverName = driver?.optString("name"), driverAutomatic = false) }
                lastFeedAt = 0
                "Hi ${driver?.optString("name")}"
            }
        })
        box.addView(message)
        box.addView(button("Cabin photo", Color.rgb(55, 65, 81)) { photo("cabin") })
        box.addView(button("Road photo", Color.rgb(55, 65, 81)) { photo("road") })
        return ScrollView(this).apply { addView(box) }
    }

    // ---------- deliveries ----------

    private fun refreshFeed() {
        lastFeedAt = System.currentTimeMillis()
        worker.execute {
            try {
                val reply = app.api.get("/api/car-tablet/deliveries")
                val json = reply.toString()
                app.prefs.lastDeliveries = json
                main.post {
                    if (json == lastFeedJson && screen == "main") return@post
                    lastFeedJson = json
                    feedDriver = reply.optJSONObject("driver")
                    deliveries = reply.optJSONArray("deliveries") ?: JSONArray()
                    route = reply.optJSONObject("route")
                    if (feedDriver == null) app.update { it.copy(driverName = null) }
                    if (screen == "main") show("main")
                }
            } catch (_: IOException) {
            }
        }
    }

    private fun list(): List<JSONObject> = (0 until deliveries.length()).map { deliveries.getJSONObject(it) }

    private fun mainView(): View {
        val all = list()
        val current = all.firstOrNull { it.optString("deliveryId") == selectedId } ?: all.firstOrNull()
        selectedId = current?.optString("deliveryId")
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val left = column(20)
        val right = column(20)
        if (current == null) {
            left.addView(text("No deliveries right now", 30f, bold = true))
            left.addView(text("New deliveries for you show up here by themselves.", 20f, Color.LTGRAY))
        } else {
            val mine = current.optBoolean("mine")
            left.addView(text("#${current.optString("displayNumber")} · ${current.optString("customerName")}", 32f, bold = true))
            left.addView(text(statusLabel(current.optString("status")) + (if (current.optBoolean("noContact")) " · NO-CONTACT" else ""), 20f, Color.rgb(253, 224, 71), true))
            left.addView(text(listOf(current.optString("address"), current.optString("unit")).filter { it.isNotBlank() }.joinToString(" · "), 26f))
            current.optString("phone").takeIf { it.isNotBlank() }?.let { left.addView(text("☎ $it", 22f, Color.rgb(147, 197, 253))) }
            current.optString("notes").takeIf { it.isNotBlank() }?.let { left.addView(text("Notes: $it", 22f, Color.rgb(253, 186, 116))) }
            current.optString("scheduledFor").takeIf { it.isNotBlank() && it != "null" }?.let { left.addView(text("For ${clock(it)}", 20f)) }
            val due = current.optLong("amountDueCents")
            left.addView(text(if (due > 0) "COLLECT ${Rules.money(due)}" else "Paid", 24f, if (due > 0) Color.rgb(252, 165, 165) else Color.rgb(134, 239, 172), true))
            val items = current.optJSONArray("items") ?: JSONArray()
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                val options = item.optJSONArray("options")?.let { array -> (0 until array.length()).joinToString(", ") { array.getString(it) } }.orEmpty()
                left.addView(text("${item.optInt("quantity")}× ${item.optString("name")}${if (options.isNotBlank()) " — $options" else ""}", 18f, Color.LTGRAY))
            }
            val status = current.optString("status")
            val id = current.optString("deliveryId")
            right.addView(button("Navigate", Color.rgb(37, 99, 235)) { navigate(current) })
            route?.optString("navigationUrl")?.takeIf { it.startsWith("https://") && (route?.optJSONArray("order")?.length() ?: 0) > 1 }?.let { url ->
                val minutes = route?.optInt("loopMinutes")?.takeIf { it > 0 }
                right.addView(button("Navigate whole route${minutes?.let { " · $it min" } ?: ""}", Color.rgb(30, 64, 175)) { openMaps(url) })
            }
            if (!mine) right.addView(button("Take this delivery", Color.rgb(124, 58, 237)) { action(id, "claim", "Taken") })
            if (mine && status in listOf("ASSIGNED", "READY_FOR_DRIVER", "PICKED_UP")) right.addView(button("Picked up · leaving", Color.rgb(217, 119, 6)) { action(id, "picked_up", "On the way") })
            if (mine && status == "EN_ROUTE") right.addView(button("Arrived", Color.rgb(8, 145, 178)) { action(id, "arrived", "Arrived") })
            if (mine && status in listOf("EN_ROUTE", "ARRIVED", "NO_CONTACT")) right.addView(button("Delivered", Color.rgb(22, 163, 74)) { delivered(current) })
            current.optString("phone").takeIf { it.isNotBlank() }?.let { phone -> right.addView(button("Call customer", Color.rgb(55, 65, 81)) { call(phone) }) }
        }
        right.addView(button("Cabin photo", Color.rgb(55, 65, 81)) { photo("cabin", current) })
        right.addView(button("Road photo", Color.rgb(55, 65, 81)) { photo("road", current) })
        val driverName = feedDriver?.optString("name") ?: app.status.driverName
        right.addView(button(if (app.status.driverAutomatic || feedDriver == null) "Driver sign-in" else "Sign out $driverName", Color.rgb(75, 85, 99)) {
            if (app.status.driverAutomatic) show("signin") else background(null, "Signing out…") {
                app.api.delete("/api/car-tablet/driver")
                main.post { feedDriver = null; deliveries = JSONArray(); lastFeedJson = "" }
                app.update { it.copy(driverName = null) }
                "Signed out"
            }
        })
        if (all.size > 1) {
            left.addView(text("All deliveries", 20f, Color.rgb(134, 239, 172), true).apply { setPadding(0, px(18), 0, 0) })
            all.forEach { delivery ->
                val label = "#${delivery.optString("displayNumber")} · ${statusLabel(delivery.optString("status"))} · ${delivery.optString("address").substringBefore(",")}${if (!delivery.optBoolean("mine")) " · UNCLAIMED" else ""}"
                left.addView(button(label, if (delivery.optString("deliveryId") == selectedId) Color.rgb(30, 64, 175) else Color.rgb(31, 41, 55)) {
                    selectedId = delivery.optString("deliveryId")
                    show("main")
                }.apply { textSize = 18f; minHeight = px(60); isAllCaps = false })
            }
        }
        row.addView(ScrollView(this).apply { addView(left) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 3f))
        row.addView(ScrollView(this).apply { addView(right) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 2f))
        return row
    }

    private fun statusLabel(status: String) = when (status) {
        "ASSIGNED" -> "Being made"
        "READY_FOR_DRIVER" -> "Ready for pickup"
        "PICKED_UP" -> "Picked up"
        "EN_ROUTE" -> "On the way"
        "ARRIVED" -> "Arrived"
        "NO_CONTACT" -> "No contact"
        "DELIVERY_FAILED" -> "Failed"
        else -> status
    }

    private fun clock(iso: String) = runCatching { DateTimeFormatter.ofPattern("h:mm a").withZone(ZoneId.of("America/New_York")).format(Instant.parse(iso)) }.getOrDefault(iso)

    /** Google Maps directions from the server: routed onto the preferred streets (Jay, Greene, Lafayette). */
    private fun openMaps(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage("com.google.android.apps.maps"))
        } catch (_: Exception) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }.onFailure { app.toast("Google Maps isn't installed") }
        }
    }

    private fun navigate(delivery: JSONObject) {
        delivery.optString("navigationUrl").takeIf { it.startsWith("https://") }?.let { openMaps(it); return }
        val lat = delivery.optDouble("latitude")
        val lng = delivery.optDouble("longitude")
        val target = if (!lat.isNaN() && !lng.isNaN()) "$lat,$lng" else Uri.encode(delivery.optString("address"))
        val maps = Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=$target")).setPackage("com.google.android.apps.maps")
        try {
            startActivity(maps)
        } catch (_: Exception) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=$target"))) }.onFailure { app.toast("Google Maps isn't installed") }
        }
    }

    private fun call(phone: String) {
        runCatching { startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }.onFailure { app.toast("This tablet can't make calls") }
    }

    private fun action(deliveryId: String, action: String, done: String) = background(null, "…") {
        app.api.post("/api/car-tablet/deliveries/$deliveryId", JSONObject().put("action", action))
        lastFeedAt = 0
        done
    }

    /** Delivered: a road photo first (it is the delivery's proof), then the status. */
    private fun delivered(delivery: JSONObject) {
        AlertDialog.Builder(this)
            .setTitle("Delivered #${delivery.optString("displayNumber")}?")
            .setMessage("A road photo is taken as proof.")
            .setPositiveButton("Delivered") { _, _ ->
                background(null, "Taking photo…") {
                    val service = TrackerService.instance
                    val photo = runCatching { service?.takePhoto("road", "delivery_complete", delivery.optString("orderId"), delivery.optString("deliveryId")) }.getOrNull()
                    val sent = photo != null && service?.uploadPhotoNow(photo.id) == true
                    if (delivery.optBoolean("noContact") && !sent) throw IOException("No-contact orders need the photo uploaded first. ${if (photo == null) "The camera didn't take it." else "No signal; try again in a moment."}")
                    app.api.post("/api/car-tablet/deliveries/${delivery.optString("deliveryId")}", JSONObject().put("action", "delivered"))
                    lastFeedAt = 0
                    "Delivered${if (photo != null && !sent) " (photo will upload when there's signal)" else ""}"
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun photo(camera: String, delivery: JSONObject? = null) = background(null, "Taking ${camera} photo…") {
        val service = TrackerService.instance ?: throw IOException("Tracker not running")
        service.takePhoto(camera, "manual", delivery?.optString("orderId")?.takeIf { it.isNotBlank() }, delivery?.optString("deliveryId")?.takeIf { it.isNotBlank() })
        Thread { service.upload(force = true) }.start()
        "${camera.replaceFirstChar { it.uppercase() }} photo saved"
    }

    /** Runs [work] off the main thread; its return value (or error) is shown to the driver. */
    private fun background(message: TextView?, progress: String, work: () -> String) {
        busy = true
        message?.text = progress
        app.toast(progress)
        worker.execute {
            val result = try { Result.success(work()) } catch (error: Exception) { Result.failure(error) }
            main.post {
                busy = false
                val text = result.getOrElse { it.message ?: "Something went wrong" }
                message?.text = text
                message?.setTextColor(if (result.isSuccess) Color.rgb(134, 239, 172) else Color.rgb(252, 165, 165))
                app.toast(text)
                refreshFeed()
            }
        }
    }

    // ---------- staff ----------

    private fun staffMenu() {
        val pin = input("Staff PIN", "", InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        AlertDialog.Builder(this).setTitle("Staff").setView(pin)
            .setPositiveButton("OK") { _, _ ->
                val expected = app.prefs.staffPinHash
                if (expected != null && Rules.sha256(pin.text.toString()) != expected) { app.toast("Wrong staff PIN"); return@setPositiveButton }
                staffOptions()
            }
            .setNegativeButton("Cancel", null).show()
    }

    private fun staffOptions() {
        val options = mutableListOf<Pair<String, () -> Unit>>()
        if (staffUnlocked) options += "Back to kiosk mode" to { staffUnlocked = false; if (Kiosk.isDeviceOwner(this)) runCatching { startLockTask() } }
        else options += "Leave kiosk mode (until 'Back to kiosk')" to { staffUnlocked = true; runCatching { stopLockTask() } }
        options += "Android settings" to { staffUnlocked = true; runCatching { stopLockTask() }; startActivity(Intent(Settings.ACTION_SETTINGS)) }
        app.status.updateUrl?.let { url -> options += "Install update ${app.status.updateVersion}" to { installUpdate(url) } }
        options += "Check for app update" to {
            background(null, "Checking…") {
                val info = app.api.get("/api/car-tablet/app")
                if (info.optInt("versionCode") > BuildConfig.VERSION_CODE) {
                    app.update { it.copy(updateVersion = info.optString("versionName"), updateUrl = app.prefs.serverUrl.trimEnd('/') + info.optString("downloadPath")) }
                    "Update ${info.optString("versionName")} is ready: hold the title again and choose Install update"
                } else "Up to date (${BuildConfig.VERSION_NAME})"
            }
        }
        options += "Unpair this tablet" to {
            confirm("Unpair? The tablet stops tracking until paired again.") { app.prefs.token = null; feedDriver = null; deliveries = JSONArray(); show("pair") }
        }
        if (Kiosk.isDeviceOwner(this)) options += "Remove device owner (hand the tablet back)" to {
            confirm("Remove the kiosk lock for good? You'd need a factory reset to make this tablet a kiosk again.") {
                staffUnlocked = true
                runCatching { stopLockTask() }
                Kiosk.removeDeviceOwner(this)
                app.toast("Device owner removed")
            }
        }
        options += "Version ${BuildConfig.VERSION_NAME} · ${app.prefs.tabletName} · ${app.prefs.serverUrl}" to {}
        AlertDialog.Builder(this).setTitle("Staff menu").setItems(options.map { it.first }.toTypedArray()) { _, index -> options[index].second() }.show()
    }

    private fun confirm(message: String, onYes: () -> Unit) {
        AlertDialog.Builder(this).setMessage(message).setPositiveButton("Yes") { _, _ -> onYes() }.setNegativeButton("No", null).show()
    }

    private fun installUpdate(url: String) = background(null, "Downloading update…") {
        val apk = File(cacheDir, "update.apk")
        app.api.download(url, apk)
        Kiosk.install(this, apk)
        "Installing update…"
    }
}
