// Prop → React Native style translation. Guests express layout with a small,
// platform-neutral vocabulary (`direction`, `padding`, `bg`, `color`, …) plus a
// raw `style` escape hatch; this maps it onto a React Native `StyleSheet` style
// object. Kept dependency-light and framework-agnostic (no `react-native`
// import) so it is unit-testable.
//
// The `style` escape hatch (`style={{ ... }}`) merges last and passes through
// verbatim, so ANY React Native style property is expressible even if it has no
// convenience alias here. `STYLE_KEYS` lists every key this file consumes so the
// renderer knows not to also forward them as component props.

import type { Wire } from "../core/protocol.ts";

export type Style = Record<string, unknown>;

// Convenience prop -> RN style key (the rest of `style` passes through as-is).
const DIRECT: Record<string, string> = {
  // color / background
  bg: "backgroundColor",
  backgroundColor: "backgroundColor",
  color: "color",
  tintColor: "tintColor",
  opacity: "opacity",
  // spacing
  padding: "padding",
  paddingH: "paddingHorizontal",
  paddingV: "paddingVertical",
  paddingTop: "paddingTop",
  paddingBottom: "paddingBottom",
  paddingLeft: "paddingLeft",
  paddingRight: "paddingRight",
  margin: "margin",
  marginH: "marginHorizontal",
  marginV: "marginVertical",
  marginTop: "marginTop",
  marginBottom: "marginBottom",
  marginLeft: "marginLeft",
  marginRight: "marginRight",
  gap: "gap",
  rowGap: "rowGap",
  columnGap: "columnGap",
  // size
  width: "width",
  height: "height",
  minWidth: "minWidth",
  maxWidth: "maxWidth",
  minHeight: "minHeight",
  maxHeight: "maxHeight",
  // flex
  flex: "flex",
  flexGrow: "flexGrow",
  flexShrink: "flexShrink",
  flexBasis: "flexBasis",
  flexWrap: "flexWrap",
  align: "alignItems",
  alignSelf: "alignSelf",
  justify: "justifyContent",
  // position
  position: "position",
  top: "top",
  left: "left",
  right: "right",
  bottom: "bottom",
  zIndex: "zIndex",
  overflow: "overflow",
  // border / radius / elevation
  radius: "borderRadius",
  borderRadius: "borderRadius",
  borderWidth: "borderWidth",
  borderColor: "borderColor",
  elevation: "elevation",
  // text
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  fontStyle: "fontStyle",
  fontFamily: "fontFamily",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  textAlign: "textAlign",
};

/** Every prop key this module consumes (so the renderer won't re-forward them). */
export const STYLE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DIRECT),
  "direction",
  "style",
]);

/** Build a React Native style object from a widget's props. */
export function toStyle(props: Record<string, Wire>): Style {
  const style: Style = {};
  if (props.direction === "row" || props.direction === "column") {
    style.flexDirection = props.direction;
  }
  for (const key of Object.keys(props)) {
    const target = DIRECT[key];
    if (target) style[target] = props[key];
  }
  const raw = props.style;
  if (raw && typeof raw === "object") Object.assign(style, raw as object);
  return style;
}
