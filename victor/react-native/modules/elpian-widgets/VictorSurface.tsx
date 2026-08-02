// The native host view. React mounts exactly ONE of these per mini app; the
// VM-driven WidgetController builds the entire widget tree inside it natively (no
// React below this point). This is the mobile analogue of the DOM container that
// mountDom() fills on web. `appId` scopes the op/event stream so several mini
// apps can share the one native binding (defaults to "main" for a lone app).
import * as React from "react";
import { requireNativeViewManager } from "expo-modules-core";

const NativeView: React.ComponentType<{ style?: unknown; appId?: string }> =
  requireNativeViewManager("ElpianWidgets");

export function VictorSurface(props: { style?: unknown; appId?: string }): React.ReactElement {
  return <NativeView appId="main" {...props} />;
}
