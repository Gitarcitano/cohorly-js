// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt
// (onRootViewsChangedListener, addView, clearViewListeners, generateSnapshot, install/start/stop)
// Changed: one snapshot covers every window of the app (sorted by window type, the top one
// last), one shared throttle for draws while session starts, window changes and returns
// from background capture at once, the session and its rotations come from the recorder's
// host (ReplaySessionSource: the Cohorly replay controller, or the React Native bridge), events are buffered into chunks (ChunkBuffer) instead of captured as
// `$snapshot` events, a full snapshot is sent on every new session, return from background
// and change of screen structure, and touches are resolved against the last snapshot sent.
// Screenshots (VEL-2141) go through ScreenshotCapture.kt; the keyboard (VEL-2174) through
// Keyboard.kt; no logcat or network capture.

package com.cohorly.android.replay

import android.annotation.TargetApi
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.WindowManager
import com.cohorly.android.replay.internal.NextDrawListener
import com.cohorly.android.replay.internal.ScreenCapture
import com.cohorly.android.replay.internal.Throttler
import com.cohorly.android.replay.internal.ViewTreeSnapshotStatus
import com.cohorly.android.replay.rr.RREvent
import com.cohorly.android.replay.rr.RREventType
import com.cohorly.android.replay.rr.RRMouseInteraction
import com.cohorly.android.replay.rr.RRWireframe
import curtains.touchEventInterceptors
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * The wireframe session replay recorder (VEL-2139). One per Cohorly
 * instance, created by [ReplayInstaller]; in React Native, one per
 * recording, created by the bridge (VEL-2142). It knows the SDK only
 * through its host, [ReplaySessionSource]. The contract the screenshot/Compose
 * work (VEL-2141) and the error buffer (VEL-2151) build on:
 *
 * - **Windows.** Every root view curtains reports gets an
 *   `OnDrawListener` ([NextDrawListener]) and, when it has a `Window`
 *   (Activity, Dialog), a touch interceptor ([TouchRecorder]). A capture
 *   takes them bottom to top by window type ([zOrdered]); the screen name
 *   (Meta `href`) is the simple class name of the Activity of the highest
 *   application window.
 * - **Trigger.** Any draw of any window goes through one [Throttler]: never
 *   two draw captures less than [throttleDelayMs] apart, the end of a burst
 *   captured when the interval is over; no draw, no capture. A new session,
 *   a window added or removed and the return to foreground capture at once.
 * - **Capture** ([capture], main thread): only in foreground. Every visible
 *   window through [WireframeBuilder] into one [ScreenCapture]. The recorder
 *   thread ([worker]) turns it into events ([ViewTreeSnapshotStatus]: Meta +
 *   FullSnapshot on a new session, a return from background, a pause, a
 *   refused chunk, a chunk the queue dropped after taking it, a new screen
 *   structure, a reshaped tree or a changed view that overlaps a later
 *   sibling; else a Mutation with the diff, or nothing) and adds them to the
 *   [ChunkBuffer].
 * - **Screenshot mode** ([screenshots] set, VEL-2141): the capture is one
 *   masked image of the screen ([ScreenshotCapturer], asynchronous), sent as
 *   one `screenshot` wireframe whose id is fixed for the recording run; a new
 *   image is a Mutation `updates` of it, the same image nothing. Touches land
 *   on that wireframe.
 * - **Keyboard** (VEL-2174). Every capture, wireframe or screenshot, reads
 *   the keyboard from the windows' insets ([keyboardReader], height in dp);
 *   [KeyboardTracker] turns a change into `keyboard` custom events that
 *   follow the capture's snapshot events, and sends an open keyboard again
 *   after every full snapshot.
 * - **Touches.** Start/end with the position in dp, on the wireframe of the
 *   last snapshot sent under it (0 when none). A touch before its session's
 *   first full snapshot waits for it and follows it; a touch on a
 *   `FLAG_SECURE` window only counts as activity.
 * - **Mode.** Whether anything is recorded is decided in one place,
 *   [recordsIn]: [RecorderMode.SESSION] always, [RecorderMode.ERROR] only while
 *   the crash reporter runs in this process and the host gave an error
 *   buffer (VEL-2151).
 * - **Error mode** (VEL-2151). Events go to a [RecorderErrorBuffer] in
 *   memory (the host's, [ReplaySessionSource.createErrorBuffer]), never
 *   to the [ChunkBuffer]: nothing leaves the device without an error. Every
 *   [RecorderErrorBuffer.checkoutEveryMs] with activity the next capture is full.
 *   A crash report ([ReplaySessionSource.addCrashListener]) sends the
 *   buffer's cut: a watchdog ANR queues it on this thread, at most once per
 *   [RecorderErrorBuffer.nextSendDelayMs] (a later one waits), and a fatal crash writes
 *   it to disk on the crashing thread for the next launch. A change of mode,
 *   a rotation or an opt-out drops the buffer.
 * - **Chunks.** Every 10 s after a chunk's first event, before 512 KiB, on
 *   background and before another session's events, the buffer goes to
 *   `ReplayController.enqueue(events, SESSION, sessionId)`. A refused chunk,
 *   or one the queue drops later without delivering it
 *   (`ReplayController.droppedChunks` changed), makes the next capture full.
 * - **Session.** A rotation (heard from the controller, or seen by a capture
 *   first) flushes the old session's buffer, which the controller still
 *   takes for 60 s under the old id, and the next capture is full; null
 *   (opt-out) stops the recorder, removes every listener and drops the
 *   buffer; opt-in starts it again.
 */
@TargetApi(Build.VERSION_CODES.O)
internal class ReplayRecorder(
    private val application: Application,
    private val session: ReplaySessionSource,
    maskAllImages: Boolean,
    private val worker: ReplayWorker,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
    private val clock: () -> Long = System::currentTimeMillis,
    uptimeMillis: () -> Long = SystemClock::uptimeMillis,
    private val rootViewSource: RootViewSource = CurtainsRootViewSource,
    throttleDelayMs: Long = THROTTLE_DELAY_MS,
    chunkMaxAgeMs: Long = ChunkBuffer.MAX_AGE_MS,
    chunkMaxBytes: Int = ChunkBuffer.MAX_BYTES,
    /** Screenshot mode when set (VEL-2141), else wireframes. */
    private val screenshots: ScreenshotCapturer? = null,
    /** The keyboard over [capture]'s windows (bottom to top) at a density in px per dp (VEL-2174). */
    private val keyboardReader: (roots: List<View>, density: Float) -> KeyboardState = KeyboardReader::read,
) {
    // MARK: main thread state

    private val ids = ViewIdRegistry()
    private val builder = WireframeBuilder(ids, maskAllImages)
    private val throttler =
        Throttler({ task, delay -> mainHandler.postDelayed(task, delay) }, uptimeMillis, throttleDelayMs)

    /** The draw path: never run inside the draw itself, always on the next loop. */
    private val captureTask = Runnable { mainHandler.post { safely("capture") { capture() } } }

    private class Attachment(val draw: NextDrawListener, val touch: TouchRecorder?)

    private val attached = HashMap<View, Attachment>()
    private var started = false

    /** Following windows and capturing (a session exists). Main thread. */
    internal val isStarted: Boolean get() = started

    /** The next capture is sent whole (a new session, a return from background, a pause in recording). */
    private var needsFull = true
    private var startedActivities = 0

    /** [ReplaySessionSource.droppedChunks] at the last capture: a change makes the next one full. */
    private var seenDroppedChunks = 0L

    /** A screenshot was asked for while another was in flight: taken when that one ends. */
    private var screenshotWaiting = false

    /** Discarded screenshots taken again since the last draw or window change ([MAX_SCREENSHOT_RETRIES]). */
    private var screenshotRetries = 0

    /** The session the last capture was taken for: a capture that reads another one handles the rotation itself. */
    private var recordingSession: String? = null

    private val rootViewsListener: (View, Boolean) -> Unit = { view, added ->
        // Curtains calls before its list is updated: act on the next loop.
        mainHandler.post {
            if (!started) return@post
            screenshotRetries = 0
            safely("follow a window") {
                if (added) attach(view) else detach(view)
                captureSoon()
            }
        }
    }

    // MARK: recorder thread state

    private val status = ViewTreeSnapshotStatus()
    private val keyboard = KeyboardTracker()
    private val buffer = ChunkBuffer(worker, { events, id -> deliver(events, id) }, chunkMaxAgeMs, chunkMaxBytes)

    private class PendingTouch(
        val sessionId: String,
        val interaction: RRMouseInteraction,
        val x: Int,
        val y: Int,
        val timestamp: Long,
    )

    /** Touches of a session whose first full snapshot is not sent yet. */
    private val pendingTouches = ArrayDeque<PendingTouch>()

    private var removeSessionListener: (() -> Unit)? = null

    // MARK: error mode state (VEL-2151)

    /** The host's error-mode buffer; null: no error mode. Thread-safe: the fatal crash handler cuts it from the crashing thread. */
    private val errorBuffer: RecorderErrorBuffer? = session.createErrorBuffer(clock)

    /**
     * Where the recorder thread puts events: [RecorderMode.SESSION] (the
     * [ChunkBuffer]), [RecorderMode.ERROR] (the [errorBuffer]) or
     * [RecorderMode.OFF] (not synced yet, or dropped). Written on the recorder
     * thread, read by the fatal crash handler too.
     */
    @Volatile
    private var bufferMode: RecorderMode = RecorderMode.OFF

    /** A checkout was asked of the main thread and its Meta has not reached the error buffer yet. Recorder thread. */
    private var checkoutRequested = false

    /** A delayed error send is scheduled; errors until then join it. Recorder thread. */
    private var errorSendScheduled = false

    /** Bumped to stop the checkout timer. Recorder thread. */
    private var checkoutGeneration = 0L

    private var removeCrashListener: (() -> Unit)? = null

    /** An error report whose send waits for the next full snapshot of this session. Recorder thread. */
    private var errorRetrySession: String? = null

    /** Starts following the session; records while it is in a recording mode. Any thread. */
    fun install() {
        removeSessionListener = session.addSessionListener(::onSession)
        if (removeCrashListener == null) removeCrashListener = session.addCrashListener(::onCrashReport)
        runOnMain {
            application.registerActivityLifecycleCallbacks(lifecycle)
            // Installed after the app reached the screen: count what is already started.
            startedActivities = safelyOr(0) { visibleActivities() }
            if (session.sessionId != null) start()
        }
    }

    /** Stops for good (tests, a second install). Any thread. */
    fun uninstall() {
        removeSessionListener?.invoke()
        removeSessionListener = null
        removeCrashListener?.invoke()
        removeCrashListener = null
        runOnMain {
            application.unregisterActivityLifecycleCallbacks(lifecycle)
            stop()
        }
    }

    // MARK: session

    /** On the replay state thread: a new session id, or null on opt-out. */
    private fun onSession(sessionId: String?) {
        if (sessionId == null) {
            worker.execute { dropRecording() }
            mainHandler.post { stop() }
        } else {
            // The previous session's buffer goes before any event of the new
            // one, under its own id (the controller still takes it for 60 s).
            worker.execute {
                buffer.flush()
                // An error buffer is never carried into another session.
                errorBuffer?.clear()
                errorRetrySession = null
            }
            mainHandler.post {
                needsFull = true
                if (!started) start() else captureSoon()
            }
        }
    }

    private fun start() {
        if (started) return
        started = true
        needsFull = true
        seenDroppedChunks = safelyOr(seenDroppedChunks) { session.droppedChunks }
        screenshots?.start(ids.newId())
        safely("start") {
            rootViewSource.addListener(rootViewsListener)
            rootViewSource.rootViews().forEach(::attach)
            captureSoon()
        }
    }

    private fun stop() {
        if (!started) return
        started = false
        recordingSession = null
        safely("stop") {
            rootViewSource.removeListener(rootViewsListener)
            for (view in attached.keys.toList()) detach(view)
            screenshots?.stop()
        }
        worker.execute { dropRecording() }
    }

    /** Recorder thread: forgets the buffer, the screen sent and the waiting touches. */
    private fun dropRecording() {
        buffer.discard()
        errorBuffer?.clear()
        errorRetrySession = null
        bufferMode = RecorderMode.OFF
        checkoutGeneration++
        status.reset()
        keyboard.reset()
        pendingTouches.clear()
    }

    private fun attach(view: View) {
        if (attached.containsKey(view)) return
        val draw = NextDrawListener(view) {
            screenshots?.onDraw(view)
            screenshotRetries = 0
            if (started && recording()) throttler.throttle(captureTask)
        }
        draw.register()
        val window = view.phoneWindowOrNull()
        val touch = window?.let {
            TouchRecorder(view, { started && recording() }, ::onTouch, ::onSecureTouch)
        }
        if (window != null && touch != null) window.touchEventInterceptors += touch
        attached[view] = Attachment(draw, touch)
    }

    private fun detach(view: View) {
        val attachment = attached.remove(view) ?: return
        attachment.draw.unregister()
        attachment.touch?.let { touch ->
            safely("detach touches") {
                view.phoneWindowOrNull()?.let {
                    it.touchEventInterceptors -=
                        touch
                }
            }
        }
    }

    // MARK: capture

    /** A capture that does not wait for the throttle: a new session, a window change, the return to foreground. */
    private fun captureSoon() {
        if (started) mainHandler.post { safely("capture") { capture() } }
    }

    /** Main thread: the whole screen as wireframes, handed to the recorder thread. */
    internal fun capture() {
        if (!started) return
        if (startedActivities <= 0) {
            // In background: nothing is on screen, and the return sends a full snapshot.
            needsFull = true
            return
        }
        val sessionId = session.sessionId ?: return
        if (!recording()) {
            // Whatever is recorded next starts from a full snapshot.
            needsFull = true
            return
        }
        val recorded = recordingSession
        if (recorded != null && recorded != sessionId) {
            // The session rotated and its listener has not run yet (another
            // thread): the old buffer goes first, under its own id, and the
            // new session starts whole, never with a Mutation.
            worker.execute { buffer.flush() }
            needsFull = true
        }
        recordingSession = sessionId
        val dropped = session.droppedChunks
        if (dropped != seenDroppedChunks) {
            // The queue dropped chunks this buffer had already handed over: the
            // server may lack the snapshot the next Mutation would build on.
            seenDroppedChunks = dropped
            needsFull = true
        }
        val metrics = application.resources.displayMetrics
        val roots = zOrdered(rootViewSource.rootViews())
        val keyboardState = readKeyboard(roots, metrics.density)
        if (screenshots != null) {
            captureScreenshot(screenshots, sessionId, roots, metrics.density, keyboardState)
            return
        }
        builder.density = metrics.density
        val wireframes = ArrayList<RRWireframe>()
        for (root in roots) {
            val wireframe = try {
                builder.window(root, root.isSecureWindow())
            } catch (e: Exception) {
                Log.w(TAG, "Cohorly session replay could not read a window: $e")
                null
            } ?: continue
            wireframes.add(wireframe)
        }
        if (wireframes.isEmpty()) return
        val topActivity = topActivity(roots)
        val (width, height) = screenSizeDp(topActivity, metrics.density)
        val href = topActivity?.javaClass?.simpleName ?: topWindowTitle(roots)
        val screenKey: List<Any> = wireframes.map { it.id } + listOf(href, width, height)
        val forceFull = needsFull
        needsFull = false
        val capture =
            ScreenCapture(sessionId, clock(), width, height, href, screenKey, wireframes, forceFull, keyboardState)
        worker.execute { record(capture) }
    }

    /** Main thread: the keyboard now; a reader that fails reads as closed, never stops the capture. */
    private fun readKeyboard(roots: List<View>, density: Float): KeyboardState = try {
        keyboardReader(roots, density)
    } catch (_: Throwable) {
        KeyboardState.CLOSED
    }

    /**
     * Main thread: the screenshot path of [capture]. The image comes back on
     * the recorder thread and goes through [record] as one `screenshot`
     * wireframe; a discarded frame keeps the next one full when this one had
     * to be, and is tried again after the throttle.
     */
    private fun captureScreenshot(
        capturer: ScreenshotCapturer,
        sessionId: String,
        roots: List<View>,
        density: Float,
        keyboardState: KeyboardState,
    ) {
        val topActivity = topActivity(roots)
        val (width, height) = screenSizeDp(topActivity, density)
        val (originX, originY) = windowOriginPx(topActivity)
        val href = topActivity?.javaClass?.simpleName ?: topWindowTitle(roots)
        val forceFull = needsFull
        val timestamp = clock()
        val accepted = capturer.capture(
            roots,
            (width * density).roundToInt(),
            (height * density).roundToInt(),
            density,
            originX,
            originY,
        ) { image ->
            val base64 = image?.let { bitmap ->
                try {
                    capturer.encode(bitmap)
                } finally {
                    bitmap.recycle()
                }
            }
            if (base64 != null) {
                val wireframe = capturer.toScreenshotWireframe(base64, width, height)
                val screenKey = listOf<Any>(ScreenshotCapturer.SCREENSHOT, href, width, height)
                record(
                    ScreenCapture(
                        sessionId,
                        timestamp,
                        width,
                        height,
                        href,
                        screenKey,
                        listOf(wireframe),
                        forceFull,
                        keyboardState,
                    ),
                )
            }
            mainHandler.post {
                if (base64 == null && forceFull) needsFull = true
                // A still screen that keeps failing is not taken again forever: a draw or window change resets it.
                val retry = base64 == null && screenshotRetries < MAX_SCREENSHOT_RETRIES
                if (base64 != null) {
                    screenshotRetries = 0
                } else if (retry) {
                    screenshotRetries++
                }
                if (started && (retry || screenshotWaiting)) {
                    screenshotWaiting = false
                    throttler.throttle(captureTask)
                }
            }
        }
        // Busy with the previous image: this one is taken when it ends.
        if (accepted) needsFull = false else screenshotWaiting = true
    }

    /** Recorder thread. */
    private fun record(capture: ScreenCapture) {
        // Rotated or opted out since the capture: it belongs to no live session.
        if (session.sessionId != capture.sessionId) return
        safely("record") {
            syncMode()
            val snapshot = status.snapshotEvents(capture)
            val full = snapshot.firstOrNull()?.optInt("type") == RREventType.Meta.value
            // After the snapshot, in the same group: a full snapshot clears the player's keyboard.
            val events = snapshot + keyboard.events(capture.keyboard, capture.timestamp, full)
            if (events.isEmpty()) return@safely
            push(capture.sessionId, events)
            if (full) releasePendingTouches(capture)
        }
    }

    /** Recorder thread: the touches that waited for [capture]'s full snapshot, right after it. */
    private fun releasePendingTouches(capture: ScreenCapture) {
        while (pendingTouches.isNotEmpty()) {
            val touch = pendingTouches.removeFirst()
            if (touch.sessionId != capture.sessionId) continue
            val id = status.hitTest(touch.x, touch.y)
            // Never before the snapshot it lands on, or the player has nothing to show it on.
            val timestamp = maxOf(touch.timestamp, capture.timestamp)
            push(capture.sessionId, listOf(RREvent.touch(touch.interaction, id, touch.x, touch.y, timestamp)))
        }
    }

    /** Main thread, from a [TouchRecorder]: a touch at a screen point in px. */
    private fun onTouch(interaction: RRMouseInteraction, rawX: Float, rawY: Float) {
        if (!started) return
        session.recordActivity()
        // Read after the activity: it may have started a new session.
        val sessionId = session.sessionId ?: return
        val density = application.resources.displayMetrics.density
        val x = (rawX / density).toInt()
        val y = (rawY / density).toInt()
        val timestamp = clock()
        // A session the recorder has not captured yet: capture it now, the touch follows it.
        if (sessionId != recordingSession) captureSoon()
        worker.execute {
            if (session.sessionId != sessionId) return@execute
            if (status.hasFullSnapshot(sessionId)) {
                push(sessionId, listOf(RREvent.touch(interaction, status.hitTest(x, y), x, y, timestamp)))
            } else {
                if (pendingTouches.size >= MAX_PENDING_TOUCHES) pendingTouches.removeFirst()
                pendingTouches.addLast(PendingTouch(sessionId, interaction, x, y, timestamp))
            }
        }
    }

    /** Main thread: a touch on a `FLAG_SECURE` window is activity, never an event. */
    private fun onSecureTouch() {
        if (started) session.recordActivity()
    }

    /** Recorder thread, from the [ChunkBuffer]. */
    private fun deliver(events: List<JSONObject>, sessionId: String): Boolean {
        val queued = session.enqueue(events, sessionId)
        if (!queued) {
            Log.d(TAG, "Cohorly session replay dropped a chunk of ${events.size} events (session ended or paused)")
            // The player never got what the next diff would build on: start whole again.
            if (status.tracks(sessionId)) status.reset()
        }
        return queued
    }

    // MARK: error mode (VEL-2151)

    /** Recorder thread: one group of events to where the current mode keeps them. */
    private fun push(sessionId: String, group: List<JSONObject>) {
        if (currentMode() != bufferMode) {
            // The mode changed since the last capture (a quota pause began or
            // ended): switch now, and a lone touch, with no snapshot of this
            // mode under it, goes nowhere; the switch makes the next capture full.
            syncMode()
            if (group.first().optInt("type") != RREventType.Meta.value) return
        }
        if (bufferMode != RecorderMode.ERROR) {
            buffer.addGroup(sessionId, group)
            return
        }
        // Error mode with no buffer records nothing (recording() is false then too).
        val errors = errorBuffer ?: return
        if (group.first().optInt("type") == RREventType.Meta.value) checkoutRequested = false
        errors.add(sessionId, group)
        requestCheckoutIfDue()
        val waiting = errorRetrySession
        if (waiting == sessionId && group.first().optInt("type") == RREventType.Meta.value) {
            errorRetrySession = null
            sendErrorBuffer(waiting)
        }
    }

    /** The mode the error/session buffers follow: error while the host reads [RecorderMode.ERROR], else session. */
    private fun currentMode(): RecorderMode =
        if (session.mode == RecorderMode.ERROR) RecorderMode.ERROR else RecorderMode.SESSION

    /**
     * Recorder thread, before each capture is turned into events: follows the
     * session's mode. A change (session to error on a quota pause, back when
     * it ends) drops what the other mode held and makes this capture full.
     */
    private fun syncMode() {
        val mode = currentMode()
        if (mode == bufferMode) return
        errorRetrySession = null
        val was = bufferMode
        if (was == RecorderMode.SESSION) buffer.flush()
        errorBuffer?.clear()
        if (was != RecorderMode.OFF) status.reset()
        checkoutRequested = false
        bufferMode = mode
        checkoutGeneration++
        if (mode == RecorderMode.ERROR) scheduleCheckout(checkoutGeneration)
    }

    /** Recorder thread: every [RecorderErrorBuffer.checkoutEveryMs] while in error mode. */
    private fun scheduleCheckout(generation: Long) {
        val errors = errorBuffer ?: return
        worker.schedule(errors.checkoutEveryMs) {
            if (generation != checkoutGeneration || bufferMode != RecorderMode.ERROR) return@schedule
            safely("check out") { requestCheckoutIfDue() }
            scheduleCheckout(generation)
        }
    }

    /** Recorder thread: a full snapshot when the error buffer asks for one (activity, 30 s, or over its bound). */
    private fun requestCheckoutIfDue() {
        val errors = errorBuffer ?: return
        if (bufferMode != RecorderMode.ERROR || checkoutRequested || !errors.checkoutDue()) return
        checkoutRequested = true
        requestFullCapture()
    }

    /** Any thread: the next capture is Meta + FullSnapshot, and it happens now. */
    private fun requestFullCapture() {
        mainHandler.post {
            needsFull = true
            captureSoon()
        }
    }

    /**
     * Any thread: the next capture is Meta + FullSnapshot, taken now (the
     * React Native bridge's `replayCheckout`). Nothing while stopped.
     */
    fun checkout() {
        requestFullCapture()
    }

    /**
     * Any thread: hands what the [ChunkBuffer] holds to the host now instead
     * of at its timer, then runs [then] on the recorder thread, after every
     * task queued there before this call (the React Native bridge's
     * `replayDrain`). [then] still runs when the recorder thread is shut down
     * after this call, never when it already was.
     */
    fun flushChunks(then: () -> Unit) {
        worker.execute {
            safely("flush") { buffer.flush() }
            then()
        }
    }

    /**
     * From the crash reporter, after it wrote a report. Fatal: on the
     * crashing thread, synchronously (the process dies next). Else (a
     * watchdog ANR): on the recorder thread.
     */
    private fun onCrashReport(fatal: Boolean) {
        // The session the report was stamped with, read now: a rotation after
        // it must never send another session's buffer for this error.
        val reported = try {
            session.reportSessionId
        } catch (_: Throwable) {
            null
        } ?: return
        if (fatal) {
            writeErrorBufferNow(reported)
        } else {
            worker.execute { safely("send the error buffer") { onErrorReport(reported) } }
        }
    }

    /**
     * Crashing thread: the cut goes to disk now, under [sessionId], the
     * session the crash report was stamped with, and the next launch sends
     * it. Ignores [RecorderErrorBuffer.nextSendDelayMs]. Never throws.
     */
    private fun writeErrorBufferNow(sessionId: String) {
        try {
            if (bufferMode != RecorderMode.ERROR) return
            val cut = errorBuffer?.cut(sessionId) ?: return
            session.enqueueErrorNow(cut.events, cut.sessionId)
        } catch (_: Throwable) {
            // The crash must reach the app's handler whatever happens here.
        }
    }

    /** Recorder thread: a non-fatal report. The buffer goes now, or once [RecorderErrorBuffer.nextSendDelayMs] is over. */
    private fun onErrorReport(sessionId: String) {
        val errors = errorBuffer ?: return
        if (bufferMode != RecorderMode.ERROR || errorSendScheduled) return
        val wait = errors.nextSendDelayMs()
        if (wait <= 0L) {
            sendErrorBuffer(sessionId)
            return
        }
        errorSendScheduled = true
        worker.schedule(wait) {
            errorSendScheduled = false
            safely("send the error buffer") { sendErrorBuffer(sessionId) }
        }
    }

    /** Recorder thread: queues the cut of the current session, then starts buffering again from a full snapshot. */
    private fun sendErrorBuffer(sessionId: String) {
        // Only the reported session's buffer, and only while it is still the one recorded.
        val errors = errorBuffer ?: return
        if (bufferMode != RecorderMode.ERROR || session.sessionId != sessionId) return
        if (errors.currentSessionId != sessionId) return
        val cut = errors.cut(sessionId)
        if (cut == null) {
            // Nothing new since the last send, or no snapshot to start from yet:
            // in the second case the send waits for the full snapshot it asks for.
            if (errors.checkoutDue()) errorRetrySession = sessionId
            requestCheckoutIfDue()
            return
        }
        if (!session.enqueueError(cut.events, cut.sessionId)) {
            Log.d(TAG, "Cohorly session replay dropped an error buffer of ${cut.events.size} events")
        }
        // The buffer is empty: the next events build on a new full snapshot.
        status.reset()
        checkoutRequested = true
        requestFullCapture()
    }

    // MARK: app lifecycle

    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            startedActivities++
            if (startedActivities == 1 && !activity.isChangingConfigurations) {
                needsFull = true
                captureSoon()
            }
        }

        override fun onActivityStopped(activity: Activity) {
            if (startedActivities > 0) startedActivities--
            if (startedActivities == 0 && !activity.isChangingConfigurations) {
                // Ship what is buffered; a capture still waiting on the main
                // thread finds the app in background and does nothing.
                needsFull = true
                worker.execute { buffer.flush() }
            }
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }

    // MARK: helpers

    /** [recordsIn] for the session now; error mode needs an error buffer too. Any thread. */
    private fun recording(): Boolean = recordsIn(session.mode, errorBuffer != null && session.errorReportsOn)

    /** Activities with a visible window now, for a recorder installed after they started. */
    private fun visibleActivities(): Int = rootViewSource.rootViews()
        .filter { it.isApplicationWindow && it.windowVisibility == View.VISIBLE }
        .mapNotNull { activityOf(it) }
        .distinct()
        .size

    /** The Activity of the highest visible application window (a Dialog's is the Activity that shows it). */
    private fun topActivity(roots: List<View>): Activity? {
        val visible = roots.filter { it.windowVisibility == View.VISIBLE }
        for (root in visible.asReversed()) {
            if (!root.isApplicationWindow) continue
            activityOf(root)?.let { return it }
        }
        for (root in visible.asReversed()) activityOf(root)?.let { return it }
        return null
    }

    /**
     * The Activity a root view belongs to. The decor view's own context is
     * not the Activity (a DecorContext on API 24+), so the window is asked
     * first: its callback is the Activity of an Activity window, its context
     * the Activity of a Dialog.
     */
    private fun activityOf(root: View): Activity? {
        val window = root.phoneWindowOrNull()
        (window?.callback as? Activity)?.let { return it }
        window?.context?.activity()?.let { return it }
        return root.context.activity()
    }

    /** The screen name when no Activity owns a window: the simple name in the top window's title. */
    private fun topWindowTitle(roots: List<View>): String {
        val title = roots.lastOrNull()?.let { (it.layoutParams as? WindowManager.LayoutParams)?.title?.toString() }
        return title?.substringAfterLast('/')?.substringAfterLast('.') ?: ""
    }

    private fun Context.activity(): Activity? {
        var context: Context? = this
        while (context is ContextWrapper) {
            if (context is Activity) return context
            context = context.baseContext
        }
        return null
    }

    /** The screen (the top Activity's window, which is the whole screen outside multi-window) in dp. */
    @Suppress("DEPRECATION")
    private fun screenSizeDp(activity: Activity?, density: Float): Pair<Int, Int> {
        val (widthPx, heightPx) = try {
            val windowManager = activity?.windowManager
            when {
                windowManager == null -> application.resources.displayMetrics.let { it.widthPixels to it.heightPixels }
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ->
                    windowManager.currentWindowMetrics.bounds.let { it.width() to it.height() }
                else -> android.util.DisplayMetrics().also { windowManager.defaultDisplay.getRealMetrics(it) }
                    .let { it.widthPixels to it.heightPixels }
            }
        } catch (_: Exception) {
            application.resources.displayMetrics.let { it.widthPixels to it.heightPixels }
        }
        return (widthPx / density).toInt() to (heightPx / density).toInt()
    }

    /**
     * Where the top Activity's window starts on the display, in px: not 0 in
     * a bottom or right split-screen pane or a freeform window (API 30+).
     */
    private fun windowOriginPx(activity: Activity?): Pair<Int, Int> = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && activity != null) {
            activity.windowManager.currentWindowMetrics.bounds.let { it.left to it.top }
        } else {
            0 to 0
        }
    } catch (_: Exception) {
        0 to 0
    }

    /** Recording never crashes the app: a failure is logged and that step is skipped. */
    private inline fun safely(step: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            Log.w(TAG, "Cohorly session replay could not $step: $e")
        }
    }

    private inline fun <T> safelyOr(fallback: T, block: () -> T): T = try {
        block()
    } catch (_: Exception) {
        fallback
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    companion object {
        const val TAG = "CohorlyReplay"
        const val THROTTLE_DELAY_MS = 1_000L

        /** Touches kept while their session waits for its first full snapshot; older ones go. */
        const val MAX_PENDING_TOUCHES = 20

        /** Discarded screenshots taken again in a row with no draw or window change between them. */
        const val MAX_SCREENSHOT_RETRIES = 3

        /**
         * The one place that decides whether a session records, from its
         * [RecorderMode]: [RecorderMode.SESSION] always; [RecorderMode.ERROR] only
         * when [errorReportsOn] (the crash reporter runs in this process,
         * so an error can send the buffer); [RecorderMode.OFF] never.
         */
        fun recordsIn(mode: RecorderMode, errorReportsOn: Boolean): Boolean =
            mode == RecorderMode.SESSION || (mode == RecorderMode.ERROR && errorReportsOn)
    }
}
