package com.cornerdeli.cartablet

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** Plain logic (no Android classes) so it runs in JVM unit tests. */
object Rules {
    /** ~5 s while moving; a parked car still reports once a minute so the POS knows where it is. */
    const val MOVING_INTERVAL_MS = 5_000L
    const val PARKED_INTERVAL_MS = 60_000L
    const val MIN_MOVE_METRES = 8.0

    fun metresBetween(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val toRad = Math.PI / 180
        val dLat = (lat2 - lat1) * toRad
        val dLng = (lng2 - lng1) * toRad
        val a = sin(dLat / 2).pow(2) + cos(lat1 * toRad) * cos(lat2 * toRad) * sin(dLng / 2).pow(2)
        return 6_371_000 * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    data class Fix(val time: Long, val lat: Double, val lng: Double, val accuracy: Float?)

    /** Whether a new fix is worth queueing after the last one kept. */
    fun keepFix(last: Fix?, next: Fix): Boolean {
        if (next.accuracy != null && next.accuracy > 200f) return false
        if (last == null) return true
        val elapsed = next.time - last.time
        if (elapsed <= 0) return false
        if (elapsed >= PARKED_INTERVAL_MS) return true
        return elapsed >= MOVING_INTERVAL_MS - 500 && metresBetween(last.lat, last.lng, next.lat, next.lng) >= MIN_MOVE_METRES
    }

    /** Retry delay after [failures] failed uploads in a row: 5 s doubling to 2 minutes. */
    fun backoffMs(failures: Int): Long =
        if (failures <= 0) 0 else min(120_000L, 5_000L * (1L shl min(failures - 1, 10)))

    fun normalizeCode(value: String): String = value.uppercase().replace(Regex("[\\s-]"), "")

    fun normalizeServer(value: String): String {
        var server = value.trim().trimEnd('/')
        if (server.isNotEmpty() && !server.startsWith("http://") && !server.startsWith("https://")) server = "https://$server"
        return server
    }

    /** cornerops-car://pair?server=...&code=... from the POS pairing QR. */
    fun parsePairLink(link: String): Pair<String?, String?>? {
        val uri = try { URI(link) } catch (_: Exception) { return null }
        if (uri.scheme != "cornerops-car" || uri.host != "pair") return null
        val query = (uri.rawQuery ?: "").split('&').filter { it.contains('=') }.associate {
            val (key, value) = it.split('=', limit = 2)
            key to URLDecoder.decode(value, "UTF-8")
        }
        return query["server"] to query["code"]
    }

    fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

    fun validStaffPin(pin: String) = pin.length in 4..8 && pin.all { it.isDigit() }

    fun money(cents: Long): String = "$%d.%02d".format(cents / 100, cents % 100)
}
