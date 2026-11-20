// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/PostHogReplayIntegration.kt
// (findMaskableComposeWidgets, hasActiveModifier, isScrim)
// Changed: Cohorly's rules (text inputs and passwords always, images only with maskAllImages,
// cohorlyNoCapture always), no unmask modifier, no maskAllTextInputs option; runs inline on the
// main thread; a failure of the semantics read or of the reflection covers the whole view;
// the scrim check reads semantics only (no ComposeSolidFill); bounds rounded outward; interop
// views inside a no-capture node are covered too (interopCover).

package com.cohorly.android.replay

import android.graphics.Rect
import android.view.View
import androidx.compose.ui.layout.LayoutInfo
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull
import com.cohorly.android.replay.compose.CohorlyNoCaptureKey

/** The screenshot mask of a composition. Compose-free signature: see [ComposeDetector]. */
internal fun interface ComposeMasking {
    /**
     * Adds to [rects] (window px) what must be covered in [view] (an
     * `AndroidComposeView`). Never throws: a failure covers the whole view.
     * Returns the no-capture areas (window px) its interop child views are
     * checked against ([interopCover]): the whole view when the read failed.
     * Main thread.
     */
    fun collect(view: View, maskAllImages: Boolean, rects: MutableList<Rect>): List<Rect>
}

/**
 * Covers, from the merged semantics tree: text fields and passwords always;
 * with `maskAllImages`, nodes with `Role.Image` or a content description and
 * no text, plus the painters semantics does not see (an `Image` with no
 * content description, Coil's `AsyncImage`), found by reflection
 * ([collectComposeImageRects]); and every node under [CohorlyNoCaptureKey].
 */
internal class ComposeMask(
    private val ownerOf: (View) -> SemanticsOwner = { (it as RootForTest).semanticsOwner },
    private val imageRects: (LayoutInfo, MutableList<Rect>) -> Unit = { root, out ->
        collectComposeImageRects(root, emptySet(), out)
    },
) : ComposeMasking {
    override fun collect(view: View, maskAllImages: Boolean, rects: MutableList<Rect>): List<Rect> {
        // Local lists, so a failure halfway leaves nothing partial behind.
        val found = mutableListOf<Rect>()
        val noCapture = mutableListOf<Rect>()
        try {
            val owner = ownerOf(view)
            for (node in owner.getAllSemanticsNodes(mergingEnabled = true)) {
                val config = node.config
                val hidden = node.hasActive(CohorlyNoCaptureKey)
                val covered = hidden ||
                    config.contains(SemanticsProperties.EditableText) ||
                    config.contains(SemanticsProperties.Password) ||
                    (maskAllImages && node.isImage() && !node.isScrim(view))
                if (!covered) continue
                val rect = node.boundsInWindow.toMaskRect() ?: continue
                found.add(rect)
                if (hidden) noCapture.add(rect)
            }
            if (maskAllImages) imageRects(owner.unmergedRootSemanticsNode.layoutInfo, found)
        } catch (e: Throwable) {
            if (e is VirtualMachineError) throw e
            found.clear()
            noCapture.clear()
            val whole = view.windowRect()
            found.add(whole)
            noCapture.add(whole)
        }
        rects.addAll(found)
        return noCapture
    }

    private fun SemanticsNode.isImage(): Boolean {
        if (config.getOrNull(SemanticsProperties.Role) == Role.Image) return true
        val described = config.getOrNull(SemanticsProperties.ContentDescription)?.any { it.isNotEmpty() } == true
        return described && !config.contains(SemanticsProperties.Text)
    }

    /**
     * A modal's scrim: clickable, no role, at least the size of the window.
     * Its content description is its dismiss label, not an image; covering it
     * would black out the screen.
     */
    private fun SemanticsNode.isScrim(view: View): Boolean {
        if (!config.contains(SemanticsActions.OnClick) || config.contains(SemanticsProperties.Role)) return false
        val bounds = boundsInWindow
        val root = view.rootView
        return bounds.left <= 0f && bounds.top <= 0f && bounds.right >= root.width && bounds.bottom >= root.height
    }
}
