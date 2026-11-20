package com.cohorly.android.replay

import org.json.JSONObject
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

// The recorder's own types (VEL-2142). Every file of this module but
// ReplayInstaller.kt and ControllerSessionSource.kt (the part that talks to
// the Cohorly SDK: the replay controller, the crash reporter, the core error
// buffer) imports only Android, AndroidX, curtains, org.json, Java and Kotlin,
// never `com.cohorly.android.core`, `com.cohorly.android.crash` or
// `com.cohorly.android.Cohorly`. Those files are copied byte for byte into
// packages/sdk-react-native/android/src/main/java/com/cohorly/android/replay/
// (`pnpm --filter @cohorly/react-native sync:replay`, an explicit file list in
// scripts/sync-replay-core.mjs), which compiles them against a cohorly-android
// release that has none of the `core.replay` types; a vitest test fails when
// the copies diverge, a file here is in neither list of that script, or a
// copied file imports the SDK. Edit them here, then run the sync.

/**
 * A serial executor for the recorder's work (the recorder thread). Same
 * shape as the SDK's `ReplayExecutor`; tests inject manual ones.
 */
internal interface ReplayWorker {
    fun execute(task: Runnable)

    fun schedule(delayMs: Long, task: Runnable)
}

/**
 * A daemon thread named [name], started on first use. After [shutdown],
 * tasks already queued with [execute] still run, delayed ones never do, and
 * new ones are ignored (never thrown at the caller).
 */
internal class ThreadReplayWorker(private val name: String) : ReplayWorker {
    private val executor: ScheduledThreadPoolExecutor by lazy {
        ScheduledThreadPoolExecutor(1) { runnable ->
            Thread(runnable, name).apply { isDaemon = true }
        }.apply { removeOnCancelPolicy = true }
    }

    private val delayed = Collections.newSetFromMap(ConcurrentHashMap<Future<*>, Boolean>())

    @Volatile
    private var shut = false

    override fun execute(task: Runnable) {
        try {
            executor.execute(task)
        } catch (e: RejectedExecutionException) {
            // Shut down: the recording this worker served is over.
        }
    }

    override fun schedule(delayMs: Long, task: Runnable) {
        if (shut) return
        val holder = arrayOfNulls<Future<*>>(1)
        val wrapped = Runnable {
            holder[0]?.let { delayed.remove(it) }
            if (!shut) task.run()
        }
        try {
            val future = executor.schedule(wrapped, delayMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
            holder[0] = future
            delayed.add(future)
            if (shut || future.isDone) delayed.remove(future)
        } catch (e: RejectedExecutionException) {
            // Shut down.
        }
    }

    /**
     * Ends the thread once the tasks queued with [execute] now have run.
     * Delayed tasks are cancelled here rather than by the executor's
     * shutdown policy: on older Android runtimes that policy also cancels
     * the zero-delay tasks [execute] queues.
     */
    fun shutdown() {
        shut = true
        for (future in delayed.toList()) future.cancel(false)
        delayed.clear()
        executor.shutdown()
    }
}

/** What a session records: everything, the buffer sent on errors, or nothing. The recorder's copy of `ReplayMode`. */
internal enum class RecorderMode {
    SESSION,
    ERROR,
    OFF,
}

/** What [RecorderErrorBuffer.cut] hands over: one chunk's events, from a Meta + FullSnapshot to the error. */
internal class RecorderErrorCut(val sessionId: String, val events: List<JSONObject>)

/**
 * The error-mode buffer (VEL-2151) as the recorder sees it: the events of a
 * session in error mode, kept in memory until an error sends them. The
 * implementation lives outside the recorder ([ReplaySessionSource.createErrorBuffer]);
 * a host with no error mode has none, and its sessions in error mode record
 * nothing. Thread-safe: the fatal crash handler cuts it from the crashing thread.
 */
internal interface RecorderErrorBuffer {
    /** The session the buffered events belong to, or null when empty and unbound. */
    val currentSessionId: String?

    /** How often a full snapshot is asked for while there is activity. */
    val checkoutEveryMs: Long

    /** Adds one group of events of [sessionId] (a Meta + FullSnapshot, a Mutation, a touch). */
    fun add(sessionId: String, events: List<JSONObject>)

    /** True when the recorder should force a full snapshot now. */
    fun checkoutDue(): Boolean

    /** How long until the next error may [cut] after the previous one; 0 = now. */
    fun nextSendDelayMs(): Long

    /** The window an error at now sends, or null (nothing new, not this session, no start). Empties the buffer. */
    fun cut(sessionId: String): RecorderErrorCut?

    /** Drops everything (a change of mode, a rotation, opt-out). */
    fun clear()
}
