// Native (mobile) WidgetSink test — no device. A fake __ElpianWidgets records
// the op messages the HostDispatcher forwards from rn.op, and exercises the
// native→VM event handler. The device build swaps this fake for the real
// Android/iOS controller (Yoga views); the JS contract here is identical.
//
//   node --experimental-strip-types test/nativeWidgetRenderer.test.ts

import assert from "node:assert";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";
import {
  NativeWidgetRenderer,
  getElpianWidgetsNative,
  type ElpianWidgetsNative,
} from "../src/render/nativeWidgetRenderer.ts";
import type { Wire } from "../src/core/protocol.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

interface Fake {
  native: ElpianWidgetsNative;
  msgs: Array<Record<string, Wire>>;
  msgsFor: (appId: string) => Array<Record<string, Wire>>;
  queueEvent: (appId: string, id: number, event: string, arg: Wire) => void;
}

function fakeWidgets(): Fake {
  const msgs: Array<Record<string, Wire>> = [];
  const byApp: Record<string, Array<Record<string, Wire>>> = {};
  const events: Record<string, Array<[number, string, Wire]>> = {};
  const native: ElpianWidgetsNative = {
    op(appId, json) {
      const m = JSON.parse(json) as Record<string, Wire>;
      msgs.push(m);
      (byApp[appId] ??= []).push(m);
    },
    pollEvents(appId) {
      const q = events[appId] ?? [];
      events[appId] = [];
      return JSON.stringify(q);
    },
    viewName: "VictorSurfaceView",
  };
  return {
    native,
    msgs,
    msgsFor: (appId) => byApp[appId] ?? [],
    queueEvent: (appId, id, event, arg) => ((events[appId] ??= []).push([id, event, arg])),
  };
}

function rn(d: HostDispatcher, op: object): void {
  d.handle("rn.op", JSON.stringify([op]));
}

test("isAvailable reflects the binding", () => {
  assert.strictEqual(NativeWidgetRenderer.isAvailable(), false);
  (globalThis as { __ElpianWidgets?: ElpianWidgetsNative }).__ElpianWidgets = fakeWidgets().native;
  assert.strictEqual(NativeWidgetRenderer.isAvailable(), true);
  assert.ok(getElpianWidgetsNative());
  delete (globalThis as { __ElpianWidgets?: ElpianWidgetsNative }).__ElpianWidgets;
});

test("rn.op forwards create/set/connect/add/root to the native controller", () => {
  const fake = fakeWidgets();
  const fired: Array<[number, string, Wire]> = [];
  const r = new NativeWidgetRenderer({ fire: (id, e, a) => fired.push([id, e, a ?? null]) }, fake.native);
  const d = new HostDispatcher(new MockScene3dEngine(), r);

  rn(d, { new: "RNView", def: 1 });
  rn(d, { new: "RNText", def: 2 });
  rn(d, { ref: 2, props: { text: "hi", onPress: { cb: 9 } } });
  rn(d, { ref: 1, method: "add_child", args: [{ ref: 2 }] });
  rn(d, { root: true, ref: 1 });
  rn(d, { toast: "done" });

  const has = (pred: (m: Record<string, Wire>) => boolean) => fake.msgs.some(pred);
  assert.ok(has((m) => m.t === "create" && m.id === 1 && m.cls === "RNView"), "create RNView");
  assert.ok(has((m) => m.t === "create" && m.id === 2 && m.cls === "RNText"), "create RNText");
  assert.ok(has((m) => m.t === "set" && m.id === 2 && m.k === "text" && m.v === "hi"), "set text");
  assert.ok(has((m) => m.t === "connect" && m.id === 2 && m.e === "press" && m.cb === 9), "onPress→connect");
  assert.ok(has((m) => m.t === "add" && m.p === 1 && m.c === 2), "add_child");
  assert.ok(has((m) => m.t === "root" && m.id === 1), "root");
  assert.ok(has((m) => m.t === "toast" && m.m === "done"), "toast");
});

test("native widget events are drained on flush() and routed into the VM", () => {
  const fake = fakeWidgets();
  const fired: Array<[number, string, Wire]> = [];
  const r = new NativeWidgetRenderer({ fire: (id, e, a) => fired.push([id, e, a ?? null]) }, fake.native);
  fake.queueEvent("main", 2, "changeText", "bob");
  fake.queueEvent("main", 3, "press", null);
  r.flush(); // the runtime calls this each frame
  assert.deepStrictEqual(fired, [[2, "changeText", "bob"], [3, "press", null]], "events → VM");
});

test("mini apps are isolated: ops route by appId and polls don't cross", () => {
  const fake = fakeWidgets();
  const firedA: Array<[number, string]> = [];
  const firedB: Array<[number, string]> = [];
  const a = new NativeWidgetRenderer({ appId: "a", fire: (id, e) => firedA.push([id, e]) }, fake.native);
  const b = new NativeWidgetRenderer({ appId: "b", fire: (id, e) => firedB.push([id, e]) }, fake.native);

  a.create(1, "RNView");
  b.create(1, "RNText"); // same local id, different app — must not collide
  assert.ok(fake.msgsFor("a").some((m) => m.t === "create" && m.cls === "RNView"), "a's op tagged a");
  assert.ok(fake.msgsFor("b").some((m) => m.t === "create" && m.cls === "RNText"), "b's op tagged b");
  assert.strictEqual(fake.msgsFor("a").some((m) => m.cls === "RNText"), false, "b's op didn't leak to a");

  fake.queueEvent("a", 1, "press", null);
  fake.queueEvent("b", 1, "press", null);
  a.flush(); // must only drain a's events
  assert.deepStrictEqual(firedA, [[1, "press"]], "a got only its event");
  assert.deepStrictEqual(firedB, [], "b's event untouched by a's poll");
  b.flush();
  assert.deepStrictEqual(firedB, [[1, "press"]], "b drains its own event");
});

test("events fire back into the VM on the sink path (callback not in store)", () => {
  const fake = fakeWidgets();
  const r = new NativeWidgetRenderer({ fire: () => {} }, fake.native);
  const d = new HostDispatcher(new MockScene3dEngine(), r);
  const invokes: Array<[string, string]> = [];
  d.setInvokeSink((fn, arg) => invokes.push([fn, arg]));

  rn(d, { new: "RNButton", def: 5 });
  rn(d, { ref: 5, props: { onPress: { cb: 42 } } }); // connect routes to the sink

  // The store never saw the callback (sink path); fireEvent must still resolve it.
  d.fireEvent(5, "press", null);
  assert.deepStrictEqual(invokes, [["__godotDispatch", JSON.stringify([42, null])]]);
});

test("without a binding, constructing throws a clear error", () => {
  delete (globalThis as { __ElpianWidgets?: ElpianWidgetsNative }).__ElpianWidgets;
  assert.throws(() => new NativeWidgetRenderer({ fire: () => {} }), /native widget backend .* not installed/);
});

console.log(`\n${passed} native-widget-renderer tests passed.`);
