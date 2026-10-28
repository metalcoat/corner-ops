package com.cornerdeli.cartablet

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String, val code: String = "") : IOException(message) {
    /** Retrying won't help (bad request); the queue drops the item. 401/408/429 and 5xx are retried. */
    val permanent get() = status in 400..499 && status !in listOf(401, 408, 429)
}

/** The Corner Ops car tablet API (/api/car-tablet/...), bearer token from pairing. */
class Api(private val prefs: Prefs, private val onUnpaired: () -> Unit) {
    private val json = "application/json".toMediaType()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private fun url(path: String, server: String = prefs.serverUrl) = server.trimEnd('/') + path

    private fun builder(path: String, server: String = prefs.serverUrl) = Request.Builder().url(url(path, server))
        .header("User-Agent", "CornerOpsCarTablet/${BuildConfig.VERSION_NAME}")
        .also { request -> prefs.token?.let { request.header("Authorization", "Bearer $it") } }

    private fun execute(request: Request): JSONObject {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val body = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (!response.isSuccessful) {
                if (response.code == 401 && body.optString("code") == "unpaired") onUnpaired()
                throw ApiException(response.code, body.optString("error").ifBlank { "Server error ${response.code}" }, body.optString("code"))
            }
            return body
        }
    }

    fun get(path: String) = execute(builder(path).get().build())
    fun post(path: String, body: JSONObject = JSONObject()) = execute(builder(path).post(body.toString().toRequestBody(json)).build())
    fun delete(path: String) = execute(builder(path).delete().build())

    fun pair(server: String, code: String, model: String): JSONObject = execute(
        Request.Builder().url(url("/api/car-tablet/pair", server))
            .post(JSONObject().put("code", code).put("appVersion", BuildConfig.VERSION_NAME).put("model", model).toString().toRequestBody(json))
            .build(),
    )

    fun uploadPoints(points: List<QueuedPoint>): JSONObject {
        val array = JSONArray()
        points.forEach { point ->
            array.put(JSONObject().put("id", point.id).put("capturedAt", Instant.ofEpochMilli(point.time).toString())
                .put("latitude", point.lat).put("longitude", point.lng)
                .put("accuracy", point.accuracy ?: JSONObject.NULL).put("speed", point.speed ?: JSONObject.NULL).put("heading", point.heading ?: JSONObject.NULL))
        }
        return post("/api/car-tablet/locations", JSONObject().put("points", array))
    }

    fun uploadPhoto(photo: QueuedPhoto): JSONObject {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("photo", "${photo.id}.jpg", File(photo.path).asRequestBody("image/jpeg".toMediaType()))
            .addFormDataPart("clientPhotoId", photo.id)
            .addFormDataPart("camera", photo.camera)
            .addFormDataPart("reason", photo.reason)
            .addFormDataPart("capturedAt", Instant.ofEpochMilli(photo.time).toString())
        photo.lat?.let { form.addFormDataPart("latitude", it.toString()) }
        photo.lng?.let { form.addFormDataPart("longitude", it.toString()) }
        photo.accuracy?.let { form.addFormDataPart("accuracy", it.toString()) }
        photo.orderId?.let { form.addFormDataPart("orderId", it) }
        photo.deliveryId?.let { form.addFormDataPart("deliveryId", it) }
        photo.commandId?.let { form.addFormDataPart("commandId", it) }
        return execute(builder("/api/car-tablet/photos").post(form.build()).build())
    }

    fun download(url: String, target: File) {
        client.newCall(builder("").url(url).get().build()).execute().use { response ->
            if (!response.isSuccessful) throw ApiException(response.code, "Download failed (${response.code})")
            target.outputStream().use { out -> response.body!!.byteStream().copyTo(out) }
        }
    }
}
