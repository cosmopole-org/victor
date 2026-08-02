// The op-servicing half of the native Godot engine, kept React-free so it stays
// Node-testable (the `.tsx` subclass adds `renderSurface`). It enqueues every
// `godot.op`/`godot.batch`/`scene3d_mount` the host dispatcher routes here to
// the native binding (`globalThis.__ElpianGodot`), which feeds the embedded
// Godot engine — the same reflective GodotController proven headless in
// `bridge/extension` and `modules/elpian-godot/godot-project`.
//
// Handles are guest-allocated, so the reply the guest needs is just the `def`
// it already chose; we echo it synchronously here while the engine renders the
// op a frame later. No synchronous call into Godot.

import type { Op, Wire } from "../core/protocol.ts";
import type { Scene3dEngine } from "../core/scene3dEngine.ts";
import { getElpianGodotNative, type ElpianGodotNative } from "./godotBinding.ts";

/** Services 3D ops by enqueuing them for the embedded Godot engine. */
export class GodotScene3dEngineCore implements Scene3dEngine {
  protected native: ElpianGodotNative;

  constructor(native: ElpianGodotNative = requireGodotNative()) {
    this.native = native;
  }

  /** True when the native embedded-Godot binding is installed on this platform. */
  static isAvailable(): boolean {
    return getElpianGodotNative() !== null;
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
    this.native.mountSurface(surfaceId, mountNode);
  }

  releaseSurface(surfaceId: number): void {
    this.native.releaseSurface(surfaceId);
  }
}

function requireGodotNative(): ElpianGodotNative {
  const native = getElpianGodotNative();
  if (!native) {
    throw new Error(
      "The native embedded-Godot backend (__ElpianGodot) is not installed on " +
        "this platform. Build a dev/release APK that bundles the Godot library " +
        "module, or Scene3D surfaces fall back to the placeholder.",
    );
  }
  return native;
}
