// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/internal/ViewTreeSnapshotStatus.kt
// (the wireframe part: sentMetaEvent, sentFullSnapshot, lastSnapshot) and, from
// posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt,
// snapshotEvents, flattenChildren and findAddedAndRemovedItems.
// Changed: one status for the whole screen (every window in one snapshot) instead of one
// per window; a full snapshot is also sent when the session or the screen structure
// changes, when a view moved to another parent or children changed order (a Mutation
// carries neither), and when an added or updated view overlaps a later sibling (the player
// appends it on top); a touch is resolved against the last snapshot sent; the keyboard is
// read with the capture and turned into events by KeyboardTracker (VEL-2174), not here;
// no screenshot state.

package com.cohorly.android.replay.internal

import com.cohorly.android.replay.KeyboardState
import com.cohorly.android.replay.rr.RREvent
import com.cohorly.android.replay.rr.RRMutatedNode
import com.cohorly.android.replay.rr.RRRemovedNode
import com.cohorly.android.replay.rr.RRWireframe
import org.json.JSONObject

/**
 * One capture of the screen, built on the main thread: every visible window
 * of the app, bottom to top, plus what decides a full snapshot.
 *
 * @param screenKey changes when the structure of the screen changes: the set
 *   of windows, the top Activity or the screen size. A new key means Meta +
 *   FullSnapshot instead of a Mutation.
 * @param forceFull set by the recorder after a pause (background, a session
 *   that was not recording, a new session).
 * @param keyboard the keyboard read with the capture (VEL-2174), its height in dp.
 */
internal class ScreenCapture(
    val sessionId: String,
    val timestamp: Long,
    val width: Int,
    val height: Int,
    val href: String,
    val screenKey: List<Any>,
    val wireframes: List<RRWireframe>,
    val forceFull: Boolean,
    val keyboard: KeyboardState = KeyboardState.CLOSED,
)

/**
 * What the recorder last sent for the screen, and the step from it to a new
 * capture. Recorder thread only.
 */
internal class ViewTreeSnapshotStatus {
    private var sessionId: String? = null
    private var screenKey: List<Any>? = null
    private var lastSnapshot: List<RRWireframe>? = null

    /** The next capture is sent whole (Meta + FullSnapshot). */
    fun reset() {
        sessionId = null
        screenKey = null
        lastSnapshot = null
    }

    /** True once a full snapshot of [sessionId] was sent, so incremental events may follow. */
    fun hasFullSnapshot(sessionId: String): Boolean = this.sessionId == sessionId && lastSnapshot != null

    /** True while the screen this status tracks belongs to [sessionId]. */
    fun tracks(sessionId: String): Boolean = this.sessionId == sessionId

    /**
     * The events [capture] turns into: Meta + FullSnapshot when the session,
     * the screen structure, the tree's shape (a view under another parent,
     * children in another order), an added or updated view drawn below a
     * sibling it overlaps, or [ScreenCapture.forceFull] say so, else one
     * Mutation with the difference by id, or nothing when nothing changed.
     */
    fun snapshotEvents(capture: ScreenCapture): List<JSONObject> {
        val previous = lastSnapshot
        val diff = previous?.let {
            findAddedAndRemovedItems(it.flattenChildren(), capture.wireframes.flattenChildren())
        }
        val full = capture.forceFull ||
            previous == null ||
            diff == null ||
            sessionId != capture.sessionId ||
            screenKey != capture.screenKey ||
            reshaped(previous, capture.wireframes) ||
            coversLaterSibling(diff.first + diff.third, capture.wireframes)
        sessionId = capture.sessionId
        screenKey = capture.screenKey
        lastSnapshot = capture.wireframes
        if (full || diff == null) {
            return listOf(
                RREvent.meta(capture.width, capture.height, capture.href, capture.timestamp),
                RREvent.fullSnapshot(capture.wireframes, capture.timestamp),
            )
        }
        val (added, removed, updated) = diff
        val mutation = RREvent.mutation(
            adds = added.map { RRMutatedNode(it, it.parentId) },
            removes = removed.map { RRRemovedNode(it.id, it.parentId) },
            updates = updated.map { RRMutatedNode(it, it.parentId) },
            timestamp = capture.timestamp,
        )
        return listOfNotNull(mutation)
    }

