// The React-Native-facing Godot engine contract. A platform implementation
// (web canvas, native view) both *services 3D ops* (the base `Scene3dEngine`
// from the core) and *draws each Scene3D surface* as a React element. Keeping
// the drawing method here — not in the framework-agnostic core — lets the core
// stay Node-testable while the UI layer stays pluggable per platform.

import type React from "react";
import type { Scene3dEngine } from "../core/scene3dEngine.ts";

export interface RnScene3dEngine extends Scene3dEngine {
  /**
   * The React element that displays the viewport bound to `surfaceId`
   * (a `<canvas>` on web, a native Godot view on device). `style` is the
   * resolved layout style for the surface.
   */
  renderSurface(surfaceId: number, style: unknown): React.ReactNode;
}
