import { createElement, Fragment, type ReactElement } from "react";
import type { ViewProps } from "react-native";
import { loadNativeModules } from "../deviceInfo.js";

/** The token the native recorders look for in the view's accessibility identifier. */
export const NO_CAPTURE_TEST_ID = "cohorly-no-capture";

export type CohorlyMaskProps = Omit<ViewProps, "testID">;

// biome-ignore lint/suspicious/noExplicitAny: untyped `react-native` View component.
let view: any;

/** `react-native`'s View, required on first render (react-native is an optional peer). */
// biome-ignore lint/suspicious/noExplicitAny: untyped `react-native` View component.
function nativeView(): any {
  if (!view) view = loadNativeModules().rn?.View ?? undefined;
  return view;
}

/**
 * Everything inside it is hidden from session replay: the recorder draws a
 * placeholder of the same size instead (screenshot and wireframe modes). A
 * plain `View` otherwise: every View prop works, except `testID`, which
 * carries the marker the recorder reads. Without react-native it renders its
 * children as they are.
 */
export function CohorlyMask(props: CohorlyMaskProps): ReactElement {
  const View = nativeView();
  if (!View) return createElement(Fragment, null, props.children);
  return createElement(View, { ...props, testID: NO_CAPTURE_TEST_ID, collapsable: false }, props.children);
}
