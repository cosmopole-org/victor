// The retained widget tree the guest builds over `rn.op`. This is the "DOM" the
// React Native renderer mirrors — a flat registry of nodes plus an ordered
// child list per node, exactly the retained model the Godot host keeps on
// `Control` nodes, only here the leaves become real React Native components.
//
// Framework-agnostic on purpose (no `react-native` import) so it is unit-
// testable under `node --experimental-strip-types`.
//
// PERFORMANCE — targeted patching, not whole-tree re-render. The store keeps a
// **per-node revision** and per-node subscriber set, and every mutation records
// only the node(s) it actually touched in a `dirty` set. `flush()` bumps the
// revision of just those nodes and notifies just their subscribers. Combined
// with a memoized per-widget component on the renderer side (`WidgetView`), a
// prop change on one widget re-renders that one widget — never the page. A
// change to a node's *child list* dirties the parent (its children changed),
// so structural edits patch the parent's child slots without touching siblings
// or descendants. The single global `version` bumps only for app-level changes
// (root swap / toast), which the top-level host observes.

import type { Wire } from "./protocol.ts";
import type { WidgetSink } from "./widgetSink.ts";

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
 * ops arrive; observed by `<VictorHost/>` (app-level) and one `<WidgetView/>`
 * per node (targeted) which re-render on the relevant version bump.
 */
export class WidgetStore implements WidgetSink {
  private nodes = new Map<number, WidgetNode>();
  private rootId = 0;
  private toastMessage: string | null = null;

  // App-level observation (root/toast).
  private ver = 0;
  private listeners = new Set<ChangeListener>();
  private appDirty = false;

  // Per-node observation (targeted patching).
  private revs = new Map<number, number>();
  private nodeListeners = new Map<number, Set<ChangeListener>>();
  private dirty = new Set<number>();

  // ---- app-level observation -------------------------------------------
  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Monotonic app-level version — bumps only on root/toast changes. */
  version(): number {
    return this.ver;
  }

  // ---- per-node observation --------------------------------------------
  /** Subscribe to changes of a single node (used by its `<WidgetView/>`). */
  subscribeNode(id: number, fn: ChangeListener): () => void {
    let set = this.nodeListeners.get(id);
    if (!set) {
      set = new Set();
      this.nodeListeners.set(id, set);
    }
    set.add(fn);
    return () => {
      const s = this.nodeListeners.get(id);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this.nodeListeners.delete(id);
      }
    };
  }

  /** A node's revision — a cheap identity for React's `useSyncExternalStore`. */
  nodeVersion(id: number): number {
    return this.revs.get(id) ?? 0;
  }

  /** Mark a node as needing a re-render on the next flush. */
  private markDirty(id: number): void {
    if (id) this.dirty.add(id);
  }

  /**
   * Coalesced notify: the dispatcher applies a burst of ops then calls `flush()`
   * once per frame. We bump the revision of each touched node and notify only
   * its subscribers; the app-level listeners fire only when root/toast changed.
   */
  flush(): void {
    if (this.dirty.size) {
      const touched = [...this.dirty];
      this.dirty.clear();
      for (const id of touched) {
        this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
        const set = this.nodeListeners.get(id);
        if (set) for (const fn of set) fn();
      }
    }
    if (this.appDirty) {
      this.appDirty = false;
      this.ver++;
      for (const fn of this.listeners) fn();
    }
  }

  // ---- reads (renderer side) -------------------------------------------
  root(): WidgetNode | null {
    return this.rootId ? this.nodes.get(this.rootId) ?? null : null;
  }
  get(id: number): WidgetNode | null {
    return this.nodes.get(id) ?? null;
  }
  /** WidgetSink: read one prop (the guest's `get` op). */
  getProp(id: number, key: string): Wire {
    return this.nodes.get(id)?.props[key] ?? null;
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
    if (n) {
      n.props[key] = value;
      this.markDirty(id);
    }
  }

  setProps(id: number, map: Record<string, Wire>): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const k of Object.keys(map)) n.props[k] = map[k];
    this.markDirty(id);
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
    // Only the parent's child-slot list changed — patch the parent, not the
    // child subtree (its own revision is untouched, so it is reused as-is).
    this.markDirty(parentId);
  }

  removeChild(parentId: number, childId: number): void {
    const p = this.nodes.get(parentId);
    if (!p) return;
    const i = p.children.indexOf(childId);
    if (i >= 0) p.children.splice(i, 1);
    const c = this.nodes.get(childId);
    if (c && c.parent === parentId) c.parent = 0;
    this.markDirty(parentId);
  }

  clearChildren(parentId: number): void {
    const p = this.nodes.get(parentId);
    if (!p) return;
    for (const cid of p.children) {
      const c = this.nodes.get(cid);
      if (c) c.parent = 0;
    }
    p.children = [];
    this.markDirty(parentId);
  }

  connect(id: number, event: string, cb: number): void {
    const n = this.nodes.get(id);
    if (n) {
      n.events[event] = cb;
      this.markDirty(id);
    }
  }

  disconnect(id: number, event: string): void {
    const n = this.nodes.get(id);
    if (n) {
      delete n.events[event];
      this.markDirty(id);
    }
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
    this.revs.delete(id);
    if (this.rootId === id) {
      this.rootId = 0;
      this.appDirty = true;
    }
  }

  setRoot(id: number): void {
    if (this.rootId === id) return;
    this.rootId = id;
    this.appDirty = true;
  }

  toast(message: string): void {
    this.toastMessage = message;
    this.appDirty = true;
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
