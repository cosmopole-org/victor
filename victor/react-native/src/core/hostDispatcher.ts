// The host dispatcher — this host's answer to the C++ `GodotController`. It is
// the single seam the wasm VM calls out to (`host_call`) and it interprets the
// op protocol against two object models: the React Native widget tree
// (`rn.op`) and the embedded Godot engine (`godot.op`). Governance is preserved
// for free: the manager has already namespaced handles/callbacks and stamped
// each op with the caller's sandbox root (`__sbx`), so we simply honor it.
//
// Framework-agnostic (no `react-native` import) → unit-testable under Node.

import {
  isCb,
  isRef,
  type Op,
  type Wire,
  wireError,
} from "./protocol.ts";
import { WidgetStore } from "./widgetStore.ts";
import type { WidgetSink, WidgetRenderer } from "./widgetSink.ts";
import type { Scene3dEngine } from "./scene3dEngine.ts";

/** Called to push a guest function invocation back into the VM. */
export type InvokeSink = (fnName: string, argJson: string) => void;

export class HostDispatcher {
  readonly store = new WidgetStore();
  readonly log: string[] = [];
  private engine: Scene3dEngine;
  private invokeSink: InvokeSink = () => {};
  /**
   * Where widget ops go. A native/DOM renderer (`opts.widgets`) drives the
   * platform's own widgets directly; otherwise the retained WidgetStore backs
   * the React `<VictorHost/>`. Sandbox governance stays on the store (only
   * exercised by mini-app spawning, which uses the store path).
   */
  private readonly sink: WidgetSink;
  private readonly widgets?: WidgetRenderer;
  /**
   * Event callbacks by `${widgetId}:${event}` → cb id. Tracked here (not only in
   * the store) so events fire back into the VM on the native/DOM sink path too,
   * where `connect` goes to the platform renderer and never touches the store.
   */
  private readonly eventCbs = new Map<string, number>();
  /** Overridable commit strategy — the runtime debounces to one flush/frame. */
  commit: () => void;
  /** Diagnostics (on-device overlay): rn.ops handled, fireEvent calls, invokes. */
  rnOpCount = 0;
  fireCount = 0;
  invokeCount = 0;
  lastFireMiss: string | null = null;

  constructor(engine: Scene3dEngine, widgets?: WidgetRenderer) {
    this.engine = engine;
    this.widgets = widgets;
    this.sink = widgets ?? this.store;
    this.commit = widgets ? () => widgets.flush() : () => this.store.flush();
  }

  setInvokeSink(fn: InvokeSink): void {
    this.invokeSink = fn;
  }

  // --- the wasm host_call contract: (name, argsJson) -> replyJson | null ---
  handle(name: string, argsJson: string): string | null {
    let args: Wire[];
    try {
      args = JSON.parse(argsJson) as Wire[];
    } catch {
      return null;
    }
    switch (name) {
      case "log": {
        this.log.push(String(args[0] ?? ""));
        return null;
      }
      case "rn.op": {
        this.rnOpCount++;
        const r = this.execRn(args[0] as Op);
        this.commit();
        return r === null || r === undefined ? null : JSON.stringify(r);
      }
      case "rn.batch": {
        const ops = (args[0] as Op[]) ?? [];
        this.rnOpCount += ops.length;
        const results = ops.map((o) => this.execRn(o));
        this.commit();
        return JSON.stringify(results);
      }
      case "godot.op": {
        const r = this.execGodot(args[0] as Op);
        return r === null || r === undefined ? null : JSON.stringify(r);
      }
      case "godot.batch": {
        const ops = (args[0] as Op[]) ?? [];
        const results = ops.map((o) => this.execGodot(o));
        return JSON.stringify(results);
      }
      default:
        return null;
    }
  }

  // --- widget-tree op interpreter ---------------------------------------
  private execRn(op: Op): Wire {
    if (!op || typeof op !== "object") return null;
    const sbx = op.__sbx ?? 0;

    if (op.chk !== undefined) return this.store.containedIn(op.chk, sbx);
    if (op.grant !== undefined) return this.store.addOwner(op.grant, op.sbx ?? 0);

    if (op.new !== undefined && op.def !== undefined) {
      this.sink.create(op.def, op.new, sbx);
      return op.def;
    }
    if (op.self === true) {
      // A sandboxed VM's "self" is its assigned root widget; the root VM has no
      // single widget self (it mounts one via `root`).
      return sbx ? { ref: sbx } : null;
    }
    if (op.root !== undefined) {
      // The mounted handle rides on `ref` (namespaced by the manager); older
      // callers that put the id directly on `root` are still honored.
      const rid =
        op.ref !== undefined
          ? op.ref
          : typeof op.root === "number"
            ? op.root
            : 0;
      if (rid) this.sink.setRoot(rid);
      return null;
    }
    if (op.toast !== undefined) {
      this.sink.toast(op.toast);
      return null;
    }

    if (op.ref !== undefined) {
      const ref = op.ref;
      if (!this.reachable(ref, sbx)) {
        return wireError(`rn.op: widget ${ref} is outside this VM's sandbox`);
      }
      if (op.set !== undefined) {
        this.sink.setProp(ref, op.set, this.unwrap(op.value));
        return null;
      }
      if (op.props !== undefined) {
        this.applyProps(ref, op.props);
        return null;
      }
      if (op.get !== undefined) {
        return this.sink.getProp(ref, op.get);
      }
      if (op.connect !== undefined && op.cb !== undefined) {
        this.sink.connect(ref, op.connect, op.cb);
        this.eventCbs.set(cbKey(ref, op.connect), op.cb);
        return null;
      }
      if (op.disconnect !== undefined) {
        this.sink.disconnect(ref, op.disconnect);
        this.eventCbs.delete(cbKey(ref, op.disconnect));
        return null;
      }
      if (op.free !== undefined) {
        this.sink.free(ref);
        this.forgetCallbacks(ref);
        return null;
      }
      if (op.method !== undefined) {
        return this.execMethod(ref, op.method, op.args ?? []);
      }
    }
    return null;
  }

