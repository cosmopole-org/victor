// VictorMiniAppsController — an object-oriented controller for a set of Elpian
// mini apps. This is the imperative counterpart to the declarative
// `<VictorMiniApps apps={…}/>` prop: instead of handing the component a snapshot
// array of mini-app definitions on every render, an Expo app constructs ONE
// controller, holds onto it, and drives the set through method calls —
// add / remove / update / start / stop / restart — while `<VictorMiniApps
// controller={…}/>` simply renders whatever the controller currently holds.
//
//   const controller = new VictorMiniAppsController({ wasm: loadWasmBytes });
//   await controller.ready();
//   controller.add({ id: "clock",   source: clockElpianJs });
//   controller.add({ id: "counter", source: counterElpianJs });
//   // …later, from anywhere in the app (a button handler, a socket message):
//   controller.replaceSource("counter", newCounterJs);   // restarts just it
//   controller.stop("clock");                             // frees just its VM
//   controller.remove("clock");
//
//   return <VictorMiniApps controller={controller} width="100%" height={480} />;
//
// The controller owns the shared VictorEngine (one compiled VM module) and each
// mini app's isolated runtime, and reconciles lifecycle exactly as the component
// used to internally: adding boots a VM, removing frees it, changing a program's
// source restarts just that mini app — the rest keep running untouched. It
// notifies subscribers (the React component, or any listener) on every change.

import { VictorEngine } from "./engine.ts";
import type { MiniAppDef } from "./VictorMiniApps.tsx";
import type { ElpianRuntime } from "../vm/runtime.ts";
import type { RnScene3dEngine } from "../scene3d/engine.ts";

/** Lifecycle state of a single mini app, derived from the controller's book-keeping. */
export type MiniAppStatus =
  /** Wants to run but the shared engine hasn't finished loading yet. */
  | "pending"
  /** Booted and pumping. */
  | "running"
  /** Present in the set but intentionally not running (never started or stopped). */
  | "stopped"
  /** Its last boot threw; `error` holds the cause. */
  | "error";

/** A read-only view of one managed mini app. Recomputed on read; never stale. */
export interface MiniAppHandle {
  readonly id: string;
  /** The definition currently in effect (source/lang/sizing). */
  readonly def: MiniAppDef;
  readonly status: MiniAppStatus;
  /** The live runtime once booted, else null (pending/stopped/error). */
  readonly runtime: ElpianRuntime | null;
  /** The cause when `status === "error"`, else null. */
  readonly error: unknown | null;
}

export interface VictorMiniAppsControllerOptions {
  /** A preloaded engine, OR `wasm` to load one internally. */
  engine?: VictorEngine;
  /** `elpian_rn.wasm` bytes, or a loader returning them. Ignored if `engine` set. */
  wasm?: BufferSource | (() => Promise<BufferSource>);
  /** Embedded-Godot engine for any `Scene3D` a mini app builds. */
  scene3dEngine?: RnScene3dEngine;
  /** Per-mini-app log sink. */
  onLog?: (appId: string, line: string) => void;
  /**
   * Host-side service for guest `askHost("host.call", …)` requests, scoped per
   * mini app (the app's id is the first argument). This is the seam a Decillion
   * "desktop" uses to sign a tool frontend's Caspar request with the human
   * user's identity — the mini app asks, the host performs and returns the
   * value. Absent → every `host.call` from any mini app fails cleanly.
   */
  onHostCall?: (appId: string, method: string, payload: unknown) => Promise<unknown> | unknown;
  /** Called if the shared VM module fails to load. */
  onError?: (error: unknown) => void;
  /** Called after any change to the set (add/remove/update/start/stop/engine-ready). */
  onChange?: (apps: MiniAppHandle[]) => void;
}

/** Options accepted when adding a mini app. */
export interface AddOptions {
  /** Boot it immediately (default true). `false` adds it in the "stopped" state. */
  start?: boolean;
}

// Internal per-mini-app record. `wantRunning` is the intent; `runtime` is the
// realization (null until booted / after stop). Keeping them separate lets an
// app be added before the engine is ready (pending) and boot automatically once
// it loads.
interface Entry {
  id: string;
  def: MiniAppDef;
  source: string;
  lang: "js" | "dart";
  wantRunning: boolean;
  runtime: ElpianRuntime | null;
  error: unknown | null;
}

export class VictorMiniAppsController {
  private opts: VictorMiniAppsControllerOptions;
  private engineRef: VictorEngine | null = null;
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private listeners = new Set<() => void>();
  private disposed = false;
  private engineReady: Promise<VictorEngine>;
  private resolveReady!: (e: VictorEngine) => void;
  private rejectReady!: (e: unknown) => void;
  /** Bumped on every change; the stable snapshot for `useSyncExternalStore`. */
  version = 0;

