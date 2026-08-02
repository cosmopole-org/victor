// The WEB embedded-Godot engine: services 3D ops through the page's Godot HTML5
// export (via `globalThis.__ElpianGodotWeb`) and binds each `Scene3D` surface to
// the `<canvas>` the DomWidgetRenderer created for it. This is the browser twin
// of GodotScene3dEngineCore — same op vocabulary, same handle-echo contract — so
// one guest program's 3D runs identically on web and device.
//
// React-free (no `renderSurface`): on the zero-React web path the surface *is*
// the DOM canvas the WidgetSink already mounted, so the engine attaches to that
// element rather than drawing a React node. `resolveSurface` maps a surface id
// to its canvas (wired to DomWidgetRenderer.elementFor by mountDom).

import type { Op, Wire } from "../core/protocol.ts";
import type { Scene3dEngine } from "../core/scene3dEngine.ts";
import { getElpianGodotWeb, type ElpianGodotWeb } from "./webGodotBinding.ts";

/** Resolve a surface id to the canvas element hosting its viewport. */
export type SurfaceResolver = (surfaceId: number) => unknown | null;

export class WebGodotEngine implements Scene3dEngine {
  private native: ElpianGodotWeb;
  private resolveSurface: SurfaceResolver;

  constructor(
    resolveSurface: SurfaceResolver,
    native: ElpianGodotWeb = requireWeb(),
  ) {
    this.resolveSurface = resolveSurface;
    this.native = native;
  }

  /** True when a Godot HTML5 export is loaded and has installed its binding. */
  static isAvailable(): boolean {
    return getElpianGodotWeb() !== null;
  }

  op(op: Op): Wire {
    this.native.op(JSON.stringify(op));
    // Echo the handle the guest allocated (creates carry `def`; `self`/`tree`
    // do too); everything else the guest tolerates as null.
    return typeof op.def === "number" && op.def !== 0 ? op.def : null;
  }

  batch(ops: Op[]): Wire[] {
    return ops.map((o) => this.op(o));
  }

  mountSurface(surfaceId: number, mountNode: number): void {
    // The canvas may not exist yet if the mount op precedes the widget create;
    // pass null and let the export bind lazily when the surface first draws.
    const canvas = this.resolveSurface(surfaceId) ?? null;
    this.native.mountSurface(surfaceId, canvas, mountNode);
  }

  releaseSurface(surfaceId: number): void {
    this.native.releaseSurface(surfaceId);
  }
}

function requireWeb(): ElpianGodotWeb {
  const native = getElpianGodotWeb();
  if (!native) {
    throw new Error(
      "The web embedded-Godot export (__ElpianGodotWeb) is not loaded on this " +
        "page. Load web/godot/elpian_godot.js, or Scene3D surfaces stay blank.",
    );
  }
  return native;
}
