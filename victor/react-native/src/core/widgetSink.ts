// The one canonical widget set, as an interface.
//
// A Victor guest program targets widget *names/kinds* (RNView, RNText, RNButton,
// FlatList, TextInput, Scene3D, …). The HostDispatcher interprets the VM's
// `rn.op` stream into these calls; a platform WidgetSink turns them into that
// platform's NATIVE widgets — with no React:
//
//   • web    — DOM elements (div / span / input / img …)   [DomWidgetRenderer]
//   • mobile — android.view.View / UIView, via a native controller over JSI
//              [NativeWidgetRenderer → __ElpianWidgets]
//   • tests / React fallback — the retained WidgetStore + <VictorHost/>
//
// So ONE program renders natively everywhere: the widget set is shared, only the
// leaf mapping (kind → native widget, prop → native setter) differs per platform.
// This is the 2D analogue of the Scene3dEngine seam for Godot 3D.

import type { Wire } from "./protocol.ts";

/** The widget-building operations every platform renderer implements. */
export interface WidgetSink {
  /** Create widget `id` of class `className` (owned by sandbox `owner`, 0=root). */
  create(id: number, className: string, owner: number): unknown;
  /** Set one prop to a value. */
  setProp(id: number, key: string, value: Wire): void;
  /** Read a prop back (for the guest's `get` op); null when unknown. */
  getProp(id: number, key: string): Wire;
  /** Wire an event (`press`, `change`, …) to guest callback id `cb`. */
  connect(id: number, event: string, cb: number): void;
  disconnect(id: number, event: string): void;
  addChild(parentId: number, childId: number, index?: number): void;
  removeChild(parentId: number, childId: number): void;
  clearChildren(parentId: number): void;
  free(id: number): void;
  /** Mark `id` the root of the Victor surface. */
  setRoot(id: number): void;
  toast(message: string): void;
  /** Sandbox governance (mini-app isolation); trivial for a single app. */
  containedIn(id: number, sandbox: number): boolean;
  addOwner(id: number, sandbox: number): boolean;
}

/**
 * A platform widget renderer: a WidgetSink that also commits a frame (attaches /
 * lays out the native tree). `flush` is called once per animation frame by the
 * runtime, after a batch of ops.
 */
export interface WidgetRenderer extends WidgetSink {
  /** Commit pending changes to the platform (attach root, run layout). */
  flush(): void;
}