  constructor(opts: VictorMiniAppsControllerOptions = {}) {
    this.opts = opts;
    this.engineReady = new Promise<VictorEngine>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    // Avoid an unhandled-rejection if no one awaits ready() and load fails;
    // onError still reports it.
    this.engineReady.catch(() => {});
    if (opts.engine) {
      this.attachEngine(opts.engine);
    } else if (opts.wasm) {
      void this.loadEngine(opts.wasm);
    }
  }

  // --- engine lifecycle --------------------------------------------------

  private async loadEngine(wasm: NonNullable<VictorMiniAppsControllerOptions["wasm"]>): Promise<void> {
    try {
      const bytes = typeof wasm === "function" ? await wasm() : wasm;
      const engine = await VictorEngine.load(bytes);
      if (this.disposed) return;
      this.attachEngine(engine);
    } catch (e) {
      if (this.disposed) return;
      this.rejectReady(e);
      this.opts.onError?.(e);
    }
  }

  private attachEngine(engine: VictorEngine): void {
    this.engineRef = engine;
    this.resolveReady(engine);
    // Boot every app that was added while we waited for the module.
    for (const id of this.order) {
      const e = this.entries.get(id)!;
      if (e.wantRunning && !e.runtime) this.boot(e);
    }
    this.notify();
  }

  /** The shared engine, once loaded (else null). */
  get engine(): VictorEngine | null {
    return this.engineRef;
  }

  /** The embedded-Godot engine passed at construction, if any. */
  get scene3dEngine(): RnScene3dEngine | undefined {
    return this.opts.scene3dEngine;
  }

  /** True once the shared VM module has compiled and mini apps can boot. */
  isReady(): boolean {
    return this.engineRef !== null;
  }

  /** Resolves with the engine once loaded; rejects if the module fails to load. */
  ready(): Promise<VictorEngine> {
    return this.engineReady;
  }

  // --- CRUD + lifecycle --------------------------------------------------

  /**
   * Add a mini app (booting it unless `start:false`). If one with the same id
   * already exists it is updated in place (same semantics as {@link update}).
   */
  add(def: MiniAppDef, opts: AddOptions = {}): MiniAppHandle {
    this.assertLive();
    const existing = this.entries.get(def.id);
    if (existing) {
      return this.update(def.id, def)!;
    }
    const entry: Entry = {
      id: def.id,
      def,
      source: def.source,
      lang: def.lang ?? "js",
      wantRunning: opts.start !== false,
      runtime: null,
      error: null,
    };
    this.entries.set(def.id, entry);
    this.order.push(def.id);
    if (entry.wantRunning) this.boot(entry);
    this.notify();
    return this.handle(entry);
  }

  /** Add several mini apps in order. */
  addAll(defs: MiniAppDef[], opts: AddOptions = {}): MiniAppHandle[] {
    return defs.map((d) => this.add(d, opts));
  }

