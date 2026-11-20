package com.cohorly.android.replay

import android.graphics.Rect
import android.view.View
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.getOrNull
import com.cohorly.android.replay.compose.CohorlyNoCaptureKey
import com.cohorly.android.replay.rr.RRWireframe

/**
 * What a composition read gives: its [wireframes], and the window px bounds
 * of its no-capture nodes, which hide the interop views (`AndroidView`) they
 * overlap ([interopHidden]).
 */
internal class ComposeNodes(val wireframes: List<RRWireframe>, val noCapture: List<Rect>)

/** The wireframes of a composition, below its host view's own. Compose-free signature: see [ComposeDetector]. */
internal fun interface ComposeNodeSource {
    /**
     * The wireframes of the composition hosted by [view] (an `AndroidComposeView`
     * whose wireframe id is [parentId]), or null when its semantics cannot be
     * read: the caller then records the view as one placeholder, none of its
     * child views either. Main thread.
     */
    fun nodes(view: View, parentId: Int, ids: ViewIdRegistry, density: Float): ComposeNodes?
}

/**
 * Compose in the wireframe recording, from the merged semantics tree and its
 * public API only, no reflection:
 * - `Text` -> `text`;
 * - `EditableText` -> `input` whose value is `*` of the same length (never
 *   the text, like an EditText), `password` when it is a password field;
 * - `Role.Image`, or a content description with no text -> `image`, never
 *   with pixels;
 * - [CohorlyNoCaptureKey] on a node -> one `placeholder`, nothing below it,
 *   and no interop view it overlaps;
 * - anything else -> `rectangle` of the node's bounds.
 *
 * Ids come from [ViewIdRegistry] by (host view, semantics node id), so they
 * stay the same while the node lives. Not in PostHog.
 */
internal class ComposeWireframes(
    private val rootOf: (View) -> SemanticsNode = { (it as RootForTest).semanticsOwner.rootSemanticsNode },
) : ComposeNodeSource {
    private val location = IntArray(2)
    private val windowLocation = IntArray(2)

    override fun nodes(view: View, parentId: Int, ids: ViewIdRegistry, density: Float): ComposeNodes? = try {
        val root = rootOf(view)
        // boundsInWindow is in window px; wireframes are in screen dp.
        view.getLocationOnScreen(location)
        view.getLocationInWindow(windowLocation)
        val walk = Walk(view, ids, density, location[0] - windowLocation[0], location[1] - windowLocation[1])
        val nodes = root.children.mapNotNull { walk.wireframe(it, parentId) }
        ids.retainNodes(view, walk.seen)
        ComposeNodes(nodes, walk.noCapture)
    } catch (e: Throwable) {
        if (e is VirtualMachineError) throw e
        null
    }

    private class Walk(
        val view: View,
        val ids: ViewIdRegistry,
        val density: Float,
        val offsetX: Int,
        val offsetY: Int,
    ) {
        val seen = HashSet<Int>()
        val noCapture = ArrayList<Rect>()

        fun wireframe(node: SemanticsNode, parentId: Int): RRWireframe? {
            val bounds = node.boundsInWindow
            val widthPx = bounds.right - bounds.left
            val heightPx = bounds.bottom - bounds.top
            if (widthPx <= 0f || heightPx <= 0f) return null
            val config = node.config
            seen.add(node.id)
            val id = ids.idFor(view, node.id)
            val x = ((bounds.left + offsetX) / density).toInt()
            val y = ((bounds.top + offsetY) / density).toInt()
            val width = (widthPx / density).toInt()
            val height = (heightPx / density).toInt()

            if (config.getOrNull(CohorlyNoCaptureKey) == true) {
                bounds.toMaskRect()?.let(noCapture::add)
                return RRWireframe(id, x, y, width, height, type = WireframeBuilder.PLACEHOLDER, parentId = parentId)
            }

            val editable = config.getOrNull(SemanticsProperties.EditableText)
            val password = config.contains(SemanticsProperties.Password)
            val texts = config.getOrNull(SemanticsProperties.Text)
            val text = texts?.joinToString("\n") { it.text }?.takeIf { it.isNotEmpty() }
            val described = config.getOrNull(SemanticsProperties.ContentDescription)?.any { it.isNotEmpty() } == true
            val image = config.getOrNull(SemanticsProperties.Role) == Role.Image || (described && text == null)

            var type = "rectangle"
            var inputType: String? = null
            var value: String? = null
            var shownText: String? = null
            when {
                editable != null || password -> {
                    type = "input"
                    inputType = if (password) "password" else "text"
                    value = "*".repeat(editable?.text?.length ?: 0).takeIf { it.isNotEmpty() }
                }
                image -> type = "image"
                text != null -> {
                    type = "text"
                    shownText = text
                }
            }

            val children = if (type == "input") {
                // Merged into the field: its label and placeholder, never what was typed.
                emptyList()
            } else {
                node.children.mapNotNull { wireframe(it, id) }
            }
            return RRWireframe(
                id = id,
                x = x,
                y = y,
                width = width,
                height = height,
                childWireframes = children.ifEmpty { null },
                type = type,
                inputType = inputType,
                text = shownText,
                value = value,
                disabled = if (type == "input") config.contains(SemanticsProperties.Disabled) else null,
                parentId = parentId,
            )
        }
    }
}

/** True when [key] is set to true on this node or one of its ancestors. */
internal fun SemanticsNode.hasActive(key: SemanticsPropertyKey<Boolean>): Boolean {
    var current: SemanticsNode? = this
    while (current != null) {
        if (current.config.getOrNull(key) == true) return true
        current = current.parent
    }
    return false
}
