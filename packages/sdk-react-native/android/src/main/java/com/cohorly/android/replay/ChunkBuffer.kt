package com.cohorly.android.replay

import org.json.JSONObject

/**
 * The events recorded since the last chunk, all of one session. Delivered
 * as one chunk [maxAgeMs] after its first event (a timer, so a quiet screen
 * still ships what it has), on [flush] (background, rotation), before an
 * event of another session is added, so a chunk never mixes sessions, and
 * before a group that would take it past [maxBytes] of JSON, so a chunk
 * stays under it (a single group bigger than that goes alone). Recorder
 * thread only: [executor] is that thread and runs the timer.
 *
 * @param deliver queues a chunk for [sessionId]; returns false when it was
 *   refused (the session ended, opt-out, quota): the events are dropped.
 */
internal class ChunkBuffer(
    private val executor: ReplayWorker,
    private val deliver: (events: List<JSONObject>, sessionId: String) -> Boolean,
    private val maxAgeMs: Long = MAX_AGE_MS,
    private val maxBytes: Int = MAX_BYTES,
) {
    private var sessionId: String? = null
    private val events = ArrayList<JSONObject>()
    private var bytes = 0

    /** Bumped by every delivery or discard, so a timer armed for an earlier chunk does nothing. */
    private var generation = 0L

    val size: Int get() = events.size

    fun add(sessionId: String, event: JSONObject) {
        addGroup(sessionId, listOf(event))
    }

    /**
     * Adds [group] to one chunk, never split across two: a Meta and the
     * FullSnapshot after it always travel together, or the player would get
     * a screen size with no screen.
     */
    fun addGroup(sessionId: String, group: List<JSONObject>) {
        if (group.isEmpty()) return
        if (this.sessionId != null && this.sessionId != sessionId) flush()
        // The JSON as it will be queued (the array's commas aside).
        val groupBytes = group.sumOf { it.toString().toByteArray(Charsets.UTF_8).size }
        if (events.isNotEmpty() && bytes + groupBytes > maxBytes) flush()
        this.sessionId = sessionId
        events.addAll(group)
        bytes += groupBytes
        if (events.size == group.size) {
            val armed = generation
            executor.schedule(maxAgeMs) { if (armed == generation) flush() }
        }
        if (bytes >= maxBytes) flush()
    }

    /** Delivers what is buffered now, if anything. */
    fun flush() {
        val id = sessionId
        if (events.isEmpty() || id == null) return
        val chunk = events.toList()
        clear()
        deliver(chunk, id)
    }

    /** Drops what is buffered (opt-out). */
    fun discard() {
        clear()
    }

    private fun clear() {
        events.clear()
        bytes = 0
        sessionId = null
        generation++
    }

    companion object {
        const val MAX_AGE_MS = 10_000L
        const val MAX_BYTES = 512 * 1024
    }
}
