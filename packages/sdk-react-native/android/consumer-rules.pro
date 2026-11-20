# Session replay (VEL-2142): the recorder copied from sdks/android/cohorly-replay
# (android/src/main/java/com/cohorly/android/replay, `sync:replay`). Same Compose
# rules as cohorly-replay's consumer-rules.pro; its ReplayInstaller rule is left
# out, that class is not copied.

# Adapted from PostHog/posthog-android (MIT): posthog-android/consumer-rules.pro (VEL-2141).
# Compose is detected by this class name (ComposeDetector.kt); a renamed class reads as no Compose.
-keepnames class androidx.compose.ui.platform.AndroidComposeView
# The screenshot mask walks the Compose layout tree by reflection to cover images that have no
# semantics (ComposeImageMask.kt). Renamed members make it fail closed (the view is covered whole).
-keepclassmembers class androidx.compose.ui.node.LayoutNode {
    java.util.List getChildren$ui();
    java.util.List getChildren$ui_release();
    java.util.List getChildrenInfo();
    *** getNodes$ui();
    *** getNodes$ui_release();
}
-keepclassmembers class androidx.compose.ui.node.NodeChain {
    *** getHead$ui();
    *** getHead$ui_release();
}
-keepnames class androidx.compose.ui.Modifier$Node
-keepclassmembers class androidx.compose.ui.Modifier$Node {
    *** getChild$ui();
    *** getChild$ui_release();
}
-keepnames class androidx.compose.ui.graphics.painter.BrushPainter
-dontwarn androidx.compose.**
