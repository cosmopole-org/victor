// The op-servicing half of the native Godot engine, kept React-free so it stays
// Node-testable (the `.tsx` subclass adds `renderSurface`). It forwards every
// `godot.op`/`godot.batch`/`scene3d_mount` the host dispatcher routes here to
// the synchronous native binding (`globalThis.__ElpianGodot`), which drives a
// real Godot 3D world — the same reflective GodotController proven headless in
// `bridge/extension` (see the Godot Scene3D CI test).

import type { Op, Wire } from "../core/protocol.ts";
import type { Scene3dEngine } from "../core/scene3dEngine.ts";
import { getElpianGodotNative, type ElpianGodotNative } from "./godotBinding.ts";

/** Services 3D ops through the native Godot binding. */
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
    return parseReply(this.native.op(JSON.stringify(op)));
  }

  batch(ops: Op[]): Wire[] {
    const reply = parseReply(this.native.batch(JSON.stringify(ops)));
    // A well-formed reply is one Wire per op; fall back to nulls on a mismatch
    // so a malformed batch reply never desyncs the guest's handle expectations.
    return Array.isArray(reply) && reply.length === ops.length
      ? (reply as Wire[])
      : ops.map(() => null);
  }

  mountSurface(surfaceId: number, mountNode: number): void {
    this.native.mountSurface(surfaceId, mountNode);
  }

  releaseSurface(surfaceId: number): void {
    this.native.releaseSurface(surfaceId);
  }
}

/** Parse a native JSON reply; an empty/invalid reply becomes `null`. */
function parseReply(reply: string): Wire {
  if (!reply) return null;
  try {
    return JSON.parse(reply) as Wire;
  } catch {
    return null;
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
