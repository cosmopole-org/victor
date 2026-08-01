// The native host view. React mounts exactly ONE of these; the VM-driven
// WidgetController builds the entire widget tree inside it natively (no React
// below this point). This is the mobile analogue of the DOM container that
// mountDom() fills on web.
import * as React from "react";
import { requireNativeViewManager } from "expo-modules-core";

const NativeView: React.ComponentType<{ style?: unknown }> = requireNativeViewManager("ElpianWidgets");

export function VictorSurface(props: { style?: unknown }): React.ReactElement {
  return <NativeView {...props} />;
}
