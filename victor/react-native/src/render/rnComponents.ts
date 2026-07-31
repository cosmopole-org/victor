// The complete React Native component surface, as framework-agnostic metadata.
//
// This is the single source of truth for *which* elements Victor's Expo React
// Native renderer supports. It deliberately names the **entire** public
// component set of `react-native`, so coverage is complete "by construction" —
// the same principle the Godot ClassDB bridge (`05-godot-bridge.md`) and the
// Skia CanvasKit bridge use: enumerate the surface once, resolve every entry
// reflectively, and there is no per-widget switch to fall out of date.
//
// `components.ts` turns each `rn` name into a real React Native component;
// `renderNode.tsx` uses the `kind` to decide how children / content / media are
// wired. This module imports nothing from `react-native`, so the completeness
// of the set is unit-testable under `node --experimental-strip-types`
// (`test/components.test.ts`).

/** How a component consumes its retained-tree node when rendered. */
export type WidgetKind =
  | "view" //             a container: renders its children
  | "text" //             a text leaf: content from props.text + string/Text children
  | "scroll" //           a scroller: children + optional pull-to-refresh
  | "list" //             a virtualized list: the node's children become the data set
  | "image" //            a media leaf: source from props.src/source, no children
  | "imageBackground" //  media + children
  | "input" //            TextInput
  | "switch" //           Switch
  | "button" //           the raw RN <Button/> (title/onPress, no children)
  | "activity" //         ActivityIndicator
  | "status" //           StatusBar (no children, no style)
  | "refresh" //          RefreshControl
  | "slider" //           a slider (community component or graceful fallback)
  | "scene3d" //          Victor: an embedded Godot 3D surface
  | "victorButton"; //    Victor: an ergonomic Pressable-based button

export interface ComponentSpec {
  /**
   * How to resolve the component in `components.ts`:
   *   - a dotted `react-native` export path ("View", "Animated.View"),
   *   - "@victor/<name>" for a Victor-implemented widget,
   *   - "@community/<pkg>" for an optional ecosystem package.
   */
  rn: string;
  kind: WidgetKind;
  /** Informational platform note; web/native availability is resolved at runtime. */
  platform?: "ios" | "android" | "web" | "all";
}

// The canonical host class name (what the op protocol carries in `new`) → spec.
// Every entry here is a real React Native component (plus the Victor-only
// Scene3D/Button/Slider), enumerated exhaustively so nothing is missing.
export const RN_COMPONENTS: Record<string, ComponentSpec> = {
  // --- containers -----------------------------------------------------------
  View: { rn: "View", kind: "view" },
  SafeAreaView: { rn: "SafeAreaView", kind: "view" },
  KeyboardAvoidingView: { rn: "KeyboardAvoidingView", kind: "view" },
  Modal: { rn: "Modal", kind: "view" },
  Pressable: { rn: "Pressable", kind: "view" },
  TouchableOpacity: { rn: "TouchableOpacity", kind: "view" },
  TouchableHighlight: { rn: "TouchableHighlight", kind: "view" },
  TouchableWithoutFeedback: { rn: "TouchableWithoutFeedback", kind: "view" },
  TouchableNativeFeedback: { rn: "TouchableNativeFeedback", kind: "view", platform: "android" },
  InputAccessoryView: { rn: "InputAccessoryView", kind: "view", platform: "ios" },
  DrawerLayoutAndroid: { rn: "DrawerLayoutAndroid", kind: "view", platform: "android" },

  // --- scrollers & lists ----------------------------------------------------
  ScrollView: { rn: "ScrollView", kind: "scroll" },
  FlatList: { rn: "FlatList", kind: "list" },
  SectionList: { rn: "SectionList", kind: "list" },
  VirtualizedList: { rn: "VirtualizedList", kind: "list" },
  VirtualizedSectionList: { rn: "VirtualizedSectionList", kind: "list" },

  // --- leaves ---------------------------------------------------------------
  Text: { rn: "Text", kind: "text" },
  TextInput: { rn: "TextInput", kind: "input" },
  Image: { rn: "Image", kind: "image" },
  ImageBackground: { rn: "ImageBackground", kind: "imageBackground" },
  Switch: { rn: "Switch", kind: "switch" },
  Button: { rn: "Button", kind: "button" },
  ActivityIndicator: { rn: "ActivityIndicator", kind: "activity" },
  StatusBar: { rn: "StatusBar", kind: "status" },
  RefreshControl: { rn: "RefreshControl", kind: "refresh" },

  // --- the Animated.* family (same kinds, animatable host views) ------------
  "Animated.View": { rn: "Animated.View", kind: "view" },
  "Animated.Text": { rn: "Animated.Text", kind: "text" },
  "Animated.Image": { rn: "Animated.Image", kind: "image" },
  "Animated.ScrollView": { rn: "Animated.ScrollView", kind: "scroll" },
  "Animated.FlatList": { rn: "Animated.FlatList", kind: "list" },
  "Animated.SectionList": { rn: "Animated.SectionList", kind: "list" },

  // --- Victor-specific widgets ---------------------------------------------
  Scene3D: { rn: "@victor/scene3d", kind: "scene3d" },
  RNButton: { rn: "@victor/button", kind: "victorButton" },
  RNSlider: { rn: "@community/@react-native-community/slider", kind: "slider" },
};

// Legacy `RN`-prefixed class names the current prelude and tests emit, mapped to
// their canonical entries above. Kept so existing guests keep working while new
// code can use the plain React Native names directly.
export const RN_ALIASES: Record<string, string> = {
  RNView: "View",
  RNSafeArea: "SafeAreaView",
  RNKeyboardAvoiding: "KeyboardAvoidingView",
  RNModal: "Modal",
  RNPressable: "Pressable",
  RNTouchable: "TouchableOpacity",
  RNTouchableHighlight: "TouchableHighlight",
  RNTouchableWithoutFeedback: "TouchableWithoutFeedback",
  RNTouchableNativeFeedback: "TouchableNativeFeedback",
  RNInputAccessory: "InputAccessoryView",
  RNDrawer: "DrawerLayoutAndroid",
  RNScroll: "ScrollView",
  RNFlatList: "FlatList",
  RNSectionList: "SectionList",
  RNVirtualizedList: "VirtualizedList",
  RNText: "Text",
  RNInput: "TextInput",
  RNImage: "Image",
  RNImageBackground: "ImageBackground",
  RNSwitch: "Switch",
  RNActivityIndicator: "ActivityIndicator",
  RNStatusBar: "StatusBar",
  RNRefreshControl: "RefreshControl",
  RNScene3D: "Scene3D",
  RNAnimatedView: "Animated.View",
  RNAnimatedText: "Animated.Text",
  RNAnimatedImage: "Animated.Image",
  RNAnimatedScroll: "Animated.ScrollView",
};

/** Resolve a host class name (canonical or legacy alias) to its spec, or null. */
export function specFor(className: string): ComponentSpec | null {
  if (RN_COMPONENTS[className]) return RN_COMPONENTS[className];
  const canon = RN_ALIASES[className];
  if (canon && RN_COMPONENTS[canon]) return RN_COMPONENTS[canon];
  return null;
}

/** The canonical spec name for a host class name (for the resolver/registry). */
export function canonicalName(className: string): string {
  if (RN_COMPONENTS[className]) return className;
  return RN_ALIASES[className] ?? className;
}
