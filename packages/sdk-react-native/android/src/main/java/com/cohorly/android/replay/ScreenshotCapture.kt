// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt
// (toScreenshotWireframe, captureScreenshot, findMaskableWidgets, MaskRule, maskRule,
// addGlobalVisibleRect, getWindowVisibleRect, shouldMaskDrawable, setScaledScreenshotMask,
// paintScreenshotMasks) and the WindowDrawState check of
// posthog-android/src/main/java/com/posthog/android/replay/internal/ViewTreeSnapshotStatus.kt
// Changed: every window of the app composed into one image of the screen (bottom to top,
// each at its place) instead of one screenshot per window; Cohorly's mask rules (text inputs
// and passwords always, images only with maskAllImages, the no-capture tag always,
// WebView/SurfaceView/TextureView always covered, no unmask); masks are plain opaque
// rectangles; the draw check is the mask walk compared on every draw while a copy is in
// flight and once more after it, with a frame discarded when the window had a pending draw
// when the walk ran; a window with no Window (a PopupWindow) is drawn in software; any
// failure discards the whole frame; no RGB_565, no window alpha, no keyboard detection.

package com.cohorly.android.replay

import android.annotation.TargetApi
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Point
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.AnimatedVectorDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.DrawableContainer
import android.graphics.drawable.DrawableWrapper
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.VectorDrawable
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.text.method.PasswordTransformationMethod
import android.util.Log
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import com.cohorly.android.replay.internal.PixelCopyBitmapBuffer
import com.cohorly.android.replay.internal.resolveScreenshotScale
import com.cohorly.android.replay.internal.scaledScreenshotDimension
import com.cohorly.android.replay.internal.twoStageCopySize
import com.cohorly.android.replay.internal.webpBase64
import com.cohorly.android.replay.rr.RRWireframe
import java.util.WeakHashMap
import kotlin.math.ceil
import kotlin.math.floor

/**
 * What a screenshot must cover in a window, in the window's px: the same
 * rules as the wireframes ([WireframeBuilder]).
 * - every [EditText], editable [TextView] and password field;
 * - with `maskAllImages`, an [ImageView] showing an image (not a color,
 *   gradient or vector; a wrapper, layer or state list holding one is an
 *   image, an unknown drawable too), and the images of a composition
 *   ([ComposeMask]);
 * - a view tagged [CohorlyReplay.NO_CAPTURE_TAG] (any case), with its whole
 *   subtree, and a Compose node under `Modifier.cohorlyNoCapture()` with
 *   every interop view it overlaps ([interopCover]);
 * - every [WebView], [SurfaceView] and [TextureView] (the last two draw
 *   outside the view tree; they show as a rectangle).
 *
 * [collect] throws when the tree cannot be read: the caller then discards
 * the frame. Main thread only.
 */