  private execMethod(ref: number, method: string, args: Wire[]): Wire {
    switch (method) {
      case "add_child": {
        const child = childId(args[0]);
        if (child) this.sink.addChild(ref, child);
        return null;
      }
      case "insert_child": {
        const child = childId(args[0]);
        const index = typeof args[1] === "number" ? args[1] : undefined;
        if (child) this.sink.addChild(ref, child, index);
        return null;
      }
      case "remove_child": {
        const child = childId(args[0]);
        if (child) this.sink.removeChild(ref, child);
        return null;
      }
      case "clear_children": {
        this.sink.clearChildren(ref);
        return null;
      }
      case "scene3d_mount": {
        // The guest allocated the Godot mount-node handle and passed it in;
        // bind the surface to it and register it as a 3D node so later
        // godot.op calls on the same handle resolve.
        const mountNode = childId(args[0]);
        this.engine.mountSurface(ref, mountNode);
        return null;
      }
      default:
        return null;
    }
  }

  // Props that are event callbacks (`onPress: {cb}`) register as events; the
  // rest are stored verbatim for the renderer.
  private applyProps(ref: number, props: Record<string, Wire>): void {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (key.length > 2 && key.startsWith("on") && isCb(value)) {
        const ev = eventName(key);
        this.sink.connect(ref, ev, value.cb);
        this.eventCbs.set(cbKey(ref, ev), value.cb);
      } else {
        this.sink.setProp(ref, key, this.unwrap(value));
      }
    }
  }

  private unwrap(v: Wire | undefined): Wire {
    return v === undefined ? null : v;
  }

  /** Drop every event callback bound to a freed widget. */
  private forgetCallbacks(ref: number): void {
    const prefix = `${ref}:`;
    for (const key of this.eventCbs.keys()) {
      if (key.startsWith(prefix)) this.eventCbs.delete(key);
    }
  }

  private reachable(ref: number, sbx: number): boolean {
    if (sbx === 0) return true;
    if (this.store.containedIn(ref, sbx)) return true;
    return this.store.get(ref)?.owners.includes(sbx) ?? false;
  }

  // --- 3D op interpreter (forward to the embedded Godot engine) ----------
  private execGodot(op: Op): Wire {
    if (!op || typeof op !== "object") return null;
    const sbx = op.__sbx ?? 0;
    // Sandbox probes may target a widget (a 2D child VM's assigned node) or a
    // 3D node; resolve against the widget tree first, else the engine.
    if (op.chk !== undefined) {
      if (this.store.has(op.chk)) return this.store.containedIn(op.chk, sbx);
      return this.engine.op(op);
    }
    if (op.grant !== undefined) {
      if (this.store.has(op.grant)) return this.store.addOwner(op.grant, op.sbx ?? 0);
      return this.engine.op(op);
    }
    return this.engine.op(op);
  }

  // --- event delivery (renderer -> VM) -----------------------------------
  /** Fire a widget event: route it to the owning VM's guest closure. */
  fireEvent(widgetId: number, event: string, arg: Wire): void {
    this.fireCount++;
    const cb =
      this.eventCbs.get(cbKey(widgetId, event)) ||
      this.store.callbackFor(widgetId, event);
    if (!cb) {
      this.lastFireMiss = `${widgetId}:${event}`;
      return;
    }
    this.invokeCount++;
    // Mirror the Godot signal path: __godotDispatch([cbId, arg]) — the manager
    // decodes the namespaced cb id and routes to the VM that owns it.
    this.invokeSink("__godotDispatch", JSON.stringify([cb, arg ?? null]));
  }
}

function childId(v: Wire): number {
  return isRef(v) ? v.ref : typeof v === "number" ? v : 0;
}

/** Registry key for an event callback: `${widgetId}:${event}`. */
function cbKey(ref: number, event: string): string {
  return `${ref}:${event}`;
}

/** "onChangeText" -> "changeText", "onPress" -> "press". */
function eventName(onName: string): string {
  const rest = onName.slice(2);
  return rest.slice(0, 1).toLowerCase() + rest.slice(1);
}