  /** Remove a mini app, freeing its VM. Returns true if it existed. */
  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.teardown(entry);
    this.entries.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.notify();
    return true;
  }

  /** Remove every mini app, freeing all their VMs. */
  clear(): void {
    for (const id of [...this.order]) {
      const entry = this.entries.get(id);
      if (entry) this.teardown(entry);
    }
    this.entries.clear();
    this.order = [];
    this.notify();
  }

  /**
   * Patch a mini app's definition. Changing `source` or `lang` restarts just
   * that mini app (if it is meant to be running); changing only sizing hints
   * (`flex`/`width`/`height`) re-renders without touching the VM. No-op for an
   * unknown id (returns null).
   */
  update(id: string, patch: Partial<Omit<MiniAppDef, "id">>): MiniAppHandle | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const nextDef: MiniAppDef = { ...entry.def, ...patch, id };
    const nextSource = nextDef.source;
    const nextLang = nextDef.lang ?? "js";
    const codeChanged = nextSource !== entry.source || nextLang !== entry.lang;
    entry.def = nextDef;
    entry.source = nextSource;
    entry.lang = nextLang;
    if (codeChanged && entry.wantRunning) {
      // Restart in place: free the old VM, boot the new program.
      this.teardown(entry);
      this.boot(entry);
    }
    this.notify();
    return this.handle(entry);
  }

  /** Shorthand for {@link update} with a new program (and optional language). */
  replaceSource(id: string, source: string, lang?: "js" | "dart"): MiniAppHandle | null {
    return this.update(id, lang ? { source, lang } : { source });
  }

  /** Boot (or reboot) a mini app that is present but not running. */
  start(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.wantRunning = true;
    if (!entry.runtime) this.boot(entry);
    this.notify();
  }

  /** Stop a mini app, freeing its VM but keeping it in the set (restartable). */
  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.wantRunning = false;
    this.teardown(entry);
    this.notify();
  }

  /** Free and re-boot a mini app from its current source. */
  restart(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.wantRunning = true;
    this.teardown(entry);
    this.boot(entry);
    this.notify();
  }

  // --- queries -----------------------------------------------------------

  /** A live view of one mini app, or null if unknown. */
  get(id: string): MiniAppHandle | null {
    const entry = this.entries.get(id);
    return entry ? this.handle(entry) : null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Every mini app, in insertion order. */
  list(): MiniAppHandle[] {
    return this.order.map((id) => this.handle(this.entries.get(id)!));
  }

  /** Ids in insertion order. */
  ids(): string[] {
    return [...this.order];
  }

  /** The live runtime for a mini app (null until booted / after stop). */
  runtime(id: string): ElpianRuntime | null {
    return this.entries.get(id)?.runtime ?? null;
  }

  /** A JSON snapshot of a mini app's VM usage (null if not running). */
  stats(id: string): unknown {
    return this.entries.get(id)?.runtime?.stats() ?? null;
  }

  // --- declarative bridge ------------------------------------------------

  /**
   * Reconcile the whole set against `defs` (add new, remove missing, restart
   * redefined) and adopt `defs` order. This is what the component's declarative
   * `apps={…}` prop drives; imperative callers normally use the CRUD methods
   * instead.
   */
  setApps(defs: MiniAppDef[]): void {
    const desired = new Set(defs.map((d) => d.id));
    // Remove any that vanished.
    for (const id of [...this.order]) {
      if (!desired.has(id)) {
        const entry = this.entries.get(id);
        if (entry) this.teardown(entry);
        this.entries.delete(id);
      }
    }
    // Upsert each desired app (add or update-in-place).
    for (const def of defs) {
      const entry = this.entries.get(def.id);
      if (!entry) {
        const e: Entry = {
          id: def.id,
          def,
          source: def.source,
          lang: def.lang ?? "js",
          wantRunning: true,
          runtime: null,
          error: null,
        };
        this.entries.set(def.id, e);
        if (e.wantRunning) this.boot(e);
      } else {
        const nextLang = def.lang ?? "js";
        const codeChanged = def.source !== entry.source || nextLang !== entry.lang;
        entry.def = def;
        entry.source = def.source;
        entry.lang = nextLang;
        if (codeChanged && entry.wantRunning) {
          this.teardown(entry);
          this.boot(entry);
        }
      }
    }
    // Adopt defs order.
    this.order = defs.map((d) => d.id);
    this.notify();
  }

  // --- subscription ------------------------------------------------------

  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Free every mini app's VM and drop all subscribers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.teardown(entry);
    this.entries.clear();
    this.order = [];
    this.listeners.clear();
  }

  // --- internals ---------------------------------------------------------

  private boot(entry: Entry): void {
    const engine = this.engineRef;
    if (!engine) return; // stays pending until the engine loads
    const lang = entry.lang;
    const onHostCall = this.opts.onHostCall;
    const runtime = engine.createRuntime({
      lang,
      scene3d: this.opts.scene3dEngine,
      onLog: (line) => this.opts.onLog?.(entry.id, line),
      // Bind the bridge to this mini app's id so the host knows which frontend
      // (and thus which tool/creature) is asking.
      ...(onHostCall
        ? { onHostCall: (method: string, payload: unknown) => onHostCall(entry.id, method, payload) }
        : {}),
    });
    try {
      runtime.start(entry.source, { lang });
      entry.runtime = runtime;
      entry.error = null;
    } catch (e) {
      try {
        runtime.stop();
      } catch {
        /* best-effort cleanup */
      }
      entry.runtime = null;
      entry.error = e;
      this.opts.onLog?.(entry.id, "[error] " + String(e));
    }
  }

  private teardown(entry: Entry): void {
    if (entry.runtime) {
      try {
        entry.runtime.stop();
      } catch {
        /* best-effort */
      }
      entry.runtime = null;
    }
    entry.error = null;
  }

  private statusOf(entry: Entry): MiniAppStatus {
    if (entry.error) return "error";
    if (entry.runtime) return "running";
    if (entry.wantRunning && !this.engineRef) return "pending";
    return "stopped";
  }

  private handle(entry: Entry): MiniAppHandle {
    return {
      id: entry.id,
      def: entry.def,
      status: this.statusOf(entry),
      runtime: entry.runtime,
      error: entry.error,
    };
  }

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
    this.opts.onChange?.(this.list());
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("VictorMiniAppsController is disposed");
  }
}

/** Factory mirroring the constructor, for call sites that prefer a function. */
export function createMiniAppsController(
  opts: VictorMiniAppsControllerOptions = {},
): VictorMiniAppsController {
  return new VictorMiniAppsController(opts);
}