internal class ScreenshotMasker(
    private val maskAllImages: Boolean,
    private val compose: ComposeDetector = ComposeDetector.Default,
    private var composeMasking: ComposeMasking? = null,
) {
    internal enum class MaskRule { COMPOSE, NO_CAPTURE, MASK_VIEW, CHILDREN, NONE }

    private class Walk {
        val rects = ArrayList<Rect>()
        val scratchRect = Rect()
        val scratchPoint = Point()
        val scratchLocation = IntArray(2)
    }

    fun collect(root: View): List<Rect> {
        val walk = Walk()
        visit(root, walk, insideNoCapture = false, hidden = emptyList())
        return walk.rects
    }

    internal fun maskRule(view: View, insideNoCapture: Boolean): MaskRule = when {
        insideNoCapture || view.isNoCapture() -> MaskRule.NO_CAPTURE
        compose.isComposeView(view) -> MaskRule.COMPOSE
        view is TextView && view.isSensitiveText() -> MaskRule.MASK_VIEW
        view is ImageView -> if (maskAllImages &&
            view.drawable?.isImage() == true
        ) {
            MaskRule.MASK_VIEW
        } else {
            MaskRule.NONE
        }
        view is WebView || view is SurfaceView || view is TextureView -> MaskRule.MASK_VIEW
        view is ViewGroup && view.childCount > 0 -> MaskRule.CHILDREN
        else -> MaskRule.NONE
    }

    /** [hidden]: the no-capture nodes (window px) of the composition [view] is inside, if any. */
    private fun visit(view: View, walk: Walk, insideNoCapture: Boolean, hidden: List<Rect>) {
        // A legacy Animation moves the pixels, not the bounds: no rectangle can be trusted.
        val animation = view.animation
        if (animation != null && animation.hasStarted() && !animation.hasEnded()) {
            throw IllegalStateException("a view is animating")
        }
        var walkChildren = false
        var childrenInsideNoCapture = insideNoCapture
        var childrenHidden = hidden
        val interop = if (insideNoCapture) null else interopCover(view, hidden)
        if (interop != null) {
            // An interop view under a no-capture node: covered with the node, its subtree too.
            walk.rects.add(interop)
            childrenInsideNoCapture = true
            walkChildren = true
        } else {
            when (maskRule(view, insideNoCapture)) {
                MaskRule.COMPOSE -> {
                    val masking = composeMasking ?: ComposeMask().also { composeMasking = it }
                    // Interop views (AndroidView) are children of the compose view.
                    childrenHidden = masking.collect(view, maskAllImages, walk.rects)
                    walkChildren = true
                }
                // Children of an unclipped container can draw outside its rect: they are covered too.
                MaskRule.NO_CAPTURE -> {
                    view.addWindowVisibleRect(walk)
                    walkChildren = true
                    childrenInsideNoCapture = true
                }
                MaskRule.MASK_VIEW -> view.addWindowVisibleRect(walk)
                MaskRule.CHILDREN -> walkChildren = true
                MaskRule.NONE -> Unit
            }
        }
        if (walkChildren && view is ViewGroup) {
            for (i in 0 until view.childCount) {
                val child = view.getChildAt(i) ?: continue
                if (!child.isDrawn()) continue
                visit(child, walk, childrenInsideNoCapture, childrenHidden)
            }
        }
    }

    /**
     * The visible part of the view in its window. getGlobalVisibleRect ignores
     * the window pan of `adjustPan` (soft keyboard), which the pixels include:
     * the root's location in the window carries it.
     */
    private fun View.addWindowVisibleRect(walk: Walk) {
        if (!getGlobalVisibleRect(walk.scratchRect, walk.scratchPoint)) return
        rootView.getLocationInWindow(walk.scratchLocation)
        walk.scratchRect.offset(walk.scratchLocation[0], walk.scratchLocation[1])
        walk.rects.add(Rect(walk.scratchRect))
    }

    private fun View.isDrawn(): Boolean {
        if (visibility != View.VISIBLE || alpha <= 0f || width <= 0 || height <= 0) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && transitionAlpha <= 0f) return false
        return true
    }

    private fun View.isNoCapture(): Boolean =
        (tag as? String)?.contains(CohorlyReplay.NO_CAPTURE_TAG, ignoreCase = true) == true

    private fun TextView.isSensitiveText(): Boolean = this is EditText ||
        keyListener != null ||
        onCheckIsTextEditor() ||
        WireframeBuilder.isPasswordInputType(inputType) ||
        transformationMethod is PasswordTransformationMethod

    /**
     * A picture, not a color, gradient or vector (icons). A wrapper, layer
     * or state list is one when any drawable inside is; a drawable of
     * unknown type is one (fail closed).
     */
    private fun Drawable.isImage(depth: Int = 0): Boolean {
        if (depth > MAX_DRAWABLE_DEPTH) return true
        return when (this) {
            is ColorDrawable, is GradientDrawable, is VectorDrawable, is AnimatedVectorDrawable -> false
            is BitmapDrawable -> bitmap?.isRecycled == false
            is LayerDrawable -> (0 until numberOfLayers).any { getDrawable(it)?.isImage(depth + 1) == true }
            is DrawableContainer -> {
                val children = (constantState as? DrawableContainer.DrawableContainerState)?.children
                val inner = children?.filterNotNull() ?: listOfNotNull(current)
                inner.any { it !== this && it.isImage(depth + 1) }
            }
            is InsetDrawable -> drawable?.isImage(depth + 1) == true
            is DrawableWrapper -> drawable?.isImage(depth + 1) == true
            else -> true
        }
    }

    private companion object {
        /** Drawables nested deeper than this are taken for images. */
        const val MAX_DRAWABLE_DEPTH = 8
    }
}

