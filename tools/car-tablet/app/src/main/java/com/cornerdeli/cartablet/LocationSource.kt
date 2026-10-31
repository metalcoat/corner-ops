package com.cornerdeli.cartablet

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/** Fused location when Google Play services is there (and unlocked), else the GPS + network providers. */
class LocationSource(private val context: Context, private val onFix: (Location) -> Unit) {
    var usingFused = false
        private set
    private var fusedCallback: LocationCallback? = null
    private var managerListener: LocationListener? = null

    fun fusedAvailable(): Boolean = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    } catch (_: Throwable) {
        false
    }

    /** Every 5 s normally; every second while the Drive screen is navigating. */
    @SuppressLint("MissingPermission")
    fun start(intervalMs: Long = Rules.MOVING_INTERVAL_MS) {
        stop()
        if (fusedAvailable()) {
            try {
                val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
                    .setMinUpdateIntervalMillis(minOf(intervalMs, 2_000))
                    .setWaitForAccurateLocation(false)
                    .build()
                val callback = object : LocationCallback() {
                    override fun onLocationResult(result: LocationResult) { result.locations.forEach(onFix) }
                }
                LocationServices.getFusedLocationProviderClient(context).requestLocationUpdates(request, callback, Looper.getMainLooper())
                fusedCallback = callback
                usingFused = true
                return
            } catch (_: Throwable) {
                fusedCallback = null
            }
        }
        val manager = context.getSystemService(LocationManager::class.java)
        val listener = LocationListener { onFix(it) }
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (manager.allProviders.contains(provider))
                    manager.requestLocationUpdates(provider, intervalMs, 0f, listener, Looper.getMainLooper())
            } catch (_: Throwable) {
            }
        }
        managerListener = listener
        usingFused = false
    }

    fun stop() {
        fusedCallback?.let { runCatching { LocationServices.getFusedLocationProviderClient(context).removeLocationUpdates(it) } }
        managerListener?.let { runCatching { context.getSystemService(LocationManager::class.java).removeUpdates(it) } }
        fusedCallback = null
        managerListener = null
    }
}
