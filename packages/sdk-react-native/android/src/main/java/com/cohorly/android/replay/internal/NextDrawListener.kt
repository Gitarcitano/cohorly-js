// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/internal/NextDrawListener.kt
// (itself inspired by square/curtains NextDrawListener.kt)
// Changed: the throttle is shared by every window (one snapshot covers all of them), so
// the listener only forwards the draw; no draw-state bookkeeping for screenshots.

package com.cohorly.android.replay.internal

import android.view.View
import android.view.ViewTreeObserver

/** Forwards every draw of [view]'s tree to [onDraw]. Main thread. */
internal class NextDrawListener(private val view: View, private val onDraw: () -> Unit) :
    ViewTreeObserver.OnDrawListener {
    override fun onDraw() {
        onDraw.invoke()
    }

    fun register() {
        if (view.isAlive()) view.viewTreeObserver?.addOnDrawListener(this)
    }

    fun unregister() {
        // Removing from a dead observer throws: it can die between the check and the call.
        try {
            if (view.isAlive()) view.viewTreeObserver?.removeOnDrawListener(this)
        } catch (_: IllegalStateException) {
        }
    }
}

internal fun View.isAlive(): Boolean = viewTreeObserver?.isAlive == true
