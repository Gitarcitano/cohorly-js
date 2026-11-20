package com.cohorly.reactnative

import android.app.Application
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cohorly.android.replay.PixelCopySource
import com.cohorly.android.replay.RecorderMode
import com.cohorly.android.replay.ReplayRecorder
import com.cohorly.android.replay.ReplaySessionSource
import com.cohorly.android.replay.ScreenshotCapturer
import com.cohorly.android.replay.ThreadReplayWorker
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import org.json.JSONArray
import org.json.JSONObject

/**
 * Session replay recording for React Native on Android (VEL-2142),
 * `NativeModules.CohorlyReactNativeReplay`, same contract as the iOS module
 * (ios/CohorlyReactNativeReplay.swift). The recorder under
 * android/src/main/java/com/cohorly/android/replay/ is a copy of
 * sdks/android/cohorly-replay (`sync:replay`); this file is its host.
 *
 * Inert until `replayStart`: no thread, listener or window hook exists
 * before. Pull model: the native side never emits to JS. It records as if
 * every session were in "session" mode, because the JS layer owns the
 * session id, the sampling draw, the error buffer and the upload; the events
 * carry no session (JS adds `$session_id` when it uploads). Each delivery of
 * the recorder (a chunk: up to 10 s or 512 KiB of events, Meta + FullSnapshot,
 * Mutations, touches) is one JSON array of rrweb mobile events
 * (docs/SESSION-REPLAY.md "Mobile") in an in-memory list that `replayDrain`
 * empties. No `Cohorly` instance is needed. Records on API 26+ only.
 *
 * Nothing throws to JS: every method resolves (start resolves false on any
 * failure).
 */
class CohorlyReactNativeReplay(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    /**
     * Who started the recording: only this instance (the live bridge) may
     * drain, checkout or stop it, so a torn down bridge never touches the
     * recording of the bridge that replaced it.
     */
    private val owner = Any()

    override fun getName(): String = NAME

    /**
     * `configJson`: `{"mode":"screenshot"|"wireframe","maskAllImages":bool}`.
     * Resolves true when recording started, false when this device cannot
     * record (API < 26) or the start failed. Never rejects. Called while
     * recording: restarts with the new config, from a Meta + FullSnapshot.
     */
    @ReactMethod
    fun replayStart(configJson: String?, promise: Promise) {
        val started = try {
            ReactNativeReplayRecording.start(reactContext.applicationContext, configJson, owner)
        } catch (e: Throwable) {
            Log.w(TAG, "Cohorly session replay could not start", e)
            false
        }
        promise.resolve(started)
    }

    /** Stops capturing and discards every pending event. Idempotent. No-op when another instance owns the recording. */
    @ReactMethod
    fun replayStop(promise: Promise) {
        try {
            ReactNativeReplayRecording.stop(owner)
        } catch (e: Throwable) {
            Log.w(TAG, "Cohorly session replay could not stop", e)
        }
        promise.resolve(null)
    }

    /** The next capture is Meta + FullSnapshot, taken now. No-op when stopped or owned by another instance. */
    @ReactMethod
    fun replayCheckout(promise: Promise) {
        try {
            ReactNativeReplayRecording.checkout(owner)
        } catch (e: Throwable) {
            Log.w(TAG, "Cohorly session replay checkout failed", e)
        }
        promise.resolve(null)
    }

    /**
     * The pending batches in capture order, each a JSON string of an array of
     * rrweb mobile events; the list is emptied. What the recorder still holds
     * (its chunk buffer) is handed over first. `[]` when stopped, empty or
     * owned by another instance.
     */
    @ReactMethod
    fun replayDrain(promise: Promise) {
        try {
            ReactNativeReplayRecording.drain(owner) { batches -> promise.resolve(toArray(batches)) }
        } catch (e: Throwable) {
            Log.w(TAG, "Cohorly session replay drain failed", e)
            promise.resolve(Arguments.createArray())
        }
    }

    /**
     * The bridge goes away (a JS reload, the host torn down). The recording
     * this instance started stops, so no recorder keeps capturing for a JS
     * that is gone; the next JS starts its own. An instance that does not own
     * the recording (the new bridge already started one) leaves it alone.
     */
    override fun invalidate() {
        try {
            ReactNativeReplayRecording.stop(owner)
        } catch (e: Throwable) {
            Log.w(TAG, "Cohorly session replay could not stop", e)
        }
        super.invalidate()
    }

    private fun toArray(batches: List<String>): WritableArray {
        val array = Arguments.createArray()
        for (batch in batches) array.pushString(batch)
        return array
    }

    companion object {
        const val NAME = "CohorlyReactNativeReplay"
        internal const val TAG = "CohorlyReplay"
    }
}

