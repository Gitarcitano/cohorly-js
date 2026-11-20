package com.cohorly.android.replay

/** Public constants of the Cohorly session replay recorder. */
object CohorlyReplay {
    /**
     * Set as a view's `tag` (or anywhere in a String tag) to keep the view and
     * its whole subtree out of the recording: it is recorded as one empty
     * placeholder, with no text and no children. A React Native `testID` of
     * `cohorly-no-capture` becomes this tag. `contentDescription` is never
     * read, so accessibility is untouched.
     *
     * ```kotlin
     * cardNumberView.tag = CohorlyReplay.NO_CAPTURE_TAG
     * ```
     */
    const val NO_CAPTURE_TAG = "cohorly-no-capture"
}