    /**
     * The id of the deepest wireframe of the last snapshot sent under the
     * point ([x], [y] in dp from the screen's top left), 0 (the screen) when
     * none: the top window first, the last child (drawn on top) first. Only
     * visible views are wireframes, so an invisible or transparent one never
     * answers.
     */
    fun hitTest(x: Int, y: Int): Int {
        val windows = lastSnapshot ?: return 0
        for (window in windows.asReversed()) deepestAt(window, x, y)?.let { return it }
        return 0
    }

    private fun deepestAt(wireframe: RRWireframe, x: Int, y: Int): Int? {
        if (x < wireframe.x ||
            y < wireframe.y ||
            x >= wireframe.x + wireframe.width ||
            y >= wireframe.y + wireframe.height
        ) {
            return null
        }
        wireframe.childWireframes?.asReversed()?.forEach { child -> deepestAt(child, x, y)?.let { return it } }
        return wireframe.id
    }

    /**
     * True when a view kept between [old] and [new] has another parent, or
     * the views a parent kept are in another order. A Mutation cannot say
     * either: the player removes a node from the parent the update names.
     */
    private fun reshaped(old: List<RRWireframe>, new: List<RRWireframe>): Boolean {
        val oldShape = shape(old)
        val newShape = shape(new)
        for ((id, parent) in newShape.parents) {
            val oldParent = oldShape.parents[id] ?: continue
            if (oldParent != parent) return true
        }
        for ((parent, children) in newShape.children) {
            val oldChildren = oldShape.children[parent] ?: continue
            val kept = children.filter { it in oldShape.parents }
            val oldKept = oldChildren.filter { it in newShape.parents }
            if (kept != oldKept) return true
        }
        return false
    }

    /**
     * True when one of [changed] (added or updated views) has a later
     * sibling in [windows] whose rectangle intersects its own. The player
     * applies an update as remove + add and an add with no `nextId`, so the
     * view goes to the end of its parent's children, drawn over every
     * sibling; only a full snapshot keeps it below the ones it overlaps.
     */
    private fun coversLaterSibling(changed: List<RRWireframe>, windows: List<RRWireframe>): Boolean {
        if (changed.isEmpty()) return false
        // Each view's siblings (its parent's children, or the windows) and its place among them.
        val places = HashMap<Int, Pair<List<RRWireframe>, Int>>()
        fun walk(list: List<RRWireframe>) {
            list.forEachIndexed { index, item ->
                places[item.id] = list to index
                item.childWireframes?.let(::walk)
            }
        }
        walk(windows)
        return changed.any { node ->
            val (siblings, index) = places[node.id] ?: return@any false
            (index + 1 until siblings.size).any { intersects(node, siblings[it]) }
        }
    }

    private fun intersects(a: RRWireframe, b: RRWireframe): Boolean =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

    private class Shape(val parents: Map<Int, Int>, val children: Map<Int, List<Int>>)

    private fun shape(windows: List<RRWireframe>): Shape {
        val parents = HashMap<Int, Int>()
        val children = HashMap<Int, MutableList<Int>>()
        fun walk(list: List<RRWireframe>, parentId: Int) {
            for (item in list) {
                parents[item.id] = parentId
                children.getOrPut(parentId) { mutableListOf() }.add(item.id)
                item.childWireframes?.let { walk(it, item.id) }
            }
        }
        walk(windows, RRWireframe.SCREEN_ROOT_ID)
        return Shape(parents, children)
    }

    private fun List<RRWireframe>.flattenChildren(): List<RRWireframe> {
        val result = mutableListOf<RRWireframe>()
        for (item in this) {
            result.add(item)
            item.childWireframes?.let { result.addAll(it.flattenChildren()) }
        }
        return result
    }

    private fun findAddedAndRemovedItems(
        oldItems: List<RRWireframe>,
        newItems: List<RRWireframe>,
    ): Triple<List<RRWireframe>, List<RRWireframe>, List<RRWireframe>> {
        val oldMap = oldItems.associateBy { it.id }
        val newMap = newItems.associateBy { it.id }

        val addedItems = newItems.filter { it.id !in oldMap }
        val removedItems = oldItems.filter { it.id !in newMap }

        val updatedItems = mutableListOf<RRWireframe>()
        for (newItem in newItems) {
            // Compared without children, otherwise a parent would differ whenever one
            // of its children does; a changed child is its own update.
            val oldItem = oldMap[newItem.id]?.copy(childWireframes = null) ?: continue
            if (oldItem != newItem.copy(childWireframes = null)) updatedItems.add(newItem)
        }
        return Triple(addedItems, removedItems, updatedItems)
    }
}
