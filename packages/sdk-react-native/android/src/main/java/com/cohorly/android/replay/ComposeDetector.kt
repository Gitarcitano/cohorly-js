package com.cohorly.android.replay

import android.graphics.Rect
import android.view.View

/**
 * Whether the app has Jetpack Compose, and which views are its roots. Only
 * class names here: every use of a Compose class lives in [ComposeWireframes],
 * [ComposeMask] and `compose/`, reached only after [isComposeView] says yes,
 * so an app without Compose never loads one (no `NoClassDefFoundError`).
 */
internal class ComposeDetector(private val load: (String) -> Unit = { Class.forName(it) }) {
    val isAvailable: Boolean by lazy {
        try {
            load(ANDROID_COMPOSE_VIEW)
            true
        } catch (_: Throwable) {
            false
        }
    }

    /** True for the view that hosts a composition (`AndroidComposeView`, inside every `ComposeView`). */
    fun isComposeView(view: View): Boolean = isAvailable && view.javaClass.name == ANDROID_COMPOSE_VIEW

    companion object {
        const val ANDROID_COMPOSE_VIEW = "androidx.compose.ui.platform.AndroidComposeView"

        /**
         * Child views of a composition that are Compose's own plumbing, not
         * interop content: walked, never checked against a no-capture node
         * themselves (the views handler spans the whole composition). A
         * renamed one is checked, so it covers more, never less.
         */
        val COMPOSE_PLUMBING = setOf(
            "androidx.compose.ui.platform.AndroidViewsHandler",
            "androidx.compose.ui.platform.ViewLayerContainer",
            "androidx.compose.ui.platform.DrawChildContainer",
            "androidx.compose.ui.platform.ViewLayer",
        )

        val Default = ComposeDetector()
    }
}

/**
 * For a view inside a composition (an `AndroidView` interop and its
 * subtree): the area to cover when its window rect overlaps one of the
 * composition's no-capture nodes [noCapture] (window px), the union of the
 * view and every node it overlaps; null when it overlaps none or is Compose
 * plumbing ([ComposeDetector.COMPOSE_PLUMBING]).
 */
internal fun interopCover(view: View, noCapture: List<Rect>): Rect? {
    if (noCapture.isEmpty() || view.javaClass.name in ComposeDetector.COMPOSE_PLUMBING) return null
    val rect = view.windowRect()
    var cover: Rect? = null
    for (node in noCapture) {
        if (!Rect.intersects(node, rect)) continue
        cover = (cover ?: Rect(rect)).apply { union(node) }
    }
    return cover
}

/** [this] view's bounds in its window, px. */
internal fun View.windowRect(): Rect {
    val location = IntArray(2)
    getLocationInWindow(location)
    return Rect(location[0], location[1], location[0] + width, location[1] + height)
}
