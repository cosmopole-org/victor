// Prop → React Native style translation. Guests express layout with a small,
// platform-neutral vocabulary (`direction`, `padding`, `bg`, `color`, …) plus a
// raw `style` escape hatch; this maps it onto a React Native `StyleSheet` style
// object. Kept dependency-light and framework-agnostic (no `react-native`
// import) so it is unit-testable.

import type { Wire } from "../core/protocol.ts";

export type Style = Record<string, unknown>;

// Convenience prop -> RN style key (the rest of `style` passes through as-is).
const DIRECT: Record<string, string> = {
  bg: "backgroundColor",
  backgroundColor: "backgroundColor",
  color: "color",
  padding: "padding",
  paddingH: "paddingHorizontal",
  paddingV: "paddingVertical",
  margin: "margin",
  gap: "gap",
  width: "width",
  height: "height",
  flex: "flex",
  align: "alignItems",
  justify: "justifyContent",
  radius: "borderRadius",
  borderRadius: "borderRadius",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  opacity: "opacity",
  borderWidth: "borderWidth",
  borderColor: "borderColor",
  textAlign: "textAlign",
};

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
