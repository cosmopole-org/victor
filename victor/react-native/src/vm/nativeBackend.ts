// The on-device VM backend. Hermes has no WebAssembly, so instead of the
// `elpian_rn.wasm` module (`WasmBackend`) the native app links the same Rust VM
// as a shared library (`libelpian_rn.so`, built from `native/elpian-rn`) and a
// small JSI module installs a synchronous binding on the global object. This
// class is the `VmBackend` over that binding — the exact native mirror of
// `WasmBackend`, only the transport differs (JSI host functions instead of a
// wasm instance + linear memory).
//
// The binding is synchronous on purpose: the guest blocks on each host call's
// reply (e.g. a `godot.op` returns a node handle), so the seam must be JSI, not
// the async React Native bridge. `host` is handed to `create` and the native
// side invokes it — via the Rust `elpian_rn_set_host` C seam — for every
// forwarded guest host call, returning its JSON reply (or `null` to decline).

import type { HostCall, VmBackend } from "./backend.ts";

/**
 * The JSI binding the native module installs (see
 * `native/modules/elpian-rn-jsi`). Every method is synchronous. `rt` is the
 * opaque runtime handle `create` returns (0 = failure).
 */
export interface ElpianRnNative {
  create(
    source: string,
    lang: string,
    prepend: boolean,
    host: (name: string, argsJson: string) => string | null,
  ): number;
  run(rt: number): void;
  pump(rt: number, deltaMs: number): void;
  invoke(rt: number, fnName: string, argJson: string): void;
  takeLog(rt: number): string[];
  stats(rt: number): string;
  lastError(rt: number): string;
  free(rt: number): void;
}

/** The global the JSI module installs when the native library loads. */
declare global {
  // eslint-disable-next-line no-var
  var __ElpianRN: ElpianRnNative | undefined;
}

/**
 * Resolve the installed native binding, or `null` when it is not present (web,
 * Expo Go, or a device build where the JSI module failed to install). Kept as a
 * function so callers can cheaply feature-detect the native path.
 */
export function getElpianRnNative(): ElpianRnNative | null {
  const g = globalThis as { __ElpianRN?: ElpianRnNative };
  return g.__ElpianRN ?? null;
}

/** Runs the real Elpian VM through the native JSI binding. */
export class NativeVmBackend implements VmBackend {
  private native: ElpianRnNative;
  private rt = 0;

  constructor(native: ElpianRnNative = requireNative()) {
    this.native = native;
  }

  /** True when the native library + JSI binding are installed on this platform. */
  static isAvailable(): boolean {
    return getElpianRnNative() !== null;
  }

  create(source: string, lang: string, prepend: boolean, host: HostCall): void {
    // Bind the dispatcher now: the native side calls `host` synchronously for
    // every guest host call, the same contract `WasmBackend` wires at instantiate.
    this.rt = this.native.create(source, lang, prepend, (n, a) => host(n, a));
    if (!this.rt) throw new Error(`native elpian create failed: ${this.lastError()}`);
  }

  run(): void {
    this.native.run(this.rt);
  }

  pump(deltaMs: number): void {
    this.native.pump(this.rt, Math.max(0, Math.round(deltaMs)));
  }

  invoke(fnName: string, argJson: string): void {
    this.native.invoke(this.rt, fnName, argJson);
  }

  takeLog(): string[] {
    return this.native.takeLog(this.rt) ?? [];
  }

  stats(): unknown {
    try {
      return JSON.parse(this.native.stats(this.rt));
    } catch {
      return null;
    }
  }

  lastError(): string {
    // Before a runtime exists there is nothing to query; guard the 0 handle.
    return this.rt ? this.native.lastError(this.rt) ?? "" : "";
  }

  free(): void {
    if (this.rt) {
      this.native.free(this.rt);
      this.rt = 0;
    }
  }
}

function requireNative(): ElpianRnNative {
  const native = getElpianRnNative();
  if (!native) {
    throw new Error(
      "The native Elpian VM backend (libelpian_rn) is not installed on this " +
        "platform. Build a dev/release APK that bundles the elpian-rn JSI " +
        "module, or run on Expo web (which uses the wasm backend).",
    );
  }
  return native;
}