/**
 * The mask walk a window's copy is checked against. While a copy is in
 * flight, every draw of the window walks the masks again: a draw whose masks
 * differ (something sensitive moved, appeared or went) makes the frame
 * unkeepable, since the copy may hold that draw's pixels. Main thread only.
 */
internal class WindowDrawState {
    var baseline: List<Rect>? = null
        private set
    var invalid = false
        private set

    fun begin(rects: List<Rect>) {
        baseline = rects
        invalid = false
    }

    fun invalidate() {
        invalid = true
    }

    fun end() {
        baseline = null
    }
}

/** Copies a window's pixels. */
internal fun interface WindowPixelSource {
    /**
     * Main thread. Copies the window [root] is the root view of into [dest],
     * scaled to its size; [done] is called once, on the main thread, true
     * when [dest] holds the window.
     */
    fun copy(root: View, dest: Bitmap, done: (Boolean) -> Unit)
}

/** The window's pixels: `PixelCopy` for a window, a software draw for a root view with none (a PopupWindow). */
@TargetApi(Build.VERSION_CODES.O)
internal class PixelCopySource(private val mainHandler: Handler) : WindowPixelSource {
    private var thread: HandlerThread? = null
    private var handler: Handler? = null

    override fun copy(root: View, dest: Bitmap, done: (Boolean) -> Unit) {
        val window = root.phoneWindowOrNull()
        if (window == null) {
            done(drawWindow(root, dest))
            return
        }
        val callbacks = handler ?: run {
            val started = HandlerThread(PIXEL_COPY_THREAD).apply { start() }
            thread = started
            Handler(started.looper).also { handler = it }
        }
        PixelCopy.request(
            window,
            dest,
            { result -> mainHandler.post { done(result == PixelCopy.SUCCESS) } },
            callbacks,
        )
    }

    fun close() {
        thread?.quitSafely()
        thread = null
        handler = null
    }

    companion object {
        const val PIXEL_COPY_THREAD = "cohorly-replay-pixelcopy"
    }
}

/** Draws [root]'s tree into [dest], scaled to its size; false when it cannot be drawn. */
internal fun drawWindow(root: View, dest: Bitmap): Boolean = try {
    val canvas = Canvas(dest)
    dest.eraseColor(Color.TRANSPARENT)
    canvas.scale(dest.width / root.width.toFloat(), dest.height / root.height.toFloat())
    root.draw(canvas)
    true
} catch (e: Throwable) {
    if (e is VirtualMachineError) throw e
    false
}

/**
 * Screenshot mode (VEL-2141): one masked image of the whole screen per
 * capture. Main thread for [capture], the recorder thread for the rest.
 *
 * 1. Main thread: per visible window, bottom to top, the mask walk
 *    ([ScreenshotMasker]), its baseline armed in a [WindowDrawState], and a
 *    copy of its pixels requested ([WindowPixelSource]) into a bitmap of
 *    [PixelCopyBitmapBuffer] at most twice the target size. A `FLAG_SECURE`
 *    window is never copied: it is one mask the size of the window. Below
 *    API 28 a dialog's copy holds its surface insets too, so a dialog with
 *    anything to mask is one mask as well.
 * 2. Main thread, once every copy answered: the frame is discarded when a
 *    copy failed or timed out, a window changed size, a draw while the copy
 *    ran moved its masks, or the walk now differs from the baseline; a window
 *    that turned secure is covered whole.
 * 3. Recorder thread: masks painted on each copy, opaque, then every window
 *    drawn at its place into one image at [resolveScreenshotScale] (one image
 *    px per dp), handed to the caller; [encode] turns it into WebP.
 *
 * Any failure discards the whole frame: an image goes out masked or not at all.
 */
