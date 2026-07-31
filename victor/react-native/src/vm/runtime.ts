// The runtime ties the VM backend, the host dispatcher and a per-frame pump into
// one object the UI layer drives. It owns the animation loop that advances guest
// timers/microtasks and coalesces widget-tree changes into one React commit per
// frame. Framework-agnostic (uses global rAF when present) so it stays Node-safe.

import { HostDispatcher } from "../core/hostDispatcher.ts";
import { MockScene3dEngine, type Scene3dEngine } from "../core/scene3dEngine.ts";
import type { VmBackend } from "./backend.ts";

export interface RuntimeOptions {
  lang?: "js" | "dart";
  prepend?: boolean;
  scene3d?: Scene3dEngine;
  onLog?: (line: string) => void;
}

export class ElpianRuntime {
  readonly dispatcher: HostDispatcher;
  private backend: VmBackend;
  private onLog?: (line: string) => void;
  private running = false;
  private dirty = false;
  private lastTs = 0;
  private rafId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(backend: VmBackend, opts: RuntimeOptions = {}) {
    this.backend = backend;
    this.onLog = opts.onLog;
    this.dispatcher = new HostDispatcher(opts.scene3d ?? new MockScene3dEngine());
    // Coalesce: ops mark the tree dirty; the frame loop commits once per frame
    // (React batches the re-render). Before the loop starts, commit eagerly.
    this.dispatcher.commit = () => {
      if (this.running) this.dirty = true;
      else this.dispatcher.store.flush();
    };
    // Widget events route back into the VM through invoke().
    this.dispatcher.setInvokeSink((fn, arg) => this.backend.invoke(fn, arg));
  }

  /** Boot the guest program and start pumping. */
  start(source: string, opts: RuntimeOptions = {}): void {
    const lang = opts.lang ?? "js";
    const prepend = opts.prepend ?? true;
    this.backend.create(source, lang, prepend, (n, a) => this.dispatcher.handle(n, a));
    this.backend.run();
    this.drainLog();
    this.dispatcher.store.flush(); // initial mount
    this.startLoop();
  }

  /** Fire a widget event from the renderer (e.g. a Pressable onPress). */
  fireEvent(widgetId: number, event: string, arg: unknown = null): void {
    this.dispatcher.fireEvent(widgetId, event, arg as never);
    // Deliver immediately, then let the next frame commit any resulting changes.
    this.drainLog();
    this.dirty = true;
    if (!this.running) this.dispatcher.store.flush();
  }

  stats(): unknown {
    return this.backend.stats();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.rafId = null;
    this.timer = null;
    this.backend.free();
  }

  // --- internals ---------------------------------------------------------
  private startLoop(): void {
    this.running = true;
    this.lastTs =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const raf =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
    if (raf) {
      const step = (ts: number) => {
        if (!this.running) return;
        this.frame(ts);
        this.rafId = raf(step);
      };
      this.rafId = raf(step);
    } else {
      // Node / headless: a ~60fps interval keeps timers advancing.
      this.timer = setInterval(() => {
        if (!this.running) return;
        this.frame(Date.now());
      }, 16);
    }
  }

  private frame(ts: number): void {
    const dt = Math.max(0, ts - this.lastTs);
    this.lastTs = ts;
    this.backend.pump(dt);
    this.drainLog();
    if (this.dirty) {
      this.dirty = false;
      this.dispatcher.store.flush();
    }
  }

  private drainLog(): void {
    const lines = this.backend.takeLog();
    if (this.onLog) for (const l of lines) this.onLog(l);
  }
}
