// The WEB platform WidgetSink: turns the VM's rn.op stream into real DOM
// elements — no React. One instance owns the Victor subtree in a container; the
// VM directly creates/updates/removes native DOM nodes and sets their props,
// exactly the model the Godot side uses for 3D and the native controller uses
// for android.view.View. Layout is native CSS flexbox (RN's flex model maps
// straight onto it).
//
// It maps each widget KIND (from the shared catalog) to a DOM element per
// `WIDGET_CATALOG`. Structural DOM types keep this file free of a lib.dom
// dependency, so it type-checks in the React Native project while running
// against the real `document` on web.

import type { Wire } from "../core/protocol.ts";
import type { WidgetRenderer } from "../core/widgetSink.ts";
import { specFor, type WidgetKind } from "./rnComponents.ts";
import { toStyle } from "./style.ts";

// --- a minimal structural DOM (the real DOM / jsdom satisfy it) --------------
export interface DomEl {
  style: Record<string, string>;
  textContent: string | null;
  value?: string;
  checked?: boolean;
  type?: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomEl): void;
  insertBefore(child: DomEl, ref: DomEl | null): void;
  removeChild(child: DomEl): void;
  addEventListener(type: string, cb: (e: DomEvent) => void): void;
  removeEventListener(type: string, cb: (e: DomEvent) => void): void;
  childNodes: ArrayLike<DomEl>;
  firstChild: DomEl | null;
}
export interface DomEvent {
  target: DomEl;
}
export interface DomDocument {
  createElement(tag: string): DomEl;
}
export interface DomHost {
  document: DomDocument;
  /** The element the Victor root is mounted into. */
  container: DomEl;
  /** Fire a widget event back into the VM. */
  fire: (widgetId: number, event: string, arg?: Wire) => void;
}

interface Entry {
  el: DomEl;
  kind: WidgetKind;
  className: string;
  props: Record<string, Wire>;
  listeners: Map<string, (e: DomEvent) => void>;
}

// RN style keys whose numbers are CSS lengths (→ px).
const LENGTH_KEYS = new Set([
  "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
  "margin", "marginTop", "marginBottom", "marginLeft", "marginRight",
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "borderRadius", "borderWidth", "fontSize", "lineHeight", "letterSpacing",
  "top", "left", "right", "bottom", "gap", "rowGap", "columnGap", "flexBasis",
]);
// RN shorthands with no CSS equivalent → expand to the physical edges.
const EXPAND: Record<string, [string, string]> = {
  paddingHorizontal: ["paddingLeft", "paddingRight"],
  paddingVertical: ["paddingTop", "paddingBottom"],
  marginHorizontal: ["marginLeft", "marginRight"],
  marginVertical: ["marginTop", "marginBottom"],
};
// RN → DOM event names.
const DOM_EVENT: Record<string, string> = {
  press: "click",
  longPress: "contextmenu",
  changeText: "input",
  change: "change",
  valueChange: "change",
  submit: "submit",
  submitEditing: "change",
  focus: "focus",
  blur: "blur",
  scroll: "scroll",
};

export class DomWidgetRenderer implements WidgetRenderer {
  private host: DomHost;
  private entries = new Map<number, Entry>();
  private rootId = 0;

  constructor(host: DomHost) {
    this.host = host;
  }

  static isAvailable(): boolean {
    return typeof (globalThis as { document?: unknown }).document !== "undefined";
  }

  create(id: number, className: string): void {
    const kind = specFor(className)?.kind ?? "view";
    const el = this.make(kind);
    this.entries.set(id, { el, kind, className, props: {}, listeners: new Map() });
  }

  private make(kind: WidgetKind): DomEl {
    const d = this.host.document;
    switch (kind) {
      case "text":
        return d.createElement("span");
      case "image":
        return d.createElement("img");
      case "input": {
        const el = d.createElement("input");
        el.setAttribute("type", "text");
        return el;
      }
      case "switch": {
        const el = d.createElement("input");
        el.setAttribute("type", "checkbox");
        el.setAttribute("role", "switch");
        return el;
      }
      case "slider": {
        const el = d.createElement("input");
        el.setAttribute("type", "range");
        return el;
      }
      case "button":
      case "victorButton":
        return d.createElement("button");
      case "activity": {
        const el = d.createElement("div");
        el.setAttribute("role", "progressbar");
        return el;
      }
      case "scene3d": {
        // The Godot HTML5 canvas the web Scene3D engine attaches to.
        const el = d.createElement("canvas");
        el.setAttribute("data-victor", "scene3d");
        return el;
      }
      case "scroll":
      case "list":
      case "imageBackground":
      case "view":
      case "status":
      case "refresh":
      default:
        return d.createElement("div");
    }
  }

