// The native Godot binding contract. On device, the embedded-Godot module (a
// libgodot view + the reflective GodotController, the same C++ that services the
// Godot host today) installs `globalThis.__ElpianGodot`: a synchronous JSI
// surface that services the guest's `godot.op`/`godot.batch` calls against a
// real Godot 3D world and binds each React Native `<Scene3D/>` widget to a
// viewport into it.
//
// It is the exact mirror of the GDExtension's `exec_op_json` scripting surface
// (see `bridge/extension/src/elpian_vm_node.*`): one op in, its JSON reply out.
// Synchronous by necessity — a `godot.op` that creates a node returns the node
// handle the guest immediately uses.

/** The JSI binding the native embedded-Godot module installs. Synchronous. */
export interface ElpianGodotNative {
  /** Service one 3D op (`{new:"Node3D",…}` etc.); returns its JSON reply. */
  op(opJson: string): string;
  /** Service a batch of ops in one crossing; returns a JSON array of replies. */
  batch(opsJson: string): string;
  /** Bind a `Scene3D` widget (`surfaceId`) to a viewport over `mountNode`. */
  mountSurface(surfaceId: number, mountNode: number): void;
  /** Release a surface's viewport when its `Scene3D` widget is freed. */
  releaseSurface(surfaceId: number): void;
  /**
   * The registered native view component that displays a surface's viewport
   * (`requireNativeComponent(viewName)`). Absent when the module ships the op
   * seam but not (yet) the view — surfaces then show the placeholder.
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
