// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt
// (toWireframe, toSecureWireframe, isVisible, Drawable.toRGBColor, Drawable.base64,
// LayerDrawable.getFirstDrawable, Int.toRGBColor, Theme.toRGBColor, String.mask,
// isNoCapture, Drawable.copy, Drawable.toBitmap)
// Changed: stable ids from a registry instead of identityHashCode; text inputs (any
// editable TextView) and password fields are always masked (no option to turn it off);
// images follow maskAllImages only and are JPEG with a data: prefix; background colors are
// also read through wrappers, ripples, state lists and ColorStateLists, and sampled from a
// drawable of unknown type; a GradientDrawable's stroke is the border (read by reflection,
// VEL-2174); the no-capture tag turns a whole subtree into one placeholder and
// contentDescription is never read; a FLAG_SECURE window is one placeholder; Compose from its
// semantics (ComposeWireframes.kt, not in PostHog); no Spinner options, no compound drawables.

package com.cohorly.android.replay

import android.annotation.TargetApi
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.AnimatedVectorDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.DrawableContainer
import android.graphics.drawable.DrawableWrapper
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.NinePatchDrawable
import android.graphics.drawable.PictureDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.VectorDrawable
import android.os.Build
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.CheckBox
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.RatingBar
import android.widget.Spinner
import android.widget.TextView
import com.cohorly.android.replay.rr.RRStyle
import com.cohorly.android.replay.rr.RRWireframe
import java.io.ByteArrayOutputStream
import java.lang.reflect.Field
import java.util.WeakHashMap
import kotlin.math.roundToInt

/**
 * Wireframe ids: an integer from [RRWireframe.FIRST_ID] up per view, and per
 * Compose semantics node (keyed by its host view and node id), the same for
 * as long as the view or node lives (a weak map, so a dead view frees its
 * entries), never reused. Main thread only.
 */
internal class ViewIdRegistry {
    private val ids = WeakHashMap<View, Int>()
    private val nodeIds = WeakHashMap<View, HashMap<Int, Int>>()
    private var next = RRWireframe.FIRST_ID

    fun idFor(view: View): Int = ids.getOrPut(view) { next++ }

    /** The id of semantics node [nodeId] of the composition hosted by [view]. */
    fun idFor(view: View, nodeId: Int): Int = nodeIds.getOrPut(view) { HashMap() }.getOrPut(nodeId) { next++ }

    /** Forgets the nodes of [view] that are not in [liveNodeIds] (they left the composition). */
    fun retainNodes(view: View, liveNodeIds: Set<Int>) {
        nodeIds[view]?.keys?.retainAll(liveNodeIds)
    }

    /** An id no view or node has, never reused. */
    fun newId(): Int = next++

    /** The id [view] already has, or null when it was never captured. */
    fun existingId(view: View): Int? = ids[view]

    /** The id node [nodeId] of [view] already has, or null. */
    fun existingId(view: View, nodeId: Int): Int? = nodeIds[view]?.get(nodeId)
}

/** The [GradientDrawable] a background is drawn with; [inset]: drawn offset inside the view, so no stroke border. */
internal data class FoundGradient(val drawable: GradientDrawable, val inset: Boolean)

/** A [GradientDrawable]'s stroke: its width in px and its color (ARGB). */
internal class GradientStroke(val widthPx: Float, val color: Int)

/**
 * Reads a [GradientDrawable]'s stroke, which has no public getter: the
 * private `mStrokePaint` field (null when no stroke was set), resolved once.
 * Null when there is none or the field cannot be read (renamed, or refused by
 * the hidden API checks); never throws.
 */
internal object GradientStrokeReader {
    private val strokePaint: Field? by lazy {
        try {
            GradientDrawable::class.java.getDeclaredField("mStrokePaint").apply { isAccessible = true }
        } catch (_: Throwable) {
            null
        }
    }