  setProp(id: number, key: string, value: Wire): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.props[key] = value;
    this.apply(e);
  }

  getProp(id: number, key: string): Wire {
    return this.entries.get(id)?.props[key] ?? null;
  }

  /** The DOM element backing a widget id (for hosting / tests); null if freed. */
  elementFor(id: number): DomEl | null {
    return this.entries.get(id)?.el ?? null;
  }

  // Re-derive the element's style + kind-specific attributes from its props.
  private apply(e: Entry): void {
    const { el, kind, props } = e;

    // Kind-specific leaf content / attributes.
    if (kind === "text" && props.text != null) el.textContent = String(props.text);
    if ((kind === "button" || kind === "victorButton")) {
      const label = props.title ?? props.text;
      if (label != null) el.textContent = String(label);
    }
    if (kind === "image" || kind === "imageBackground") {
      const src = props.src ?? props.source;
      if (src != null) {
        if (kind === "image") el.setAttribute("src", String(src));
        else el.style.backgroundImage = `url(${String(src)})`;
      }
    }
    if (kind === "input") {
      if (props.value != null) el.value = String(props.value);
      if (props.placeholder != null) el.setAttribute("placeholder", String(props.placeholder));
      if (props.secure === true) el.setAttribute("type", "password");
      if (props.multiline === true) el.setAttribute("type", "text");
    }
    if (kind === "switch") el.checked = props.value === true;
    if (kind === "slider") {
      if (props.min != null) el.setAttribute("min", String(props.min));
      if (props.max != null) el.setAttribute("max", String(props.max));
      if (props.step != null) el.setAttribute("step", String(props.step));
      if (props.value != null) el.value = String(props.value);
    }

    // Layout + visual style (CSS flexbox is native to the platform).
    this.applyStyle(el, kind, props);
  }

  private applyStyle(el: DomEl, kind: WidgetKind, props: Record<string, Wire>): void {
    const rn = toStyle(props) as Record<string, Wire>;

    // Containers use RN's flex model (default direction: column).
    const container = kind === "view" || kind === "scroll" || kind === "list" ||
      kind === "imageBackground";
    if (container) {
      el.style.display = "flex";
      el.style.flexDirection = String(rn.flexDirection ?? "column");
    }
    if (kind === "scroll") el.style.overflow = String(rn.overflow ?? "auto");

    for (const key of Object.keys(rn)) {
      const edges = EXPAND[key];
      if (edges) {
        for (const edge of edges) el.style[edge] = cssLen(edge, rn[key]);
        continue;
      }
      if (key === "flexDirection" && container) continue; // already set
      el.style[key] = cssLen(key, rn[key]);
    }
  }

  connect(id: number, event: string, cb: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.disconnect(id, event);
    const domType = DOM_EVENT[event] ?? event.toLowerCase();
    const listener = (_ev: DomEvent): void => {
      this.host.fire(id, event, this.eventArg(e));
    };
    e.el.addEventListener(domType, listener);
    e.listeners.set(event, listener);
  }

  disconnect(id: number, event: string): void {
    const e = this.entries.get(id);
    const listener = e?.listeners.get(event);
    if (e && listener) {
      const domType = DOM_EVENT[event] ?? event.toLowerCase();
      e.el.removeEventListener(domType, listener);
      e.listeners.delete(event);
    }
  }

  private eventArg(e: Entry): Wire {
    if (e.kind === "input") return e.el.value ?? "";
    if (e.kind === "switch") return e.el.checked === true;
    if (e.kind === "slider") return Number(e.el.value ?? 0);
    return null;
  }

  addChild(parentId: number, childId: number, index?: number): void {
    const p = this.entries.get(parentId);
    const c = this.entries.get(childId);
    if (!p || !c) return;
    if (index === undefined || index >= p.el.childNodes.length) {
      p.el.appendChild(c.el);
    } else {
      p.el.insertBefore(c.el, p.el.childNodes[index] ?? null);
    }
  }

  removeChild(parentId: number, childId: number): void {
    const p = this.entries.get(parentId);
    const c = this.entries.get(childId);
    if (p && c) {
      try {
        p.el.removeChild(c.el);
      } catch {
        /* not a child */
      }
    }
  }

  clearChildren(parentId: number): void {
    const p = this.entries.get(parentId);
    if (!p) return;
    while (p.el.firstChild) p.el.removeChild(p.el.firstChild);
  }

  free(id: number): void {
    this.entries.delete(id);
  }

  setRoot(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.rootId = id;
    // Replace whatever the container held with the new root.
    while (this.host.container.firstChild) {
      this.host.container.removeChild(this.host.container.firstChild);
    }
    this.host.container.appendChild(e.el);
  }

  toast(message: string): void {
    const d = this.host.document;
    const t = d.createElement("div");
    t.setAttribute("data-victor", "toast");
    t.textContent = message;
    t.style.position = "fixed";
    t.style.bottom = "24px";
    t.style.left = "50%";
    t.style.transform = "translateX(-50%)";
    t.style.background = "rgba(15,23,42,0.92)";
    t.style.color = "#e2e8f0";
    t.style.padding = "10px 16px";
    t.style.borderRadius = "8px";
    this.host.container.appendChild(t);
    const remove = (): void => {
      try {
        this.host.container.removeChild(t);
      } catch {
        /* already gone */
      }
    };
    const to = (globalThis as { setTimeout?: (f: () => void, ms: number) => unknown }).setTimeout;
    if (to) to(remove, 2200);
  }

  // Single app on web (no mini-app sandboxing in the DOM path yet).
  containedIn(): boolean {
    return true;
  }
  addOwner(): boolean {
    return true;
  }

  flush(): void {
    // DOM mutations are applied eagerly; nothing to batch-commit.
  }
}

// A CSS value for an RN style entry: number → px for length props, else string.
function cssLen(key: string, value: Wire): string {
  if (typeof value === "number" && LENGTH_KEYS.has(key)) return `${value}px`;
  return String(value);
}