/**
 * The one recording of the process (a module instance per bridge, one
 * screen), and the recorder's host.
 *
 * Locks: every transition (start, stop, checkout, drain) runs whole under
 * `controlLock`, the owner check included, so nothing can change the owner
 * between "is it mine" and the action. It is only ever taken by the module's
 * methods (the native modules thread, `invalidate`'s thread), never by the
 * recorder's threads, and nothing under it waits for another thread: the
 * recorder's `uninstall` and `checkout` only post to the main thread, and
 * `drain` queues its answer on the recorder thread and returns. `lock`
 * guards the pending list, its byte count and `dropped`; the recorder
 * thread (each delivery) and the main thread (`droppedChunks`) take it, the
 * module takes it inside `controlLock`, never the other way, and nothing
 * holding it calls out. So there is no cycle.
 */
internal object ReactNativeReplayRecording {
    /** Cap on the sum of the pending JSON strings, in UTF-8 bytes. */
    const val MAX_PENDING_BYTES = 5 * 1024 * 1024

    /** The recorder keys its state by session; the JS layer owns the real one. */
    const val PLACEHOLDER_SESSION_ID = "react-native"

    /** The thread serialization, chunk building and the 10 s timer run on. */
    private const val RECORDER_THREAD = "cohorly-rn-replay-recorder"

    /** WebP quality of a screenshot, as cohorly-android's default (`SessionReplayConfig`). */
    private const val SCREENSHOT_QUALITY = 30

    private val controlLock = Any()
    private var recorder: ReplayRecorder? = null
    private var worker: ThreadReplayWorker? = null
    private var host: Host? = null
    private var owner: Any? = null

    private val lock = Any()
    private val pending = ArrayDeque<String>()
    private var pendingBytes = 0L

    /**
     * Bumped each time batches are dropped: the recorder's next capture is
     * then full ([ReplaySessionSource.droppedChunks]). Never decreases.
     */
    @Volatile
    private var dropped = 0L

    internal class Config(val wireframe: Boolean, val maskAllImages: Boolean)

    /** Unknown or missing mode: screenshot; anything but a boolean `maskAllImages`: true. Never fails. */
    internal fun parse(json: String?): Config {
        val obj = try {
            if (json == null) null else JSONObject(json)
        } catch (e: Throwable) {
            null
        }
        val wireframe = obj?.opt("mode") == "wireframe"
        val maskAllImages = (obj?.opt("maskAllImages") as? Boolean) ?: true
        return Config(wireframe, maskAllImages)
    }

