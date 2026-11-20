package com.cohorly.android.replay

import android.view.View
import android.view.WindowManager
import curtains.Curtains
import curtains.OnRootViewsChangedListener
import curtains.phoneWindow

/** The app's root views (one per window), in the order they were added. Main thread. */
internal interface RootViewSource {
    fun rootViews(): List<View>

    fun addListener(listener: (view: View, added: Boolean) -> Unit)

    fun removeListener(listener: (view: View, added: Boolean) -> Unit)
}

/**
 * Root views from curtains, which reads `WindowManagerGlobal`'s list: every
 * window of the process (Activities, Dialogs, PopupWindows, toasts), in the
 * order they were added, which is the z order only among windows of the same
 * type: [zOrdered] sorts them.
 */
internal object CurtainsRootViewSource : RootViewSource {
    private val wrapped = HashMap<(View, Boolean) -> Unit, OnRootViewsChangedListener>()

    override fun rootViews(): List<View> = Curtains.rootViews

    override fun addListener(listener: (view: View, added: Boolean) -> Unit) {
        val wrapper = OnRootViewsChangedListener { view, added -> listener(view, added) }
        wrapped[listener] = wrapper
        Curtains.onRootViewsChangedListeners += wrapper
    }

    override fun removeListener(listener: (view: View, added: Boolean) -> Unit) {
        wrapped.remove(listener)?.let { Curtains.onRootViewsChangedListeners -= it }
    }
}

/**
 * The part of the replay session the recorder reads: its host. The Cohorly
 * SDK's is [ControllerSessionSource] (not copied to React Native); the React
 * Native bridge has its own.
 */
internal interface ReplaySessionSource {
    val sessionId: String?
    val mode: RecorderMode

    /** Calls [listener] with the new session id on each rotation, null on opt-out (any thread). */
    fun addSessionListener(listener: (String?) -> Unit): () -> Unit

    /** A recorded touch: activity for the 30 min foreground idle rule. */
    fun recordActivity()

    /** Queues a chunk of session-mode events for [sessionId]; false when refused. */
    fun enqueue(events: List<org.json.JSONObject>, sessionId: String): Boolean

    /**
     * Chunks the queue removed after taking them, without delivering them
     * (quota, another 4xx, an event too large); never decreases. A change
     * means the server may lack the snapshot the next Mutation builds on.
     */
    val droppedChunks: Long

    // MARK: error mode (VEL-2151). Defaults: no crash reporter, nothing sent.

    /** A crash report would be written now (the crash reporter runs in this process): error mode may record. */
    val errorReportsOn: Boolean get() = false

    /** The `$session_id` the last crash report carried; a listener acts only on that session's buffer. */
    val reportSessionId: String? get() = sessionId

    /** Calls [listener] after each crash report written (fatal: on the crashing thread). Returns its removal. */
    fun addCrashListener(listener: (fatal: Boolean) -> Unit): () -> Unit = {}

    /** Queues an error-mode chunk for [sessionId] (sent soon); false when refused. */
    fun enqueueError(events: List<org.json.JSONObject>, sessionId: String): Boolean = false

    /** Writes an error-mode chunk for [sessionId] to disk before returning (the process is dying); false when it did not land. */
    fun enqueueErrorNow(events: List<org.json.JSONObject>, sessionId: String): Boolean = false

    /**
     * The buffer error mode keeps its events in, read with [clock]; null (the
     * default) when this host has no error mode: a session in
     * [RecorderMode.ERROR] then records nothing.
     */
    fun createErrorBuffer(clock: () -> Long): RecorderErrorBuffer? = null
}

/** The window type of a root view ([WindowManager.LayoutParams.type]); an application window when unknown. */
internal val View.windowType: Int
    get() = (layoutParams as? WindowManager.LayoutParams)?.type ?: WindowManager.LayoutParams.TYPE_APPLICATION

/** An Activity or Dialog window (types 1..99), as opposed to a sub-window (popup, panel) or a system one. */
internal val View.isApplicationWindow: Boolean
    get() = windowType in
        WindowManager.LayoutParams.FIRST_APPLICATION_WINDOW..WindowManager.LayoutParams.LAST_APPLICATION_WINDOW

/**
 * [roots] bottom to top, the way the window manager stacks them: by window
 * type (an application window below its sub-windows, a toast above both),
 * and in the order they were added within one type (a stable sort).
 */
internal fun zOrdered(roots: List<View>): List<View> = roots.sortedBy { it.windowType }

/** True when the window [this] is the root of is `FLAG_SECURE` now. */
internal fun View.isSecureWindow(): Boolean {
    // The window's attributes and the root's copy of them: either may be the newer one.
    val flags =
        ((layoutParams as? WindowManager.LayoutParams)?.flags ?: 0) or (phoneWindowOrNull()?.attributes?.flags ?: 0)
    return flags and WindowManager.LayoutParams.FLAG_SECURE != 0
}

internal fun View.phoneWindowOrNull(): android.view.Window? = try {
    phoneWindow
} catch (_: Throwable) {
    null
}
