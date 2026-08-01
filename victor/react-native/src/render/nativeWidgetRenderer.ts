// The MOBILE platform WidgetSink: forwards the VM's widget ops to the native
// Android/iOS widget controller over a JSI binding (globalThis.__ElpianWidgets),
// which builds real android.view.View / UIView trees with Yoga flexbox layout —
// no React. Ops are enqueued fire-and-forget and applied on the UI thread; the
// guest's allocated handle needs no reply (creates carry their own id), so
// there is no synchronous cross-thread call. Native widget events are delivered
// back through a registered handler into the VM. This is the native twin of
// DomWidgetRenderer, over the same WidgetSink.

import type { Wire } from "../core/protocol.ts";
import type { WidgetRenderer } from "../core/widgetSink.ts";

/** The JSI binding the native widget module installs. */
export interface ElpianWidgetsNative {
  /** Enqueue one widget op (a JSON message) for the UI-thread controller. */
  op(messageJson: string): void;
  /**
   * Drain widget events the native controller queued (a JSON array of
   * `[widgetId, event, arg]`), applied on the JS thread each frame. Polling
   * avoids any native→JS cross-thread call.
   */
  pollEvents(): string;
  /** The registered native view component that hosts the widget tree. */
  viewName?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __ElpianWidgets: ElpianWidgetsNative | undefined;
}

export function getElpianWidgetsNative(): ElpianWidgetsNative | null {
  const g = globalThis as { __ElpianWidgets?: ElpianWidgetsNative };
  return g.__ElpianWidgets ?? null;
}

export interface NativeWidgetHost {
  /** Fire a widget event back into the VM (wired to runtime.fireEvent). */
  fire: (widgetId: number, event: string, arg?: Wire) => void;
}

export class NativeWidgetRenderer implements WidgetRenderer {
  private native: ElpianWidgetsNative;
  private host: NativeWidgetHost;

  constructor(host: NativeWidgetHost, native: ElpianWidgetsNative = requireNative()) {
    this.native = native;
    this.host = host;
  }

  static isAvailable(): boolean {
    return getElpianWidgetsNative() !== null;
  }

  private send(msg: Record<string, Wire>): void {
    this.native.op(JSON.stringify(msg));
  }

  create(id: number, className: string): void {
    this.send({ t: "create", id, cls: className });
  }
  setProp(id: number, key: string, value: Wire): void {
    this.send({ t: "set", id, k: key, v: value });
  }
  getProp(): Wire {
    // Async native tree: reply-consuming reads aren't serviced synchronously.
    return null;
  }
  connect(id: number, event: string, cb: number): void {
    this.send({ t: "connect", id, e: event, cb });
  }
  disconnect(id: number, event: string): void {
    this.send({ t: "disconnect", id, e: event });
  }
  addChild(parentId: number, childId: number, index?: number): void {
    this.send({ t: "add", p: parentId, c: childId, i: index ?? -1 });
  }
  removeChild(parentId: number, childId: number): void {
    this.send({ t: "remove", p: parentId, c: childId });
  }
  clearChildren(parentId: number): void {
    this.send({ t: "clear", p: parentId });
  }
  free(id: number): void {
    this.send({ t: "free", id });
  }
  setRoot(id: number): void {
    this.send({ t: "root", id });
  }
  toast(message: string): void {
    this.send({ t: "toast", m: message });
  }
  containedIn(): boolean {
    return true;
  }
  addOwner(): boolean {
    return true;
  }
  /** Applied each frame by the runtime: drain native widget events into the VM. */
  flush(): void {
    let json: string;
    try {
      json = this.native.pollEvents();
    } catch {
      return;
    }
    if (!json) return;
    let events: unknown;
    try {
      events = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      if (Array.isArray(ev) && typeof ev[0] === "number" && typeof ev[1] === "string") {
        this.host.fire(ev[0], ev[1], (ev[2] ?? null) as Wire);
      }
    }
  }
}

function requireNative(): ElpianWidgetsNative {
  const native = getElpianWidgetsNative();
  if (!native) {
    throw new Error(
      "The native widget backend (__ElpianWidgets) is not installed on this " +
        "platform. Build a dev/release APK that bundles the elpian-widgets module.",
    );
  }
  return native;
}
