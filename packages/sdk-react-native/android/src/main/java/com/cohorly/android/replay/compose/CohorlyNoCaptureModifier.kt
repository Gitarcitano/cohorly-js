// Adapted from PostHog/posthog-android (MIT): posthog-android/src/main/java/com/posthog/android/replay/PostHogMaskModifier.kt
// Changed: only the mask modifier (no unmask), a top-level extension, Cohorly's key.

package com.cohorly.android.replay.compose

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import com.cohorly.android.replay.CohorlyReplay

/**
 * Set by [cohorlyNoCapture]; read by the recorder on a node and its ancestors.
 * Merging keeps it when either side has it, so a merged parent never drops a
 * child's protection.
 */
internal val CohorlyNoCaptureKey = SemanticsPropertyKey<Boolean>(
    name = CohorlyReplay.NO_CAPTURE_TAG,
    mergePolicy = { parent, child -> parent == true || child },
)

/**
 * Keeps this composable and everything inside it out of the session replay:
 * a placeholder in wireframes, an opaque rectangle in screenshots. The
 * Compose counterpart of [CohorlyReplay.NO_CAPTURE_TAG].
 *
 * ```kotlin
 * Text(cardNumber, Modifier.cohorlyNoCapture())
 * ```
 *
 * @param isEnabled false leaves the modifier without effect, as if it was not applied.
 */
fun Modifier.cohorlyNoCapture(isEnabled: Boolean = true): Modifier =
    if (isEnabled) semantics(properties = { this[CohorlyNoCaptureKey] = true }) else this
