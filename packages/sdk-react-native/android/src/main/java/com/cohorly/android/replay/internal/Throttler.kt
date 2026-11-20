// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/internal/Throttler.kt
// Changed: a monotonic deadline in ms (SystemClock.uptimeMillis, the Handler's own clock)
// instead of nanoTime rounded down, so two runs are never less than the interval apart;
// one pending run reads the latest state instead of a second run after it; the delayed
// post and the clock are injected (a main-thread Handler and SystemClock on a device,
// fakes in tests); single-threaded (main thread only).

package com.cohorly.android.replay.internal

/**
 * Runs a task at most once per [intervalMs], measured on [uptimeMillis].
 * A call inside the interval schedules one run at its end (never earlier);
 * further calls before that run add nothing, since the run reads the state
 * of that moment, which includes them. No call, no run. Main thread only.
 *
 * @param postDelayed posts a task after a delay in ms (a main-thread `Handler`).
 * @param uptimeMillis a monotonic clock in ms, the one [postDelayed] counts in.
 */
internal class Throttler(
    private val postDelayed: (Runnable, Long) -> Unit,
    private val uptimeMillis: () -> Long,
    private val intervalMs: Long,
) {
    private var lastRunAt: Long? = null
    private var scheduled = false

    fun throttle(runnable: Runnable) {
        if (scheduled) return
        val wait = remaining()
        if (wait <= 0L) {
            run(runnable)
        } else {
            schedule(runnable, wait)
        }
    }

    private fun remaining(): Long {
        val last = lastRunAt ?: return 0L
        return last + intervalMs - uptimeMillis()
    }

    private fun schedule(runnable: Runnable, delayMs: Long) {
        scheduled = true
        postDelayed(
            Runnable {
                val wait = remaining()
                if (wait > 0L) {
                    // Never early, whatever the Handler did.
                    schedule(runnable, wait)
                } else {
                    scheduled = false
                    run(runnable)
                }
            },
            delayMs,
        )
    }

    private fun run(runnable: Runnable) {
        lastRunAt = uptimeMillis()
        runnable.run()
    }
}
