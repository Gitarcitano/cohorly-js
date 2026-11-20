// Adapted from PostHog/posthog-android (MIT): posthog/src/main/java/com/posthog/internal/replay/
// RREvent.kt, RREventType.kt, RRIncrementalSource.kt, RRMouseInteraction.kt, RRMetaEvent.kt,
// RRFullSnapshotEvent.kt, RRIncrementalSnapshotEvent.kt, RRIncrementalMutationData.kt,
// RRMutatedNode.kt, RRRemovedNode.kt, RRIncrementalMouseInteractionData.kt,
// RRIncrementalMouseInteractionEvent.kt
// Changed: one file, events built straight into org.json objects (no Gson), only the
// event types the wireframe recorder sends.

package com.cohorly.android.replay.rr

import org.json.JSONArray
import org.json.JSONObject

/** rrweb event types (`type`). */
internal enum class RREventType(val value: Int) {
    FullSnapshot(2),
    IncrementalSnapshot(3),
    Meta(4),
}

/** rrweb incremental sources (`data.source`). */
internal enum class RRIncrementalSource(val value: Int) {
    Mutation(0),
    MouseInteraction(2),
}

/** rrweb mouse interactions (`data.type`) a touch maps to. */
internal enum class RRMouseInteraction(val value: Int) {
    TouchStart(7),
    TouchEnd(9),
}

/** A Mutation `adds`/`updates` entry. */
internal class RRMutatedNode(val wireframe: RRWireframe, val parentId: Int)

/** A Mutation `removes` entry. */
internal class RRRemovedNode(val id: Int, val parentId: Int)

/** Builders for the rrweb events of the mobile format (docs/SESSION-REPLAY.md, "Events"). */
internal object RREvent {
    private fun event(type: RREventType, timestamp: Long, data: JSONObject): JSONObject =
        JSONObject().put("type", type.value).put("timestamp", timestamp).put("data", data)

    /** Type 4: the screen size in dp and the screen name. */
    fun meta(width: Int, height: Int, href: String, timestamp: Long): JSONObject =
        event(RREventType.Meta, timestamp, JSONObject().put("href", href).put("width", width).put("height", height))

    /** Type 2: the whole screen. */
    fun fullSnapshot(wireframes: List<RRWireframe>, timestamp: Long): JSONObject = event(
        RREventType.FullSnapshot,
        timestamp,
        JSONObject()
            .put("wireframes", JSONArray().apply { wireframes.forEach { put(it.toJson()) } })
            .put("initialOffset", JSONObject().put("top", 0).put("left", 0)),
    )

    /** Type 3, source 0. Null when the three lists are empty: no difference, no event. */
    fun mutation(
        adds: List<RRMutatedNode>,
        removes: List<RRRemovedNode>,
        updates: List<RRMutatedNode>,
        timestamp: Long,
    ): JSONObject? {
        if (adds.isEmpty() && removes.isEmpty() && updates.isEmpty()) return null
        val data = JSONObject().put("source", RRIncrementalSource.Mutation.value)
        if (adds.isNotEmpty()) data.put("adds", JSONArray().apply { adds.forEach { put(it.toJson()) } })
        if (removes.isNotEmpty()) {
            data.put(
                "removes",
                JSONArray().apply {
                    removes.forEach { put(JSONObject().put("parentId", it.parentId).put("id", it.id)) }
                },
            )
        }
        if (updates.isNotEmpty()) data.put("updates", JSONArray().apply { updates.forEach { put(it.toJson()) } })
        return event(RREventType.IncrementalSnapshot, timestamp, data)
    }

    /** Type 3, source 2: a touch at [x], [y] (dp from the screen's top left) on wireframe [id] (0: the screen). */
    fun touch(interaction: RRMouseInteraction, id: Int, x: Int, y: Int, timestamp: Long): JSONObject = event(
        RREventType.IncrementalSnapshot,
        timestamp,
        JSONObject()
            .put("source", RRIncrementalSource.MouseInteraction.value)
            .put("type", interaction.value)
            .put("id", id)
            .put("x", x)
            .put("y", y)
            .put("pointerType", POINTER_TOUCH),
    )

    private fun RRMutatedNode.toJson(): JSONObject =
        JSONObject().put("parentId", parentId).put("wireframe", wireframe.toJson())

    private const val POINTER_TOUCH = 2
}