    fun read(drawable: GradientDrawable): GradientStroke? = try {
        (strokePaint?.get(drawable) as? Paint)?.let { GradientStroke(it.strokeWidth, it.color) }
    } catch (_: Throwable) {
        null
    }
}

/**
 * Turns a window's view tree into wireframes (docs/SESSION-REPLAY.md,
 * "Wireframes"). Main thread only: it reads the views.
 *
 * Masking, applied here and only here:
 * - every [EditText], every editable [TextView] (one with a `KeyListener`
 *   or that is a text editor) and every password field (a password input
 *   type or a [PasswordTransformationMethod], a plain [TextView] included)
 *   has its text replaced by `*` of the same length; there is no option to
 *   turn it off;
 * - with [maskAllImages], an [ImageView] is an `image` with no `base64` and a
 *   non-color background is dropped; without it, both are a small JPEG;
 * - a view whose `tag` is a String containing [CohorlyReplay.NO_CAPTURE_TAG]
 *   is one `placeholder` with no text and no children;
 * - a `FLAG_SECURE` window is one `placeholder` the size of the window;
 * - a Compose view is described by its semantics ([ComposeWireframes]).
 */
@TargetApi(Build.VERSION_CODES.O)
internal class WireframeBuilder(
    private val ids: ViewIdRegistry,
    private val maskAllImages: Boolean,
    private val compose: ComposeDetector = ComposeDetector.Default,
    private var composeNodes: ComposeNodeSource? = null,
    /** A background gradient's stroke, the wireframe's border; tests replace it. */
    private val strokeOf: (GradientDrawable) -> GradientStroke? = GradientStrokeReader::read,
) {
    /** px per dp, set before each capture (it follows the display settings). */
    var density: Float = 1f

    private val location = IntArray(2)
    private val scratchRect = Rect()

    /**
     * The wireframe of a whole window ([root] is its root view), null when
     * the window is not visible. The window's background (the decor view's,
     * else the theme's `windowBackground`) is the root's `backgroundColor`,
     * so a view with no background of its own shows what is behind it.
     */
    fun window(root: View, secure: Boolean): RRWireframe? {
        if (root.windowVisibility != View.VISIBLE) return null
        if (secure) return toSecureWireframe(root)
        val wireframe = toWireframe(root, RRWireframe.SCREEN_ROOT_ID) ?: return null
        if (wireframe.style?.backgroundColor == null && wireframe.type != PLACEHOLDER) {
            val color = root.phoneWindowOrNull()?.decorView?.background?.toRGBColor()
                ?: root.context.theme?.windowBackgroundColor(root)
            if (color != null) {
                return wireframe.copy(style = (wireframe.style ?: RRStyle()).copy(backgroundColor = color))
            }
        }
        return wireframe
    }

    /** A FLAG_SECURE window: one placeholder, nothing from its view tree. */
    fun toSecureWireframe(root: View): RRWireframe? {
        if (!root.isShown || root.width <= 0 || root.height <= 0) return null
        root.getLocationOnScreen(location)
        return RRWireframe(
            id = ids.idFor(root),
            x = location[0].dp(),
            y = location[1].dp(),
            width = root.width.dp(),
            height = root.height.dp(),
            type = PLACEHOLDER,
            parentId = RRWireframe.SCREEN_ROOT_ID,
        )
    }

    /**
     * [hidden]: the no-capture nodes (window px) of the composition [view] is
     * inside, if any; a view overlapping one is left out, its placeholder
     * covers it.
     */
    fun toWireframe(view: View, parentId: Int, hidden: List<Rect> = emptyList()): RRWireframe? {
        if (!view.isVisibleForCapture()) return null
        if (interopCover(view, hidden) != null) return null

        val viewId = ids.idFor(view)
        view.getLocationOnScreen(location)
        val x = location[0].dp()
        val y = location[1].dp()
        val width = view.width.dp()
        val height = view.height.dp()

        if (view.isNoCapture()) {
            return RRWireframe(
                id = viewId,
                x = x,
                y = y,
                width = width,
                height = height,
                type = PLACEHOLDER,
                parentId = parentId,
            )
        }

        var type = if (view is ViewGroup) "div" else "rectangle"
        if (view.id == android.R.id.statusBarBackground) type = "status_bar"
        if (view.id == android.R.id.navigationBarBackground) type = "navigation_bar"

        var style = backgroundStyle(view)
        var text: String? = null
        var inputType: String? = null
        var value: Any? = null
        var label: String? = null
        var checked: Boolean? = null
        var max: Int? = null
        var base64: String? = null

        // Button, CheckBox, EditText... all extend TextView.
        if (view is TextView) {
            val editable = view is EditText || view.isEditableText()
            val masked = editable || view.isPasswordField()
            val viewText = view.text?.toString()
            text = if (viewText.isNullOrEmpty()) {
                null
            } else if (masked) {
                viewText.mask()
            } else {
                viewText
            }
            type = "text"
            style = textStyle(view, style)

            if (view is Button && view !is CompoundButton) {
                type = "input"
                inputType = "button"
                value = text
                text = null
                style = style.copy(borderWidth = style.borderWidth ?: 1, borderColor = style.borderColor ?: "#000000")
            }
            if (view is CompoundButton) {
                type = "input"
                inputType = when (view) {
                    is CheckBox -> "checkbox"
                    is RadioButton -> "radio"
                    else -> "toggle" // Switch, ToggleButton, SwitchCompat...
                }
                label = text
                text = null
                checked = view.isChecked
            }
            if (editable && view !is Button) {
                type = "input"
                inputType = view.htmlInputType()
                // The hint is the app's text, never typed: it may show.
                value = text ?: view.hint?.toString()?.takeIf { it.isNotEmpty() }
                text = null
            }
        }

        if (view is RadioGroup) type = "radio_group"

        if (view is Spinner) {
            type = "input"
            inputType = "select"
            value = view.selectedItem?.toString()
        }

        if (view is ImageView) {
            type = "image"
            if (!maskAllImages) base64 = view.drawable?.jpegBase64(view.width, view.height)
        }

        if (view is ProgressBar) {
            type = "input"
            inputType = "progress"
            if (view is RatingBar) {
                style = style.copy(bar = "rating")
                max = view.numStars
                value = view.rating
            } else if (view.isIndeterminate) {
                style = style.copy(bar = "circular")
            } else {
                style = style.copy(bar = "horizontal")
                max = view.max
                value = view.progress
            }
        }

        if (view is WebView) type = "web_view"
        if (view is SurfaceView || view is TextureView) type = PLACEHOLDER

        val children = mutableListOf<RRWireframe>()
        var childHidden = hidden
        if (compose.isComposeView(view)) {
            val source = composeNodes ?: ComposeWireframes().also { composeNodes = it }
            // Unreadable: one placeholder, none of its interop views either.
            val read = source.nodes(view, viewId, ids, density)
                ?: return RRWireframe(viewId, x, y, width, height, type = PLACEHOLDER, parentId = parentId)
            children.addAll(read.wireframes)
            childHidden = read.noCapture
        }
        if (view is ViewGroup && type != PLACEHOLDER && type != "web_view") {
            for (i in 0 until view.childCount) {
                val child = view.getChildAt(i) ?: continue
                toWireframe(child, viewId, childHidden)?.let { children.add(it) }
            }
        }

        return RRWireframe(
            id = viewId,
            x = x,
            y = y,
            width = width,
            height = height,
            childWireframes = children.ifEmpty { null },
            type = type,
            inputType = inputType,
            text = text,
            label = label,
            value = value,
            base64 = base64,
            style = style.takeIf { it != EMPTY_STYLE },
            disabled = if (type == "input") !view.isEnabled else null,
            checked = checked,
            max = max,
            parentId = parentId,
        )
    }

    // MARK: visibility

    /**
     * Adapted from PostHog's isVisible: the walk starts at a visible root, so
     * only this view's own visibility, alpha and size, and whether any of it
     * is on screen, are checked.
     */
    private fun View.isVisibleForCapture(): Boolean {
        if (width <= 0 || height <= 0) return false
        if (visibility != View.VISIBLE || alpha <= 0f) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && transitionAlpha <= 0f) return false
        if (!isAttachedToWindow) return false
        return try {
            getGlobalVisibleRect(scratchRect)
        } catch (_: Exception) {
            true
        }
    }

    // MARK: masking

    private fun View.isNoCapture(): Boolean =
        (tag as? String)?.contains(CohorlyReplay.NO_CAPTURE_TAG, ignoreCase = true) == true

    private fun TextView.isPasswordField(): Boolean = isPasswordInputType(inputType) ||
        transformationMethod is PasswordTransformationMethod

    /** A TextView the user can type into, whatever its class: it takes keys or acts as a text editor. */
    private fun TextView.isEditableText(): Boolean = keyListener != null || onCheckIsTextEditor()

    private fun TextView.htmlInputType(): String {
        val cls = inputType and InputType.TYPE_MASK_CLASS
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when {
            isPasswordField() -> "password"
            cls == InputType.TYPE_CLASS_NUMBER -> "number"
            cls == InputType.TYPE_CLASS_PHONE -> "tel"
            cls == InputType.TYPE_CLASS_TEXT &&
                (
                    variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
                        variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS
                    ) -> "email"
            cls == InputType.TYPE_CLASS_TEXT && variation == InputType.TYPE_TEXT_VARIATION_URI -> "url"
            inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0 -> "text_area"
            else -> "text"
        }
    }

    private fun String.mask(): String = "*".repeat(length)

    // MARK: style

    private fun backgroundStyle(view: View): RRStyle {
        val background = view.background ?: return EMPTY_STYLE
        var style = EMPTY_STYLE
        val color = view.backgroundTintColor()
            ?: background.toRGBColor()
            ?: if (maskAllImages) background.sampledColor(view.width, view.height) else null
        if (color != null) {
            style = style.copy(backgroundColor = color)
        } else if (!maskAllImages) {
            style = style.copy(backgroundImage = background.jpegBase64(view.width, view.height))
        }
        background.gradient()?.let { (gradient, inset) ->
            val radius = gradient.cornerRadius
            if (radius > 0f) style = style.copy(borderRadius = radius.toInt().dp())
            if (!inset) {
                gradient.border()?.let { (width, color) ->
                    style = style.copy(borderWidth = width, borderColor = color)
                }
            }
        }
        return style
    }

    /**
     * The stroke as a border: its width in dp (rounded, at least 1) and its color as
     * the background colors are (alpha dropped). Null with no stroke, a width
     * of 0 or a transparent color, a shape that is not a rectangle, or when it
     * cannot be read.
     */
    private fun GradientDrawable.border(): Pair<Int, String>? {
        // A line, an oval or a ring is not the view's rectangle: no border is better than a wrong one.
        if (shape != GradientDrawable.RECTANGLE) return null
        val stroke = try {
            strokeOf(this)
        } catch (_: Throwable) {
            null
        } ?: return null
        if (!(stroke.widthPx > 0f)) return null
        val color = stroke.color.opaqueOrNull() ?: return null
        // Rounded, not truncated: a 2dp stroke is 5 px at 2.625 px/dp, and 1.9 is a 2dp border.
        return (stroke.widthPx / density).roundToInt().coerceAtLeast(1) to color
    }

    /** `android:backgroundTint` (a [android.content.res.ColorStateList]) in the view's current state, when set. */
    private fun View.backgroundTintColor(): String? {
        val tint = backgroundTintList ?: return null
        return tint.getColorForState(drawableState, tint.defaultColor).opaqueOrNull()
    }

    private fun textStyle(view: TextView, base: RRStyle): RRStyle {
        var fontFamily: String? = null
        when (view.typeface) {
            Typeface.DEFAULT -> fontFamily = "sans-serif"
            Typeface.DEFAULT_BOLD -> fontFamily = "sans-serif-bold"
            Typeface.MONOSPACE -> fontFamily = "monospace"
            Typeface.SERIF -> fontFamily = "serif"
        }
        val (horizontal, vertical) = when (view.textAlignment) {
            View.TEXT_ALIGNMENT_CENTER -> "center" to "center"
            View.TEXT_ALIGNMENT_TEXT_END, View.TEXT_ALIGNMENT_VIEW_END -> "right" to "center"
            View.TEXT_ALIGNMENT_TEXT_START, View.TEXT_ALIGNMENT_VIEW_START -> "left" to "center"
            View.TEXT_ALIGNMENT_GRAVITY -> {
                val h = when (view.gravity and Gravity.HORIZONTAL_GRAVITY_MASK) {
                    Gravity.END, Gravity.RIGHT -> "right"
                    Gravity.CENTER_HORIZONTAL -> "center"
                    else -> "left"
                }
                val v = when (view.gravity and Gravity.VERTICAL_GRAVITY_MASK) {
                    Gravity.TOP -> "top"
                    Gravity.BOTTOM -> "bottom"
                    else -> "center"
                }
                h to v
            }
            else -> "left" to "center"
        }
        var style = base.copy(
            color = view.currentTextColor.toRGBColor(),
            fontFamily = fontFamily,
            fontSize = view.textSize.toInt().dp(),
            horizontalAlign = horizontal,
            verticalAlign = vertical,
        )
        // Padding is left out when the text is centered, otherwise it ends up off.
        if (vertical != "center") {
            style = style.copy(paddingTop = view.totalPaddingTop.dp(), paddingBottom = view.totalPaddingBottom.dp())
        }
        if (horizontal != "center") {
            style = style.copy(paddingLeft = view.totalPaddingLeft.dp(), paddingRight = view.totalPaddingRight.dp())
        }
        return style
    }

    /**
     * The one color a background drawable paints, read from its type:
     * colors, gradients (their first color), and through the drawables that
     * hold others (a layer list's bottom layer with a color, a ripple's
     * content, a state list's current state, inset/scale/clip wrappers).
     * Null when it has no single color, or it is transparent.
     */
    private fun Drawable.toRGBColor(depth: Int = 0): String? {
        if (depth > MAX_DRAWABLE_DEPTH) return null
        return try {
            when (this) {
                is ColorDrawable -> color.opaqueOrNull()
                // A RippleDrawable is a LayerDrawable whose mask layer is never drawn.
                is RippleDrawable -> layers().firstNotNullOfOrNull { (id, layer) ->
                    if (id == android.R.id.mask) null else layer.toRGBColor(depth + 1)
                }
                is LayerDrawable -> layers().firstNotNullOfOrNull { (_, layer) -> layer.toRGBColor(depth + 1) }
                // StateListDrawable, LevelListDrawable, AnimationDrawable...
                is DrawableContainer -> current?.takeIf { it !== this }?.toRGBColor(depth + 1)
                is InsetDrawable -> drawable?.toRGBColor(depth + 1)
                // ScaleDrawable, ClipDrawable, RotateDrawable, AppCompat's wrappers on API 23+.
                is DrawableWrapper -> drawable?.toRGBColor(depth + 1)
                is GradientDrawable -> colors?.firstOrNull()?.opaqueOrNull()
                    ?: color?.let { it.getColorForState(state, it.defaultColor).opaqueOrNull() }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Start and end insets read [Int.MIN_VALUE] (undefined) when the layer has none. */
    private fun Int.isSetInset(): Boolean = this != 0 && this != Int.MIN_VALUE

    private fun LayerDrawable.isLayerInset(index: Int): Boolean = getLayerInsetLeft(index) != 0 ||
        getLayerInsetTop(index) != 0 ||
        getLayerInsetRight(index) != 0 ||
        getLayerInsetBottom(index) != 0 ||
        getLayerInsetStart(index).isSetInset() ||
        getLayerInsetEnd(index).isSetInset()

    /** Bottom to top, with each layer's id. */
    private fun LayerDrawable.layers(): List<Pair<Int, Drawable>> =
        (0 until numberOfLayers).mapNotNull { i -> getDrawable(i)?.let { getId(i) to it } }

    /**
     * The color at the center of a drawable whose type says nothing (a
     * platform private one, like the ActionBar's background, which wraps the
     * theme's layer list), drawn at [SAMPLE_SIDE] px a side. Only when it is
     * opaque there; never for a picture (bitmap, nine-patch, vector), which
     * [maskAllImages] hides. A color, never pixels, leaves the device.
     */
    private fun Drawable.sampledColor(widthPx: Int, heightPx: Int): String? {
        if (widthPx <= 0 || heightPx <= 0 || isPicture()) return null
        var bitmap: Bitmap? = null
        return try {
            bitmap = Bitmap.createBitmap(SAMPLE_SIDE, SAMPLE_SIDE, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val bounds = copyBounds()
            if (bounds.isEmpty) bounds.set(0, 0, widthPx, heightPx)
            canvas.scale(SAMPLE_SIDE / bounds.width().toFloat(), SAMPLE_SIDE / bounds.height().toFloat())
            canvas.translate(-bounds.left.toFloat(), -bounds.top.toFloat())
            val previous = copyBounds()
            setBounds(bounds)
            try {
                draw(canvas)
            } finally {
                setBounds(previous)
            }
            bitmap.getPixel(SAMPLE_SIDE / 2, SAMPLE_SIDE / 2).takeIf { Color.alpha(it) == 255 }?.toRGBColor()
        } catch (_: Throwable) {
            null
        } finally {
            bitmap?.recycle()
        }
    }

    private fun Drawable.isPicture(): Boolean = this is BitmapDrawable ||
        this is NinePatchDrawable ||
        this is VectorDrawable ||
        this is AnimatedVectorDrawable ||
        this is PictureDrawable ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && this is android.graphics.drawable.AnimatedImageDrawable)

    /**
     * The [GradientDrawable] a background is drawn with (its corner radius
     * and stroke): itself, or through a ripple's content, a layer list's
     * lowest layer that has one, a state list's current state and the wrappers.
     */
    private fun Drawable.gradient(depth: Int = 0, inset: Boolean = false): FoundGradient? {
        if (depth > MAX_DRAWABLE_DEPTH) return null
        return try {
            when (this) {
                is GradientDrawable -> FoundGradient(this, inset)
                is RippleDrawable -> layers().firstNotNullOfOrNull { (id, layer) ->
                    if (id == android.R.id.mask) null else layer.gradient(depth + 1, inset)
                }
                // A layer inset on any side (an underline drawn by shifting a layer) is not the view's rectangle:
                // a gradient in a plain layer wins, one in an inset layer still gives the corner radius.
                is LayerDrawable -> (0 until numberOfLayers).firstNotNullOfOrNull { i ->
                    if (isLayerInset(i)) null else getDrawable(i)?.gradient(depth + 1, inset)
                } ?: (0 until numberOfLayers).firstNotNullOfOrNull { i -> getDrawable(i)?.gradient(depth + 1, true) }
                is DrawableContainer -> current?.takeIf { it !== this }?.gradient(depth + 1, inset)
                // An inset shape is not the view's rectangle either: its padding is the inset.
                is InsetDrawable -> drawable?.gradient(depth + 1, inset || hasInset())
                is DrawableWrapper -> drawable?.gradient(depth + 1, inset)
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** An inset drawable's own inset: its padding minus the padding of the shape it wraps. */
    private fun InsetDrawable.hasInset(): Boolean {
        val outer = Rect()
        getPadding(outer)
        val inner = Rect()
        drawable?.getPadding(inner)
        return outer.left != inner.left ||
            outer.top != inner.top ||
            outer.right != inner.right ||
            outer.bottom != inner.bottom
    }

    /** The theme's `windowBackground`: a color, or a drawable with one. */
    private fun Resources.Theme.windowBackgroundColor(root: View): String? {
        val value = TypedValue()
        if (!resolveAttribute(android.R.attr.windowBackground, value, true)) return null
        if (value.type >= TypedValue.TYPE_FIRST_COLOR_INT && value.type <= TypedValue.TYPE_LAST_COLOR_INT) {
            return value.data.opaqueOrNull()
        }
        if (value.resourceId == 0) return null
        return try {
            root.context.getDrawable(value.resourceId)?.toRGBColor()
        } catch (_: Exception) {
            null
        }
    }

    // MARK: images

    /**
     * The drawable as a small JPEG (quality [JPEG_QUALITY], at most [MAX_IMAGE_SIDE]
     * px a side, never more than the view's size in dp) with the `data:` prefix,
     * drawn on a copy so the view's own drawable is never touched. Null when
     * it cannot be drawn.
     */
    private fun Drawable.jpegBase64(viewWidthPx: Int, viewHeightPx: Int): String? {
        val targetWidth = viewWidthPx.dp().coerceIn(1, MAX_IMAGE_SIDE)
        val targetHeight = viewHeightPx.dp().coerceIn(1, MAX_IMAGE_SIDE)
        var bitmap: Bitmap? = null
        return try {
            val source = (this as? BitmapDrawable)?.bitmap
            bitmap = if (source != null) {
                if (source.isRecycled) return null
                Bitmap.createScaledBitmap(source, targetWidth, targetHeight, true)
            } else {
                val copy = constantState?.newDrawable() ?: return null
                Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888).also { out ->
                    val canvas = Canvas(out)
                    // JPEG has no alpha: transparent areas would turn black.
                    canvas.drawColor(Color.WHITE)
                    copy.setBounds(0, 0, targetWidth, targetHeight)
                    copy.draw(canvas)
                }
            }
            val bytes = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bytes)) return null
            JPEG_PREFIX + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        } catch (_: Throwable) {
            null
        } finally {
            // Never recycle the app's own bitmap (createScaledBitmap may return it as is).
            val owned = bitmap
            if (owned != null && owned !== (this as? BitmapDrawable)?.bitmap) owned.recycle()
        }
    }

    private fun Int.dp(): Int = (this / density).toInt()

    companion object {
        const val PLACEHOLDER = "placeholder"
        const val JPEG_PREFIX = "data:image/jpeg;base64,"
        const val JPEG_QUALITY = 30
        const val MAX_IMAGE_SIDE = 512

        /** Side of the bitmap a drawable of unknown type is drawn into to read its color. */
        const val SAMPLE_SIDE = 8
        private const val MAX_DRAWABLE_DEPTH = 8
        private val EMPTY_STYLE = RRStyle()

        /** A text or number password input type (the variation alone does not tell: it depends on the class). */
        fun isPasswordInputType(inputType: Int): Boolean {
            val cls = inputType and InputType.TYPE_MASK_CLASS
            val variation = inputType and InputType.TYPE_MASK_VARIATION
            return (
                cls == InputType.TYPE_CLASS_TEXT &&
                    (
                        variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                            variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                            variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                        )
                ) ||
                (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        }

        private fun Int.toRGBColor(): String = String.format("#%06X", 0xFFFFFF and this)

        /** The color, or null when fully transparent (it paints nothing). */
        private fun Int.opaqueOrNull(): String? = if (Color.alpha(this) == 0) null else toRGBColor()
    }
}
