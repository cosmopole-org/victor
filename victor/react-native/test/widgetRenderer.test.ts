// WidgetRenderer seam test — proves the "one widget set, per-platform renderer"
// architecture at the dispatcher level, no React, no device.
//
//   node --experimental-strip-types test/widgetRenderer.test.ts
//
// A fake WidgetRenderer records the widget-building calls the HostDispatcher
// makes from the VM's rn.op stream. The same op stream that builds a React tree
// (via WidgetStore) here drives an arbitrary platform sink — which is exactly
// how the DOM (web) and native (mobile) renderers plug in: they implement
// WidgetSink and receive create/setProp/addChild/connect/... directly.

import assert from "node:assert";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";
import type { WidgetRenderer } from "../src/core/widgetSink.ts";
import type { Wire } from "../src/core/protocol.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

interface Rec {
  calls: string[];
  props: Map<number, Record<string, Wire>>;
  children: Map<number, number[]>;
  events: Map<number, Record<string, number>>;
  root: number;
  toasts: string[];
  flushes: number;
}

function fakeRenderer(): { renderer: WidgetRenderer; rec: Rec } {
  const rec: Rec = {
    calls: [],
    props: new Map(),
    children: new Map(),
    events: new Map(),
    root: 0,
    toasts: [],
    flushes: 0,
  };
  const renderer: WidgetRenderer = {
    create(id, className) {
      rec.calls.push(`create:${id}:${className}`);
      rec.props.set(id, {});
      rec.children.set(id, []);
      rec.events.set(id, {});
    },
    setProp(id, key, value) {
      (rec.props.get(id) ?? {})[key] = value;
      rec.props.get(id)![key] = value;
    },
    getProp(id, key) {
      return rec.props.get(id)?.[key] ?? null;
    },
    connect(id, event, cb) {
      rec.events.get(id)![event] = cb;
    },
    disconnect(id, event) {
      delete rec.events.get(id)?.[event];
    },
    addChild(parent, child, index) {
      const arr = rec.children.get(parent)!;
      if (index === undefined) arr.push(child);
      else arr.splice(index, 0, child);
    },
    removeChild(parent, child) {
      const arr = rec.children.get(parent)!;
      const i = arr.indexOf(child);
      if (i >= 0) arr.splice(i, 1);
    },
    clearChildren(parent) {
      rec.children.set(parent, []);
    },
    free(id) {
      rec.calls.push(`free:${id}`);
    },
    setRoot(id) {
      rec.root = id;
    },
    toast(message) {
      rec.toasts.push(message);
    },
    containedIn() {
      return true;
    },
    addOwner() {
      return true;
    },
    flush() {
      rec.flushes++;
    },
  };
  return { renderer, rec };
}

function rn(d: HostDispatcher, op: object): unknown {
  const r = d.handle("rn.op", JSON.stringify([op]));
  return r === null ? null : JSON.parse(r);
}

test("rn.op builds the widget tree on a native/DOM renderer (no store, no React)", () => {
  const { renderer, rec } = fakeRenderer();
  const d = new HostDispatcher(new MockScene3dEngine(), renderer);

  assert.strictEqual(rn(d, { new: "RNView", def: 1 }), 1);
  rn(d, { new: "RNText", def: 2 });
  rn(d, { ref: 2, props: { text: "hi", onPress: { cb: 7 } } });
  rn(d, { ref: 1, method: "add_child", args: [{ ref: 2 }] });
  rn(d, { root: true, ref: 1 });
  rn(d, { toast: "saved" });

  assert.deepStrictEqual(rec.children.get(1), [2], "add_child hit the renderer");
  assert.strictEqual(rec.props.get(2)!.text, "hi", "props hit the renderer");
  assert.strictEqual(rec.events.get(2)!.press, 7, "onPress became a connect(press, 7)");
  assert.strictEqual(rec.root, 1, "root marked on the renderer");
  assert.deepStrictEqual(rec.toasts, ["saved"]);
  // The renderer's own commit runs (not the store's flush).
  assert.ok(rec.flushes > 0, "renderer.flush() drove the commit");
});

test("Scene3D is just a widget in the set (RNScene3D create + mount)", () => {
  const { renderer, rec } = fakeRenderer();
  const engine = new MockScene3dEngine();
  const d = new HostDispatcher(engine, renderer);
  rn(d, { new: "RNScene3D", def: 5 });
  rn(d, { ref: 5, method: "scene3d_mount", args: [{ ref: 900 }] });
  assert.ok(rec.calls.includes("create:5:RNScene3D"), "Scene3D created via the widget sink");
  assert.strictEqual(engine.surfaces.get(5), 900, "its 3D surface bound to the mount node");
});

test("without a renderer, the dispatcher still uses the React WidgetStore", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  rn(d, { new: "RNView", def: 1 });
  rn(d, { ref: 1, props: { text: "kept" } });
  rn(d, { root: true, ref: 1 });
  assert.strictEqual(d.store.root()?.id, 1, "store path intact");
  assert.strictEqual(d.store.get(1)?.props.text, "kept");
});

console.log(`\n${passed} widget-renderer tests passed.`);
