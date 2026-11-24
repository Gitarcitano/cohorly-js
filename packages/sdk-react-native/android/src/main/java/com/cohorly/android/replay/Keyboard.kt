// The software keyboard in the mobile replay format (VEL-2174): the `keyboard` custom event
// of docs/SESSION-REPLAY.md ("Events", type 5). Not from PostHog: posthog-android reads the
// keyboard through androidx.core's WindowInsetsCompat, which this module does not depend on.

package com.cohorly.android.replay

import android.annotation.TargetApi
import android.os.Build
import android.view.View
import android.view.WindowInsets
import com.cohorly.android.replay.rr.RREvent
import org.json.JSONObject

/** The keyboard on screen: [height] in dp, 0 when closed. */
internal data class KeyboardState(val open: Boolean, val height: Int) {
    companion object {
        val CLOSED = KeyboardState(open = false, height = 0)
    }
}

/**
 * Reads the keyboard from the windows' insets (main thread). The first
 * window, from the top, whose `rootWindowInsets` show the IME gives the
 * height; none: closed. Any failure reads as closed.
 */
@TargetApi(Build.VERSION_CODES.O)
internal object KeyboardReader {
    /** [roots] bottom to top, as a capture takes them; [density] px per dp, the wireframe's. */
    fun read(roots: List<View>, density: Float): KeyboardState {
        for (root in roots.asReversed()) {
            // A window that fails (detached while read) is skipped, never hides the ones under it.
            val heightPx = try {
                if (root.windowVisibility != View.VISIBLE) continue
                imeHeightPx(root.rootWindowInsets ?: continue)
            } catch (_: Throwable) {
                null
            } ?: continue
            return KeyboardState(open = true, height = (heightPx / density).toInt())
        }
        return KeyboardState.CLOSED
    }

    /**
     * The keyboard's height in px over a window with [insets], null when it
     * is not shown: [imeHeightPx30] on API 30+, else [imeHeightPxLegacy].
     */
    fun imeHeightPx(insets: WindowInsets): Int? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) imeHeightPx30(insets) else imeHeightPxLegacy(insets)

    /**
     * API 30+: the IME inset, from the bottom of the screen, when visible.
     * A keyboard that takes no bottom inset (floating, or the first frame of
     * its animation) reads as closed: the player draws it at the bottom.
     */
    @TargetApi(Build.VERSION_CODES.R)
    fun imeHeightPx30(insets: WindowInsets): Int? = if (insets.isVisible(WindowInsets.Type.ime())) {
        insets.getInsets(WindowInsets.Type.ime()).bottom.takeIf { it > 0 }
    } else {
        null
    }

    /**
     * API 26-29: open when the system window insets add something at the
     * bottom to the stable ones (the keyboard is what changes them there);
     * the height is the whole bottom inset, from the bottom of the screen
     * like on API 30+.
     */
    @Suppress("DEPRECATION")
    fun imeHeightPxLegacy(insets: WindowInsets): Int? =
        insets.systemWindowInsetBottom.takeIf { it > insets.stableInsetBottom }
}

/**
 * What the player was last told about the keyboard, and the events that
 * bring it to a new state. Recorder thread only, next to the snapshot status.
 *
 * - Only a change is sent: closed to open (`open: true` with the height),
 *   open to closed (`open: false`), and a new height while open as a close
 *   then an open, at the same timestamp (the player adds a keyboard node per
 *   `open: true` and removes it on `open: false`).
 * - A full snapshot rebuilds the player's screen without the keyboard: after
 *   one, an open keyboard is sent again.
 */
internal class KeyboardTracker {
    private var sent = KeyboardState.CLOSED

    /** Nothing sent: the next open keyboard is sent (a new recording, opt-out). */
    fun reset() {
        sent = KeyboardState.CLOSED
    }

    /**
     * The events that follow a capture's snapshot events. [afterFull]: that
     * capture was sent as a full snapshot, so the player shows no keyboard.
     */
    fun events(current: KeyboardState, timestamp: Long, afterFull: Boolean): List<JSONObject> {
        if (afterFull) sent = KeyboardState.CLOSED
        val target = if (current.open) current else KeyboardState.CLOSED
        if (target == sent) return emptyList()
        val events = ArrayList<JSONObject>(2)
        if (sent.open) events.add(RREvent.keyboardClosed(timestamp))
        if (target.open) events.add(RREvent.keyboardOpened(target.height, timestamp))
        sent = target
        return events
    }
}
