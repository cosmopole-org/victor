// The retained widget tree the guest builds over `rn.op`. This is the "DOM" the
// React Native renderer mirrors — a flat registry of nodes plus an ordered
// child list per node, exactly the retained model the Godot host keeps on
// `Control` nodes, only here the leaves become real React Native components.
//
// Framework-agnostic on purpose (no `react-native` import) so it is unit-
// testable under `node --experimental-strip-types`.

import type { Wire } from "./protocol.ts";

export interface WidgetNode {
  /** Manager-namespaced handle id (unique across the whole VM tree). */
  id: number;
  /** Host widget class, e.g. "RNView" | "RNText" | "RNButton" | "RNScene3D". */
  className: string;
  /** Current props (already unwrapped from wire tags). */
  props: Record<string, Wire>;
  /** Ordered child handle ids. */
  children: number[];
  /** Parent handle id, or 0 for a detached/root node. */
  parent: number;
  /** event name -> callback id (manager-namespaced; routes back to owner VM). */
  events: Record<string, number>;
  /** Sandbox roots allowed to reach this node (empty = unrestricted/root VM). */
  owners: number[];
}

export type ChangeListener = () => void;

/**
 * The single source of truth for the 2D tree. Mutated by the host dispatcher as
 * ops arrive; observed by `<VictorHost/>` which re-renders on version bumps.
 */
export class WidgetStore {
  private nodes = new Map<number, WidgetNode>();
  private rootId = 0;
  private toastMessage: string | null = null;
  private ver = 0;
  private listeners = new Set<ChangeListener>();

  // ---- observation ------------------------------------------------------
  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Monotonic version — cheap identity for React's useSyncExternalStore. */
  version(): number {
    return this.ver;
  }

  /** Coalesced notify: callers batch a burst of ops then `flush()` once. */
  flush(): void {
    this.ver++;
    for (const fn of this.listeners) fn();
  }

  // ---- reads (renderer side) -------------------------------------------
  root(): WidgetNode | null {
    return this.rootId ? this.nodes.get(this.rootId) ?? null : null;
  }
  get(id: number): WidgetNode | null {
    return this.nodes.get(id) ?? null;
  }
  takeToast(): string | null {
    const t = this.toastMessage;
    this.toastMessage = null;
    return t;
  }

  // ---- writes (dispatcher side) ----------------------------------------
  create(id: number, className: string, owner: number): WidgetNode {
    const node: WidgetNode = {
      id,
      className,
      props: {},
      children: [],
      parent: 0,
      events: {},
      owners: owner ? [owner] : [],
    };
    this.nodes.set(id, node);
    return node;
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  setProp(id: number, key: string, value: Wire): void {
    const n = this.nodes.get(id);
    if (n) n.props[key] = value;
  }

  setProps(id: number, map: Record<string, Wire>): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const k of Object.keys(map)) n.props[k] = map[k];
  }

  addChild(parentId: number, childId: number, index?: number): void {
    const p = this.nodes.get(parentId);
    const c = this.nodes.get(childId);
    if (!p || !c) return;
    // Reparent: detach from any previous parent first (keyed reuse).
    if (c.parent && c.parent !== parentId) this.removeChild(c.parent, childId);
    const existing = p.children.indexOf(childId);
    if (existing >= 0) p.children.splice(existing, 1);
    if (index === undefined || index < 0 || index >= p.children.length) {
      p.children.push(childId);
    } else {
      p.children.splice(index, 0, childId);
    }
    c.parent = parentId;
  }

  removeChild(parentId: number, childId: number): void {
    const p = this.nodes.get(parentId);
    if (!p) return;
    const i = p.children.indexOf(childId);
    if (i >= 0) p.children.splice(i, 1);
    const c = this.nodes.get(childId);
    if (c && c.parent === parentId) c.parent = 0;
  }

  clearChildren(parentId: number): void {
    const p = this.nodes.get(parentId);
    if (!p) return;
    for (const cid of p.children) {
      const c = this.nodes.get(cid);
      if (c) c.parent = 0;
    }
    p.children = [];
  }

  connect(id: number, event: string, cb: number): void {
    const n = this.nodes.get(id);
    if (n) n.events[event] = cb;
  }

  disconnect(id: number, event: string): void {
    const n = this.nodes.get(id);
    if (n) delete n.events[event];
  }

  /** Look up the callback bound to (widget, event), or 0 if none. */
  callbackFor(id: number, event: string): number {
    return this.nodes.get(id)?.events[event] ?? 0;
  }

  free(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.parent) this.removeChild(n.parent, id);
    // Recursively drop the subtree so handles don't leak.
    for (const cid of [...n.children]) this.free(cid);
    this.nodes.delete(id);
    if (this.rootId === id) this.rootId = 0;
  }

  setRoot(id: number): void {
    this.rootId = id;
  }

  toast(message: string): void {
    this.toastMessage = message;
  }

  /** Is `id` a live widget contained in the subtree rooted at `sandbox`? */
  containedIn(id: number, sandbox: number): boolean {
    if (!this.nodes.has(id)) return false;
    if (sandbox === 0) return true; // unrestricted (root VM)
    let cur: number | undefined = id;
    while (cur) {
      if (cur === sandbox) return true;
      cur = this.nodes.get(cur)?.parent;
    }
    return false;
  }

  addOwner(id: number, sandbox: number): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    if (!n.owners.includes(sandbox)) n.owners.push(sandbox);
    return true;
  }
}
