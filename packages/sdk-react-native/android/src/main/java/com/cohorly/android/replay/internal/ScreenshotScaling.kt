// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/internal/ScreenshotScaling.kt
// and webpBase64 from posthog-android/src/main/java/com/posthog/android/internal/PostHogAndroidUtils.kt
// Changed: package; the data: prefix is part of the result; WEBP_LOSSY on API 30+.

package com.cohorly.android.replay.internal

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.ceil

internal const val MIN_SCREENSHOT_SCALE = 0.1f
internal const val MAX_SCREENSHOT_SCALE = 1f

internal fun resolveScreenshotScale(configured: Float?, density: Float): Float {
    val scale = configured ?: if (density.isFinite() && density > 0f) 1f / density else 1f
    return scale.coerceIn(MIN_SCREENSHOT_SCALE, MAX_SCREENSHOT_SCALE)
}

internal fun scaledScreenshotDimension(size: Int, scale: Float): Int {
    // The tolerance keeps Float error, such as 350 * (1 / 3.5f) = 100.0000076, from adding a pixel.
    return maxOf(1, ceil(size * scale - 0.001f).toInt())
}

/**
 * PixelCopy resamples with a single bilinear tap, which skips source pixels above 2:1.
 * Returns the PixelCopy destination size when a second filtered downscale is needed, else null.
 */
internal fun twoStageCopySize(
    sourceWidth: Int,
    sourceHeight: Int,
    targetWidth: Int,
    targetHeight: Int,
): Pair<Int, Int>? {
    if (sourceWidth <= 2 * targetWidth && sourceHeight <= 2 * targetHeight) {
        return null
    }
    return minOf(sourceWidth, 2 * targetWidth) to minOf(sourceHeight, 2 * targetHeight)
}

internal fun Bitmap.downscaleFiltered(targetWidth: Int, targetHeight: Int): Bitmap {
    val target = Bitmap.createBitmap(targetWidth, targetHeight, config ?: Bitmap.Config.ARGB_8888)
    try {
        Canvas(target).drawBitmap(
            this,
            Rect(0, 0, width, height),
            Rect(0, 0, targetWidth, targetHeight),
            Paint(Paint.FILTER_BITMAP_FLAG),
        )
        return target
    } catch (e: Throwable) {
        target.recycle()
        throw e
    }
}

internal fun Bitmap.downscaledWebpBase64(targetWidth: Int, targetHeight: Int, quality: Int): String? {
    val downscaled = downscaleFiltered(targetWidth, targetHeight)
    try {
        return downscaled.webpBase64(quality)
    } finally {
        downscaled.recycle()
    }
}

internal const val WEBP_PREFIX = "data:image/webp;base64,"

/** The bitmap as lossy WebP with the `data:` prefix, null when it cannot be encoded. */
@Suppress("DEPRECATION")
internal fun Bitmap.webpBase64(quality: Int): String? {
    if (isRecycled || width <= 0 || height <= 0) return null
    val format = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Bitmap.CompressFormat.WEBP_LOSSY
    } else {
        Bitmap.CompressFormat.WEBP
    }
    val bytes = ByteArrayOutputStream()
    if (!compress(format, quality.coerceIn(0, 100), bytes)) return null
    val encoded = bytes.toByteArray()
    if (encoded.isEmpty()) return null
    return WEBP_PREFIX + Base64.encodeToString(encoded, Base64.NO_WRAP)
}