    fun start(context: android.content.Context, configJson: String?, by: Any): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Log.w(
                CohorlyReactNativeReplay.TAG,
                "Cohorly session replay needs Android 8.0 (API 26) or newer; not recording.",
            )
            return false
        }
        val application = context as? Application ?: return false
        val config = parse(configJson)
        synchronized(controlLock) {
            stopRecording()
            // A new start is a new config and a new session in JS: nothing
            // captured before it may be drained into it.
            synchronized(lock) { clearPending() }
            val worker = ThreadReplayWorker(RECORDER_THREAD)
            val host = Host()
            try {
                val mainHandler = Handler(Looper.getMainLooper())
                val screenshots = if (config.wireframe) {
                    null
                } else {
                    ScreenshotCapturer(
                        maskAllImages = config.maskAllImages,
                        quality = SCREENSHOT_QUALITY,
                        source = PixelCopySource(mainHandler),
                        worker = worker,
                        mainHandler = mainHandler,
                    )
                }
                val recorder = ReplayRecorder(
                    application = application,
                    session = host,
                    maskAllImages = config.maskAllImages,
                    worker = worker,
                    mainHandler = mainHandler,
                    screenshots = screenshots,
                )
                this.recorder = recorder
                this.worker = worker
                this.host = host
                this.owner = by
                recorder.install()
            } catch (e: Throwable) {
                stopRecording()
                owner = null
                host.running = false
                worker.shutdown()
                throw e
            }
            return true
        }
    }

    /** Stops the recording and discards what is pending, when [by] owns it (or nobody does). */
    fun stop(by: Any) {
        synchronized(controlLock) {
            val current = owner
            if (current != null && current !== by) return
            stopRecording()
            owner = null
            synchronized(lock) { clearPending() }
        }
    }

    fun checkout(by: Any) {
        synchronized(controlLock) {
            if (owner !== by) return
            // Only posts to the main thread.
            recorder?.checkout()
        }
    }

    /**
     * Answers [resolve] with the pending batches, on the recorder thread once
     * the chunk buffer is handed over, or at once with `[]` when [by] does not
     * own a running recording.
     */
    fun drain(by: Any, resolve: (List<String>) -> Unit) {
        synchronized(controlLock) {
            val recorder = this.recorder
            val host = this.host
            if (owner !== by || recorder == null || host == null) {
                resolve(emptyList())
                return
            }
            // The worker is live here (stop takes controlLock too), and its
            // shutdown still runs what was queued with execute: the answer
            // always comes. A drain overtaken by a stop or a new start finds
            // its host stopped and answers [], never the next recording's events.
            recorder.flushChunks {
                val batches = try {
                    synchronized(lock) { if (host.running) takePending() else emptyList() }
                } catch (e: Throwable) {
                    emptyList()
                }
                resolve(batches)
            }
        }
    }

    /** Under `controlLock`. The caller decides what happens to the pending events (`start` and `stop` both discard them). */
    private fun stopRecording() {
        val recorder = this.recorder
        val worker = this.worker
        // Deliveries still on their way from this recording are refused from now on.
        host?.running = false
        this.recorder = null
        this.worker = null
        this.host = null
        try {
            recorder?.uninstall()
        } finally {
            // Tasks already queued (a drain's answer) still run; the thread ends after them.
            worker?.shutdown()
        }
    }

    /** Under `lock`. */
    private fun clearPending() {
        pending.clear()
        pendingBytes = 0
    }

    /** Under `lock`. */
    private fun takePending(): List<String> {
        val out = ArrayList(pending)
        clearPending()
        return out
    }

    /**
     * The recorder thread: one delivery, encoded and appended. Over the cap,
     * the oldest batches go (counted in [dropped], so the next capture is
     * full); a delivery bigger than the cap alone is refused (the recorder
     * then starts whole again). False while [host] is not the running one.
     */
    private fun admit(host: Host, events: List<JSONObject>): Boolean {
        if (events.isEmpty()) return true
        val json = JSONArray(events).toString()
        val bytes = utf8Length(json)
        synchronized(lock) {
            if (!host.running) return false
            if (bytes > MAX_PENDING_BYTES) {
                Log.w(CohorlyReactNativeReplay.TAG, "Cohorly session replay dropped a chunk of $bytes bytes (over the pending cap)")
                return false
            }
            var droppedNow = false
            while (pendingBytes + bytes > MAX_PENDING_BYTES && pending.isNotEmpty()) {
                pendingBytes -= utf8Length(pending.removeFirst())
                droppedNow = true
            }
            if (droppedNow) {
                dropped++
                Log.w(CohorlyReactNativeReplay.TAG, "Cohorly session replay dropped pending chunks: JS did not drain them in time")
            }
            pending.addLast(json)
            pendingBytes += bytes
            return true
        }
    }

    private fun utf8Length(text: String): Long {
        var count = 0L
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c.code < 0x80 -> count += 1
                c.code < 0x800 -> count += 2
                Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1]) -> {
                    count += 4
                    i++
                }
                else -> count += 3
            }
            i++
        }
        return count
    }

    /**
     * One recording's session source: a fixed placeholder session in session
     * mode, no rotations, no error mode (JS owns both), no activity tracking.
     */
    private class Host : ReplaySessionSource {
        @Volatile
        var running = true

        override val sessionId: String get() = PLACEHOLDER_SESSION_ID
        override val mode: RecorderMode get() = RecorderMode.SESSION
        override val droppedChunks: Long get() = ReactNativeReplayRecording.dropped

        override fun addSessionListener(listener: (String?) -> Unit): () -> Unit = {}

        override fun recordActivity() {
            // JS tracks activity itself.
        }

        override fun enqueue(events: List<JSONObject>, sessionId: String): Boolean =
            ReactNativeReplayRecording.admit(this, events)
    }
}
