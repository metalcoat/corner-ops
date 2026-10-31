package com.cornerdeli.cartablet

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.display.DisplayManager
import android.view.Display
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import android.util.Size

/**
 * Takes a still with no preview and no one touching the screen (CameraX bound to the tracker
 * service). Cabin = front camera, road = rear camera through the windshield. Never records audio.
 */
class PhotoTaker(private val context: Context, private val owner: LifecycleOwner) {
    private val oneAtATime = Semaphore(1)

    /** Blocking; call from a background thread. Returns the JPEG or throws. */
    @SuppressLint("WrongConstant") // Display.rotation is always a Surface.ROTATION_* value.
    fun capture(camera: String, target: File): File {
        if (!oneAtATime.tryAcquire(30, TimeUnit.SECONDS)) throw IllegalStateException("Camera busy")
        try {
            val provider = ProcessCameraProvider.getInstance(context).get(10, TimeUnit.SECONDS)
            val selector = if (camera == "cabin") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
            val main = ContextCompat.getMainExecutor(context)
            val done = CountDownLatch(1)
            var error: Exception? = null
            main.execute {
                try {
                    if (!provider.hasCamera(selector)) throw IllegalStateException("This tablet has no ${if (camera == "cabin") "front" else "rear"} camera")
                    val rotation = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)?.rotation ?: 0
                    val capture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setJpegQuality(80)
                        .setTargetRotation(rotation)
                        .setResolutionSelector(ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                            .build())
                        .build()
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, selector, capture)
                    capture.takePicture(ImageCapture.OutputFileOptions.Builder(target).build(), main, object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                            provider.unbindAll()
                            done.countDown()
                        }
                        override fun onError(exception: ImageCaptureException) {
                            provider.unbindAll()
                            error = exception
                            done.countDown()
                        }
                    })
                } catch (exception: Exception) {
                    runCatching { provider.unbindAll() }
                    error = exception
                    done.countDown()
                }
            }
            if (!done.await(20, TimeUnit.SECONDS)) {
                main.execute { runCatching { provider.unbindAll() } }
                throw IllegalStateException("Camera timed out")
            }
            error?.let { throw it }
            if (!target.exists() || target.length() == 0L) throw IllegalStateException("Camera wrote no photo")
            return target
        } finally {
            oneAtATime.release()
        }
    }
}