internal class ScreenshotCapturer(
    maskAllImages: Boolean,
    private val quality: Int,
    private val source: WindowPixelSource,
    private val worker: ReplayWorker,
    private val mainHandler: Handler,
    private val masker: ScreenshotMasker = ScreenshotMasker(maskAllImages),
    /** A window whose tree changed since its last draw: its pixels are older than its masks. */
    private val hasPendingDraw: (View) -> Boolean = { it.isDirty || it.isLayoutRequested },
    private val scaleFor: (Float) -> Float = { resolveScreenshotScale(null, it) },
    private val sdkInt: Int = Build.VERSION.SDK_INT,
    private val copyTimeoutMs: Long = COPY_TIMEOUT_MS,
) {
    private val buffer = PixelCopyBitmapBuffer()
    private val drawStates = WeakHashMap<View, WindowDrawState>()
    private var generation = 0
    private var inFlight = false

    /** The id of the screenshot wireframe, fixed for one recording run. */
    @Volatile
    var wireframeId: Int = RRWireframe.FIRST_ID
        private set

    private class Layer(val root: View, val x: Int, val y: Int, val width: Int, val height: Int) {
        var masks: List<Rect> = emptyList()
        var cover = false
        var lease: PixelCopyBitmapBuffer.Lease? = null
        var answered = false
        var copied = false
    }

    /** Main thread: a recording run starts. */
    fun start(id: Int) {
        wireframeId = id
        buffer.open()
    }

    /** Main thread: the run ends; copies still in flight are dropped when they answer. */
    fun stop() {
        generation++
        inFlight = false
        drawStates.clear()
        buffer.close()
        (source as? PixelCopySource)?.close()
    }

    /** Main thread, from the window's draw listener. */
    fun onDraw(root: View) {
        val state = drawStates[root] ?: return
        val baseline = state.baseline ?: return
        if (state.invalid) return
        try {
            if (masker.collect(root) != baseline) state.invalidate()
        } catch (_: Exception) {
            state.invalidate()
        }
    }

    /**
     * Main thread. Starts a capture of [roots] (bottom to top) on a screen of
     * [screenWidthPx] x [screenHeightPx]; [done] runs on the recorder thread
     * with the masked image (the caller recycles it) or null when the frame
     * was discarded. False, and [done] never called, while another capture
     * is in flight: from here until [done] returned for a kept frame (the
     * main thread learns it on its next loop), until the frame is discarded
     * otherwise. A copy that timed out keeps its bitmap out of the pool until
     * it answers.
     */
    fun capture(
        roots: List<View>,
        screenWidthPx: Int,
        screenHeightPx: Int,
        density: Float,
        originXPx: Int = 0,
        originYPx: Int = 0,
        done: (Bitmap?) -> Unit,
    ): Boolean {
        if (inFlight) return false
        val scale = scaleFor(density)
        val layers = ArrayList<Layer>()
        try {
            for (root in roots) {
                if (root.windowVisibility != View.VISIBLE || !root.isShown || root.width <= 0 || root.height <= 0) {
                    continue
                }
                val location = IntArray(2)
                root.getLocationOnScreen(location)
                val layer = Layer(root, location[0] - originXPx, location[1] - originYPx, root.width, root.height)
                layers.add(layer)
                if (root.isSecureWindow()) {
                    layer.cover = true
                    continue
                }
                if (hasPendingDraw(root)) {
                    Log.d(ReplayRecorder.TAG, "Cohorly session replay skipped a screenshot: a window had not drawn yet")
                    return discard(layers, done)
                }
                layer.masks = masker.collect(root)
                if (sdkInt < Build.VERSION_CODES.P && root.isDialogWindow() && layer.masks.isNotEmpty()) {
                    layer.cover = true
                }
            }
            if (layers.isEmpty()) return discard(layers, done)
            for (layer in layers) {
                if (layer.cover) continue
                val targetWidth = scaledScreenshotDimension(layer.width, scale)
                val targetHeight = scaledScreenshotDimension(layer.height, scale)
                val (copyWidth, copyHeight) = twoStageCopySize(layer.width, layer.height, targetWidth, targetHeight)
                    ?: (targetWidth to targetHeight)
                layer.lease = buffer.acquire(copyWidth, copyHeight, Bitmap.Config.ARGB_8888)
                    ?: return discard(layers, done)
            }
        } catch (e: Exception) {
            Log.w(ReplayRecorder.TAG, "Cohorly session replay could not mask a screenshot: $e")
            return discard(layers, done)
        }

        inFlight = true
        val run = generation
        val copies = layers.filter { it.lease != null }
        var waiting = copies.size
        var finished = false
        val finish = {
            if (!finished && run == generation) {
                finished = true
                mainHandler.removeCallbacksAndMessages(timeoutToken)
                complete(layers, screenWidthPx, screenHeightPx, scale, done)
            }
        }
        if (copies.isEmpty()) {
            finish()
            return true
        }
        mainHandler.postAtTime({ finish() }, timeoutToken, android.os.SystemClock.uptimeMillis() + copyTimeoutMs)
        for (layer in copies) {
            drawStates.getOrPut(layer.root) { WindowDrawState() }.begin(layer.masks)
            val answer = { copied: Boolean ->
                if (!layer.answered) {
                    layer.answered = true
                    layer.copied = copied
                    if (finished || run != generation) {
                        // Answered after the frame was given up: the bitmap is free only now.
                        layer.lease?.release()
                    } else if (--waiting == 0) {
                        finish()
                    }
                }
            }
            try {
                source.copy(layer.root, layer.lease!!.bitmap, answer)
            } catch (e: Exception) {
                Log.w(ReplayRecorder.TAG, "Cohorly session replay could not copy a window: $e")
                answer(false)
            }
        }
        return true
    }

    /** Main thread: checks the frame once every copy answered (or the time ran out). */
    private fun complete(
        layers: List<Layer>,
        screenWidthPx: Int,
        screenHeightPx: Int,
        scale: Float,
        done: (Bitmap?) -> Unit,
    ) {
        var keep = true
        for (layer in layers) {
            val state = drawStates[layer.root]
            val drawInvalidated = state?.invalid == true
            state?.end()
            if (layer.lease == null) continue
            if (!layer.answered || !layer.copied || drawInvalidated) keep = false
            val root = layer.root
            if (root.width != layer.width || root.height != layer.height) keep = false
            if (!keep) continue
            try {
                if (root.isSecureWindow()) {
                    layer.cover = true
                } else if (masker.collect(root) != layer.masks) {
                    keep = false
                }
            } catch (_: Exception) {
                keep = false
            }
        }
        if (!keep) {
            Log.d(
                ReplayRecorder.TAG,
                "Cohorly session replay discarded a screenshot: the screen changed or a copy failed",
            )
            discard(layers, done, copiesRequested = true)
            return
        }
        // Still in flight until the image is composed, masked and handed over (encoded):
        // a capture asked for meanwhile is refused, never run beside this one.
        val run = generation
        worker.execute {
            try {
                val image = try {
                    composite(layers, screenWidthPx, screenHeightPx, scale)
                } catch (e: Throwable) {
                    if (e is VirtualMachineError) throw e
                    Log.w(ReplayRecorder.TAG, "Cohorly session replay could not compose a screenshot: $e")
                    null
                } finally {
                    for (layer in layers) layer.lease?.release()
                }
                done(image)
            } finally {
                mainHandler.post { if (run == generation) inFlight = false }
            }
        }
    }

    /**
     * Reports nothing for this frame. A bitmap whose copy was requested is
     * released only once the copy answered (else when it does). Always true:
     * the capture ran.
     */
    private fun discard(layers: List<Layer>, done: (Bitmap?) -> Unit, copiesRequested: Boolean = false): Boolean {
        for (layer in layers) {
            drawStates[layer.root]?.end()
            if (!copiesRequested || layer.answered) layer.lease?.release()
        }
        inFlight = false
        worker.execute { done(null) }
        return true
    }

    /** Recorder thread: every window at its place, masks painted on its pixels first. */
    private fun composite(layers: List<Layer>, screenWidthPx: Int, screenHeightPx: Int, scale: Float): Bitmap {
        val out = Bitmap.createBitmap(
            scaledScreenshotDimension(screenWidthPx, scale),
            scaledScreenshotDimension(screenHeightPx, scale),
            Bitmap.Config.ARGB_8888,
        )
        try {
            val canvas = Canvas(out)
            canvas.drawColor(Color.BLACK)
            val target = RectF()
            for (layer in layers) {
                target.set(
                    layer.x * scale,
                    layer.y * scale,
                    (layer.x + layer.width) * scale,
                    (layer.y + layer.height) * scale,
                )
                val bitmap = layer.lease?.bitmap
                if (layer.cover || bitmap == null) {
                    target.set(floor(target.left), floor(target.top), ceil(target.right), ceil(target.bottom))
                    canvas.drawRect(target, maskPaint)
                    continue
                }
                // One px of the final image, at least one of the copy.
                val bleedX = ceil(bitmap.width / target.width()).coerceAtLeast(1f) * MASK_BLEED_PX
                val bleedY = ceil(bitmap.height / target.height()).coerceAtLeast(1f) * MASK_BLEED_PX
                paintMasks(bitmap, layer.masks, layer.width, layer.height, bleedX, bleedY)
                canvas.drawBitmap(bitmap, null, target, bitmapPaint)
            }
            return out
        } catch (e: Throwable) {
            out.recycle()
            throw e
        }
    }

    /**
     * The masks of a window ([sourceWidth] x [sourceHeight] px) on its copy,
     * whatever the copy's size: rounded outward, then [bleedX] / [bleedY]
     * copy px wider on each side ([MASK_BLEED_PX] of the final image), since
     * the filtered downscale mixes a pixel next to a mask with the pixels
     * under it.
     */
    private fun paintMasks(
        bitmap: Bitmap,
        rects: List<Rect>,
        sourceWidth: Int,
        sourceHeight: Int,
        bleedX: Float,
        bleedY: Float,
    ) {
        if (rects.isEmpty()) return
        val canvas = Canvas(bitmap)
        val scaleX = bitmap.width.toFloat() / sourceWidth
        val scaleY = bitmap.height.toFloat() / sourceHeight
        val mask = RectF()
        for (rect in rects) {
            mask.set(
                floor(rect.left * scaleX) - bleedX,
                floor(rect.top * scaleY) - bleedY,
                ceil(rect.right * scaleX) + bleedX,
                ceil(rect.bottom * scaleY) + bleedY,
            )
            canvas.drawRect(mask, maskPaint)
        }
    }

    /** Recorder thread: the image as WebP with its `data:` prefix, null when it cannot be encoded. */
    fun encode(image: Bitmap): String? = try {
        image.webpBase64(quality)
    } catch (e: Throwable) {
        if (e is VirtualMachineError) throw e
        null
    }

    /** The wireframe of a screenshot covering the screen ([width] x [height] dp). */
    fun toScreenshotWireframe(base64: String, width: Int, height: Int): RRWireframe = RRWireframe(
        id = wireframeId,
        x = 0,
        y = 0,
        width = width,
        height = height,
        type = SCREENSHOT,
        base64 = base64,
    )

    private val timeoutToken = Any()

    private fun View.isDialogWindow(): Boolean =
        phoneWindowOrNull() != null && windowType != WindowManager.LayoutParams.TYPE_BASE_APPLICATION

    companion object {
        const val SCREENSHOT = "screenshot"

        /** The mask: opaque, painted before any encoding. */
        const val MASK_COLOR = Color.BLACK

        /** Px of the final image a mask reaches past its rect on each side. */
        const val MASK_BLEED_PX = 1

        /** A copy that has not answered by then discards the frame. */
        const val COPY_TIMEOUT_MS = 1_000L

        private val maskPaint = Paint().apply {
            color = MASK_COLOR
            style = Paint.Style.FILL
            isAntiAlias = false
        }
        private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    }
}
