package com.cornerdeli.cartablet

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File

data class QueuedPoint(val id: String, val time: Long, val lat: Double, val lng: Double, val accuracy: Float?, val speed: Float?, val heading: Float?)
data class QueuedPhoto(
    val id: String, val path: String, val camera: String, val reason: String, val time: Long,
    val lat: Double?, val lng: Double?, val accuracy: Float?, val orderId: String?, val deliveryId: String?, val commandId: String?,
)

/** The offline queue: GPS points and photos waiting for signal. Device-protected like [Prefs]. */
class QueueDb(context: Context) : SQLiteOpenHelper(context.createDeviceProtectedStorageContext(), "queue.db", null, 1) {
    val photoDir: File = File(context.createDeviceProtectedStorageContext().filesDir, "photos").apply { mkdirs() }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE points(id TEXT PRIMARY KEY, time INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, speed REAL, heading REAL)")
        db.execSQL("CREATE TABLE photos(id TEXT PRIMARY KEY, path TEXT NOT NULL, camera TEXT NOT NULL, reason TEXT NOT NULL, time INTEGER NOT NULL, lat REAL, lng REAL, accuracy REAL, order_id TEXT, delivery_id TEXT, command_id TEXT)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    fun addPoint(point: QueuedPoint) {
        writableDatabase.insert("points", null, ContentValues().apply {
            put("id", point.id); put("time", point.time); put("lat", point.lat); put("lng", point.lng)
            put("accuracy", point.accuracy); put("speed", point.speed); put("heading", point.heading)
        })
        // A week offline at one point every 5 s is ~120k rows; past that, drop the oldest.
        writableDatabase.execSQL("DELETE FROM points WHERE id IN (SELECT id FROM points ORDER BY time DESC LIMIT -1 OFFSET 200000)")
    }

    fun oldestPoints(limit: Int): List<QueuedPoint> =
        readableDatabase.rawQuery("SELECT id,time,lat,lng,accuracy,speed,heading FROM points ORDER BY time LIMIT ?", arrayOf(limit.toString())).use { c ->
            buildList {
                while (c.moveToNext()) add(QueuedPoint(c.getString(0), c.getLong(1), c.getDouble(2), c.getDouble(3),
                    if (c.isNull(4)) null else c.getFloat(4), if (c.isNull(5)) null else c.getFloat(5), if (c.isNull(6)) null else c.getFloat(6)))
            }
        }

    fun deletePoints(ids: List<String>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            ids.forEach { db.delete("points", "id=?", arrayOf(it)) }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun pointCount(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM points", null).use { it.moveToFirst(); it.getInt(0) }

    fun addPhoto(photo: QueuedPhoto) {
        writableDatabase.insert("photos", null, ContentValues().apply {
            put("id", photo.id); put("path", photo.path); put("camera", photo.camera); put("reason", photo.reason); put("time", photo.time)
            put("lat", photo.lat); put("lng", photo.lng); put("accuracy", photo.accuracy)
            put("order_id", photo.orderId); put("delivery_id", photo.deliveryId); put("command_id", photo.commandId)
        })
    }

    fun photos(limit: Int = 20): List<QueuedPhoto> =
        readableDatabase.rawQuery("SELECT id,path,camera,reason,time,lat,lng,accuracy,order_id,delivery_id,command_id FROM photos ORDER BY time LIMIT ?", arrayOf(limit.toString())).use { c ->
            buildList {
                while (c.moveToNext()) add(QueuedPhoto(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getLong(4),
                    if (c.isNull(5)) null else c.getDouble(5), if (c.isNull(6)) null else c.getDouble(6), if (c.isNull(7)) null else c.getFloat(7),
                    c.getString(8), c.getString(9), c.getString(10)))
            }
        }

    fun photo(id: String): QueuedPhoto? = photos(500).firstOrNull { it.id == id }

    fun deletePhoto(photo: QueuedPhoto) {
        writableDatabase.delete("photos", "id=?", arrayOf(photo.id))
        File(photo.path).delete()
    }

    fun photoCount(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM photos", null).use { it.moveToFirst(); it.getInt(0) }
}
