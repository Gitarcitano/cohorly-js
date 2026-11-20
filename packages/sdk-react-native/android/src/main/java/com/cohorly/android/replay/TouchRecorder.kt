// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt
// (touchInterceptor, interceptTouch, generateMouseInteractions, getRawXCompat)
// Changed: only the primary pointer; the touched wireframe is resolved later by the
// recorder against the last snapshot it sent (PostHog sends the pointer id); a touch on
// a FLAG_SECURE window is not recorded at all, only counted as activity; events go to
// the recorder, not to capture().

package com.cohorly.android.replay

import android.view.MotionEvent
import android.view.View
import com.cohorly.android.replay.rr.RRMouseInteraction
import curtains.DispatchState
import curtains.TouchEventInterceptor

/**
 * Records touch start/end of one window. Main thread (curtains calls it from
 * the window's `dispatchTouchEvent`). The position goes out in screen px;
 * the recorder turns it into dp and finds the touched wireframe.
 */
internal class TouchRecorder(
    private val root: View,
    private val isRecording: () -> Boolean,
    private val onTouch: (interaction: RRMouseInteraction, rawX: Float, rawY: Float) -> Unit,
    private val onSecureTouch: () -> Unit,
) : TouchEventInterceptor {
    override fun intercept(motionEvent: MotionEvent, dispatch: (MotionEvent) -> DispatchState): DispatchState {
        val interaction = when (motionEvent.actionMasked) {
            MotionEvent.ACTION_DOWN -> RRMouseInteraction.TouchStart
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> RRMouseInteraction.TouchEnd
            else -> null
        }
        // Read before dispatch: the touch may close the window or move it.
        var rawX = 0f
        var rawY = 0f
        var secure = false
        var record = false
        if (interaction != null) {
            try {
                if (isRecording()) {
                    record = true
                    // Checked at the touch, not at the last capture: the flag may have just been set.
                    secure = root.isSecureWindow()
                    rawX = motionEvent.rawX
                    rawY = motionEvent.rawY
                }
            } catch (_: Exception) {
                // Never let recording break the app's touch handling.
                record = false
            }
        }
        val state = dispatch(motionEvent)
        if (interaction != null && record) {
            try {
                if (secure) onSecureTouch() else onTouch(interaction, rawX, rawY)
            } catch (_: Exception) {
            }
        }
        return state
    }
}
