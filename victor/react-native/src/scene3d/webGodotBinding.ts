// The WEB embedded-Godot binding contract — the browser twin of
// `godotBinding.ts` (native JSI). A Godot 4 HTML5 export, loaded on the page,
// installs `globalThis.__ElpianGodotWeb`: it runs the very same reflective
// `GodotController` (compiled to WebAssembly by the export) and drives a real
// WebGL viewport per `Scene3D` surface. Ops are posted fire-and-forget; the
// guest's reply (the handle it allocated) is echoed synchronously on the JS
// side (see WebGodotEngine), so there is no synchronous call into the engine.
//
// The HTML5 export is a build artifact (like the native `.so`/`.aar`): a page
// that wants real 3D loads `web/godot/elpian_godot.js`, which boots the engine
// and installs this binding. Without it, `Scene3D` surfaces stay blank canvases
// and the 2D app runs unchanged — the same graceful degradation as native.

/** The binding a loaded Godot HTML5 export installs on the page. */
export interface ElpianGodotWeb {
  /** Enqueue one 3D op (`{new:"Node3D",…}`) for the WebGL engine. */
  op(opJson: string): void;
  /**
   * Bind a `Scene3D` widget to a viewport rendered into `canvas`. `mountNode` is
   * the guest-allocated Godot node handle the surface's 3D content hangs under.
   */
  mountSurface(surfaceId: number, canvas: unknown, mountNode: number): void;
  /** Release a surface's viewport when its `Scene3D` widget is freed. */
  releaseSurface(surfaceId: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __ElpianGodotWeb: ElpianGodotWeb | undefined;
}

/** Resolve the installed web Godot binding, or `null` when the export isn't loaded. */
export function getElpianGodotWeb(): ElpianGodotWeb | null {
  const g = globalThis as { __ElpianGodotWeb?: ElpianGodotWeb };
  return g.__ElpianGodotWeb ?? null;
}
