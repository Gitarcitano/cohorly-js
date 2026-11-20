// Adapted from PostHog/posthog-android (MIT): posthog/src/main/java/com/posthog/internal/replay/RRWireframe.kt
// and posthog/src/main/java/com/posthog/internal/replay/RRStyle.kt
// Changed: serialized with org.json instead of Gson; immutable style; no icon fields.

package com.cohorly.android.replay.rr

import org.json.JSONArray
import org.json.JSONObject

/**
 * One view of the screen in the mobile replay format (docs/SESSION-REPLAY.md,
 * "Wireframes"). Immutable: built on the main thread, serialized and diffed
 * on the recorder thread. [parentId] is not serialized; it is the parent
 * wireframe's id (5, the screen root, for the top of a window) and goes in
 * the Mutation events.
 */
internal data class RRWireframe(
    val id: Int,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val childWireframes: List<RRWireframe>? = null,
    // text|image|rectangle|input|div|placeholder|web_view|radio_group|status_bar|navigation_bar
    val type: String,
    // checkbox|toggle|radio|text|password|email|number|tel|url|select|text_area|button|progress
    val inputType: String? = null,
    val text: String? = null,
    val label: String? = null,
    // String or Number
    val value: Any? = null,
    val base64: String? = null,
    val style: RRStyle? = null,
    val disabled: Boolean? = null,
    val checked: Boolean? = null,
    val max: Int? = null,
    val parentId: Int = SCREEN_ROOT_ID,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("x", x)
        put("y", y)
        put("width", width)
        put("height", height)
        put("type", type)
        inputType?.let { put("inputType", it) }
        text?.let { put("text", it) }
        label?.let { put("label", it) }
        value?.let { put("value", it) }
        base64?.let { put("base64", it) }
        style?.toJson()?.let { if (it.length() > 0) put("style", it) }
        disabled?.let { put("disabled", it) }
        checked?.let { put("checked", it) }
        max?.let { put("max", it) }
        childWireframes?.takeIf { it.isNotEmpty() }?.let { children ->
            put("childWireframes", JSONArray().apply { children.forEach { put(it.toJson()) } })
        }
    }

    companion object {
        /** The player's screen root: the parent of the top wireframe of every window. */
        const val SCREEN_ROOT_ID = 5

        /** Wireframe ids start here; smaller ones collide with the player's own nodes. */
        const val FIRST_ID = 10_000_000
    }
}

internal data class RRStyle(
    val color: String? = null,
    val backgroundColor: String? = null,
    val backgroundImage: String? = null,
    val borderWidth: Int? = null,
    val borderRadius: Int? = null,
    val borderColor: String? = null,
    val fontSize: Int? = null,
    val fontFamily: String? = null,
    val horizontalAlign: String? = null,
    val verticalAlign: String? = null,
    val paddingTop: Int? = null,
    val paddingBottom: Int? = null,
    val paddingLeft: Int? = null,
    val paddingRight: Int? = null,
    val bar: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        color?.let { put("color", it) }
        backgroundColor?.let { put("backgroundColor", it) }
        backgroundImage?.let { put("backgroundImage", it) }
        borderWidth?.let { put("borderWidth", it) }
        borderRadius?.let { put("borderRadius", it) }
        borderColor?.let { put("borderColor", it) }
        fontSize?.let { put("fontSize", it) }
        fontFamily?.let { put("fontFamily", it) }
        horizontalAlign?.let { put("horizontalAlign", it) }
        verticalAlign?.let { put("verticalAlign", it) }
        paddingTop?.let { put("paddingTop", it) }
        paddingBottom?.let { put("paddingBottom", it) }
        paddingLeft?.let { put("paddingLeft", it) }
        paddingRight?.let { put("paddingRight", it) }
        bar?.let { put("bar", it) }
    }
}
