// The native Godot binding contract. On device, the embedded-Godot module
// installs `globalThis.__ElpianGodot`: it enqueues each 3D op for the embedded
// Godot engine (the OpSink scene drains the queue and applies ops through the
// reflective GodotController, building a real 3D scene) and hosts the viewport
// as a native view.
//
// Ops are enqueued fire-and-forget: the embedded engine renders a frame later,
// and the guest's reply (the handle it allocated) is echoed synchronously on
// the JS side (see GodotScene3dEngineCore), so no synchronous cross-thread call
// into Godot is needed.

/** The JSI binding the native embedded-Godot module installs. */
export interface ElpianGodotNative {
  /** Enqueue one 3D op (`{new:"Node3D",…}`) for the embedded engine. */
  op(opJson: string): void;
  /** Bind a `Scene3D` widget to a viewport rooted at `mountNode`. */
  mountSurface(surfaceId: number, mountNode: number): void;
  /** Release a surface's viewport when its `Scene3D` widget is freed. */
  releaseSurface(surfaceId: number): void;
  /**
   * The registered native view component that displays the Godot viewport
   * (`requireNativeComponent(viewName)`). Absent when the op seam ships without
   * the view — surfaces then show the placeholder.
   */
  viewName?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __ElpianGodot: ElpianGodotNative | undefined;
}

/** Resolve the installed native Godot binding, or `null` when absent. */
export function getElpianGodotNative(): ElpianGodotNative | null {
  const g = globalThis as { __ElpianGodot?: ElpianGodotNative };
  return g.__ElpianGodot ?? null;
}
