// The platform-native widget every widget KIND maps to — the contract each
// platform WidgetSink implements. This is what makes "one widget set → native
// on every platform" concrete and complete: every kind in `rnComponents.ts` has
// an entry here for every platform, enforced by `test/widgetCoverage.test.ts`,
// so a Victor guest's widgets can never silently fall through on a platform.
//
//   web    — a real DOM element (no React)
//   android— a real android.view.View subclass (Yoga flexbox for layout)
//   ios    — a real UIView subclass (planned; mapped for completeness)
//
// The renderers (DomWidgetRenderer, NativeWidgetRenderer) switch on `kind` and
// instantiate the mapped widget; this table is the single place the mapping
// lives, so adding a platform is filling a column, not editing every renderer.

import type { WidgetKind } from "./rnComponents.ts";

export interface NativeWidgetMap {
  /** DOM tag / construction for web. */
  web: string;
  /** android.view.View subclass for Android. */
  android: string;
  /** UIView subclass for iOS. */
  ios: string;
  /** One-line note on how the kind is realized. */
  note?: string;
}

export const WIDGET_CATALOG: Record<WidgetKind, NativeWidgetMap> = {
  view: { web: "div", android: "VictorYogaView", ios: "UIView", note: "flex container (Yoga)" },
  text: { web: "span", android: "TextView", ios: "UILabel" },
  scroll: { web: "div[overflow:auto]", android: "NestedScrollView", ios: "UIScrollView" },
  list: {
    web: "div[virtualized]",
    android: "RecyclerView",
    ios: "UICollectionView",
    note: "children become the data set",
  },
  image: { web: "img", android: "ImageView", ios: "UIImageView" },
  imageBackground: {
    web: "div[background-image]",
    android: "VictorYogaView+ImageView",
    ios: "UIImageView(container)",
  },
  input: { web: "input | textarea", android: "EditText", ios: "UITextField" },
  switch: { web: "input[type=checkbox][role=switch]", android: "SwitchCompat", ios: "UISwitch" },
  button: { web: "button", android: "Button", ios: "UIButton" },
  activity: { web: "div[role=progressbar]", android: "ProgressBar", ios: "UIActivityIndicatorView" },
  status: {
    web: "meta[theme-color]",
    android: "Window.statusBarColor",
    ios: "UIStatusBarManager",
    note: "no view; sets platform status bar",
  },
  refresh: {
    web: "pull-to-refresh handler",
    android: "SwipeRefreshLayout",
    ios: "UIRefreshControl",
  },
  slider: { web: "input[type=range]", android: "SeekBar", ios: "UISlider" },
  scene3d: {
    web: "canvas(Godot HTML5)",
    android: "GodotView (ElpianGodotView)",
    ios: "GodotView",
    note: "the embedded Godot 3D widget",
  },
  victorButton: {
    web: "button(styled)",
    android: "Button(styled)",
    ios: "UIButton(styled)",
    note: "ergonomic Pressable-style button",
  },
};
