package com.cornerdeli.cartablet

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** The town's streets for the Drive screen, downloaded once from /api/car-tablet/streets and kept on the tablet. */
class StreetMapData(val streets: List<Pair<Path, Boolean>>, val version: String) {
    companion object {
        private fun file(context: Context) = File(context.createDeviceProtectedStorageContext().filesDir, "streets.json")

        fun load(context: Context): StreetMapData? = runCatching { parse(JSONObject(file(context).readText())) }.getOrNull()

        /** Downloads the map when the tablet has none (or `force`). Blocking. */
        fun refresh(context: Context, api: Api, force: Boolean = false): StreetMapData? {
            if (!force) load(context)?.let { return it }
            val json = api.get("/api/car-tablet/streets")
            file(context).writeText(json.toString())
            return parse(json)
        }

        private fun parse(json: JSONObject): StreetMapData {
            val ways = json.getJSONArray("ways")
            val streets = ArrayList<Pair<Path, Boolean>>(ways.length())
            for (i in 0 until ways.length()) {
                val way = ways.getJSONArray(i)
                val points = way.getJSONArray(2)
                val path = Path()
                for (j in 0 until points.length()) {
                    val p = points.getJSONArray(j)
                    val x = Flat.x(p.getDouble(1)).toFloat(); val y = -Flat.y(p.getDouble(0)).toFloat()
                    if (j == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                streets += path to (way.getString(1) in listOf("primary", "secondary", "tertiary", "trunk"))
            }
            return StreetMapData(streets, json.optString("version"))
        }
    }
}

/**
 * Heading-up map: the car near the bottom pointing up, the town's streets, the route in blue and the
 * destination. Drawn from the downloaded street map, so it costs no data while driving.
 */
class DriveView(context: Context) : View(context) {
    var streets: StreetMapData? = null
    var route: Path? = null
    var car: Pair<Double, Double>? = null      // flat x, y
    var heading = 0f                           // degrees, 0 = north
    var destination: Pair<Double, Double>? = null
    private val metresAcross = 450f
    private val streetPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.rgb(75, 85, 99); strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val majorPaint = Paint(streetPaint).apply { color = Color.rgb(107, 114, 128) }
    private val routePaint = Paint(streetPaint).apply { color = Color.rgb(59, 130, 246) }
    private val carPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val destinationPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(239, 68, 68) }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.rgb(17, 24, 39))
        val (cx, cy) = car ?: return
        val scale = width / metresAcross
        canvas.save()
        canvas.translate(width / 2f, height * 0.7f)
        canvas.rotate(-heading)
        canvas.scale(scale, scale)
        canvas.translate(-cx.toFloat(), cy.toFloat())
        streetPaint.strokeWidth = 7f / scale; majorPaint.strokeWidth = 11f / scale; routePaint.strokeWidth = 16f / scale
        streets?.streets?.forEach { (path, major) -> canvas.drawPath(path, if (major) majorPaint else streetPaint) }
        route?.let { canvas.drawPath(it, routePaint) }
        destination?.let { (x, y) -> canvas.drawCircle(x.toFloat(), -y.toFloat(), 22f / scale, destinationPaint) }
        canvas.restore()
        // The car: an arrow pointing up (the map turns, not the car).
        val x = width / 2f; val y = height * 0.7f; val s = 26f
        val arrow = Path().apply { moveTo(x, y - s); lineTo(x + s * 0.7f, y + s * 0.8f); lineTo(x, y + s * 0.35f); lineTo(x - s * 0.7f, y + s * 0.8f); close() }
        canvas.drawPath(arrow, carPaint)
    }
}

/** Route from the server's JSON into what the screen needs. */
fun routeFromJson(route: JSONObject): Pair<Navigator, Path> {
    val path: JSONArray = route.getJSONArray("path")
    val xs = DoubleArray(path.length()); val ys = DoubleArray(path.length())
    val drawn = Path()
    for (i in 0 until path.length()) {
        val p = path.getJSONArray(i)
        xs[i] = Flat.x(p.getDouble(1)); ys[i] = Flat.y(p.getDouble(0))
        if (i == 0) drawn.moveTo(xs[i].toFloat(), -ys[i].toFloat()) else drawn.lineTo(xs[i].toFloat(), -ys[i].toFloat())
    }
    val stepsJson = route.getJSONArray("steps")
    val steps = (0 until stepsJson.length()).map { i ->
        val s = stepsJson.getJSONObject(i)
        Step(Flat.x(s.getDouble("longitude")), Flat.y(s.getDouble("latitude")), s.getString("maneuver"), s.getString("instruction"), s.optString("street"))
    }
    return Navigator(xs, ys, steps) to drawn
}
