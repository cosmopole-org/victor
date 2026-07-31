// The embedded Godot engine seam — how a Victor React Native app keeps *all* of
// Godot's 3D. `godot.op`/`godot.batch` calls (emitted by the unchanged
// `godot.js` / `G3` prelude when a guest builds the contents of an `RN.Scene3D`)
// are forwarded here. An implementation drives a real Godot 4 engine:
//
//   • web / Expo web  — a Godot HTML5 export in an offscreen canvas; ops are
//     posted to it and it replies over `postMessage` (see `scene3d/WebGodot`).
//   • native (iOS/Android/desktop) — a Godot library rendered into a native
//     view exposed as an Expo module; ops cross via JSI (see `scene3d/` seam).
//
// The op vocabulary is identical to the Godot bridge's, so the existing C++
// `GodotController` reflective interpreter can be reused verbatim on the engine
// side — this host only transports the ops and pairs each `Scene3D` widget with
// a viewport/camera into the shared 3D world.

import type { Op, Wire } from "./protocol.ts";

export interface Scene3dEngine {
  /** Service one 3D op, returning its (already-unmarshaled) result. */
  op(op: Op): Wire;
  /** Service a batch of 3D ops in one crossing. */
  batch(ops: Op[]): Wire[];
  /**
   * Bind a `Scene3D` widget to a viewport into the 3D world. `mountNode` is the
   * guest-allocated Godot node handle it adds 3D content under (a camera, a
   * viewport root); the engine registers it so later `godot.op` calls on that
   * handle resolve. Called by the dispatcher on the `scene3d_mount` method.
   */
  mountSurface(surfaceId: number, mountNode: number): void;
  /** Release a surface's viewport when its `Scene3D` widget is freed. */
  releaseSurface(surfaceId: number): void;
}

/**
 * A no-engine implementation: records ops and hands out monotonic node handles
 * so the whole 2D+3D pipeline is exercisable in tests and on platforms where
 * the Godot engine artifact is not present. On such platforms an `RN.Scene3D`
 * renders as an empty placeholder surface; the 2D app is otherwise fully live.
 */
export class MockScene3dEngine implements Scene3dEngine {
  readonly ops: Op[] = [];
  private nextNode = 1_000_000; // 3D node handles when the guest doesn't supply one
  /** surfaceId -> bound Godot mount-node handle. */
  readonly surfaces = new Map<number, number>();

  op(op: Op): Wire {
    this.ops.push(op);
    // Echo the guest-allocated `def` for object-creating ops so guest code keeps
    // flowing; mint one only if the guest didn't (host-minted handles).
    if (op.new !== undefined || op.self === true || op.tree === true) {
      return op.def && op.def !== 0 ? (op.def as number) : this.nextNode++;
    }
    return null;
  }

  batch(ops: Op[]): Wire[] {
    return ops.map((o) => this.op(o));
  }

  mountSurface(surfaceId: number, mountNode: number): void {
    this.surfaces.set(surfaceId, mountNode || this.nextNode++);
  }

  releaseSurface(surfaceId: number): void {
    this.surfaces.delete(surfaceId);
  }
}
