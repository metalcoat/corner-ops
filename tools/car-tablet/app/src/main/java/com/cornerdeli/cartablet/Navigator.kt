package com.cornerdeli.cartablet

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt

/** Flat x/y metres around Ogdensburg (good to a few cm over a town). */
object Flat {
    private const val LAT0 = 44.6936
    private const val LNG0 = -75.482
    private val COS = cos(LAT0 * PI / 180)
    fun x(lng: Double) = (lng - LNG0) * 111_320.0 * COS
    fun y(lat: Double) = (lat - LAT0) * 111_320.0
}

data class Step(val x: Double, val y: Double, val maneuver: String, val instruction: String, val street: String)

/**
 * Follows the car along a route: which step is next, how far to it, whether the car has left the
 * route (then the screen asks the server for a new one), and what to say. Plain logic for unit tests.
 */
class Navigator(val xs: DoubleArray, val ys: DoubleArray, val steps: List<Step>) {
    /** Distance along the route at each point. */
    private val along = DoubleArray(xs.size).also { for (i in 1 until xs.size) it[i] = it[i - 1] + hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) }
    private val stepAlong = steps.map { step -> nearest(step.x, step.y, 0).second }
    val totalMetres get() = along.last()
    private var lastSegment = 0
    private var offRouteFixes = 0
    var spokenFor = -1 to ""   // step index, "far"/"near"
        private set

    data class Progress(val doneMetres: Double, val offRouteMetres: Double, val nextStep: Int, val toNextMetres: Double, val remainingMetres: Double)

    /** Closest point on the route at or after segment `from` (so a route that passes itself doesn't jump back). */
    private fun nearest(x: Double, y: Double, from: Int): Triple<Int, Double, Double> {
        var best = Triple(from, 0.0, Double.MAX_VALUE)
        for (i in from until xs.size - 1) {
            val dx = xs[i + 1] - xs[i]; val dy = ys[i + 1] - ys[i]
            val length2 = dx * dx + dy * dy
            val t = if (length2 == 0.0) 0.0 else (((x - xs[i]) * dx + (y - ys[i]) * dy) / length2).coerceIn(0.0, 1.0)
            val distance = hypot(x - xs[i] - t * dx, y - ys[i] - t * dy)
            if (distance < best.third) best = Triple(i, along[i] + t * hypot(dx, dy), distance)
        }
        return best
    }

    fun update(x: Double, y: Double): Progress {
        val (segment, done, off) = nearest(x, y, maxOf(0, lastSegment - 2))
        lastSegment = segment
        offRouteFixes = if (off > OFF_ROUTE_METRES) offRouteFixes + 1 else 0
        val next = stepAlong.indexOfFirst { it > done + 5 }.let { if (it < 0) steps.lastIndex else it }
        return Progress(done, off, next, (stepAlong[next] - done).coerceAtLeast(0.0), (totalMetres - done).coerceAtLeast(0.0))
    }

    /** Left the route for long enough (3 fixes in a row) that a new route is needed. */
    val offRoute get() = offRouteFixes >= 3

    fun arrived(progress: Progress) = progress.remainingMetres < ARRIVED_METRES

    /** What to say now, once per step: early ("In 800 feet, turn right onto Greene Street") and at the turn. */
    fun announcement(progress: Progress): String? {
        val step = steps.getOrNull(progress.nextStep) ?: return null
        val phase = when {
            step.maneuver == "arrive" && progress.toNextMetres < 60 -> "near"
            progress.toNextMetres < 45 -> "near"
            progress.toNextMetres < 300 -> "far"
            else -> return null
        }
        if (spokenFor.first == progress.nextStep && (spokenFor.second == phase || spokenFor.second == "near")) return null
        spokenFor = progress.nextStep to phase
        return if (phase == "near") step.instruction else "In ${distanceText(progress.toNextMetres)}, ${step.instruction.replaceFirstChar { it.lowercase() }}"
    }

    companion object {
        const val OFF_ROUTE_METRES = 40.0
        const val ARRIVED_METRES = 30.0

        /** US units: feet (rounded to 50) under ~0.18 mile, then miles. */
        fun distanceText(metres: Double): String {
            val feet = metres * 3.28084
            return if (feet < 950) "${maxOf(50, (feet / 50).roundToInt() * 50)} feet" else "%.1f miles".format(metres / 1609.34).replace("1.0 miles", "1 mile")
        }
    }
}
