// Host-core tests — exercise the op interpreter, widget tree, sandbox
// governance and the 2D↔3D seam against a synthetic op stream (the exact shape
// the `reactnative.js` prelude emits after the manager namespaces it).
//
//   node --experimental-strip-types test/host.test.ts
//
// No React Native / wasm needed: this is the framework-agnostic core.

import assert from "node:assert";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Convenience: run one rn.op and return its parsed reply.
function rn(d: HostDispatcher, op: object): unknown {
  const r = d.handle("rn.op", JSON.stringify([op]));
  return r === null ? null : JSON.parse(r);
}

test("builds a widget tree and marks a root", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  // new RNView def=1 ; new RNText def=2 with text ; add text under view ; root=1
  assert.strictEqual(rn(d, { new: "RNView", def: 1 }), 1);
  rn(d, { new: "RNText", def: 2 });
  rn(d, { ref: 2, props: { text: "Hello Victor" } });
  rn(d, { ref: 1, method: "add_child", args: [{ ref: 2 }] });
  rn(d, { root: true, ref: 1 });

  const root = d.store.root();
  assert.ok(root, "root exists");
  assert.strictEqual(root!.className, "RNView");
  assert.deepStrictEqual(root!.children, [2]);
  assert.strictEqual(d.store.get(2)!.props.text, "Hello Victor");
  assert.strictEqual(d.store.get(2)!.parent, 1);
});

test("batch applies many ops in one crossing and flushes once", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  let flushes = 0;
  d.store.subscribe(() => flushes++);
  const ops = [
    { new: "RNView", def: 1 },
    { new: "RNButton", def: 2 },
    { ref: 2, props: { title: "Tap" } },
    { ref: 1, method: "add_child", args: [{ ref: 2 }] },
    { root: 1 },
  ];
  d.handle("rn.batch", JSON.stringify([ops]));
  assert.strictEqual(flushes, 1, "one commit per batch");
  assert.deepStrictEqual(d.store.root()!.children, [2]);
});

test("event props register and route back to the owning VM", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  const invokes: Array<[string, string]> = [];
  d.setInvokeSink((fn, arg) => invokes.push([fn, arg]));

  rn(d, { new: "RNButton", def: 5 });
  // onPress arrives as a namespaced callback id (77) via props.
  rn(d, { ref: 5, props: { title: "Go", onPress: { cb: 77 } } });
  assert.strictEqual(d.store.callbackFor(5, "press"), 77);

  d.fireEvent(5, "press", null);
  assert.strictEqual(invokes.length, 1);
  assert.strictEqual(invokes[0][0], "__godotDispatch");
  assert.deepStrictEqual(JSON.parse(invokes[0][1]), [77, null]);
});

test("connect op (imperative .on) also binds an event", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  rn(d, { new: "RNInput", def: 9 });
  rn(d, { ref: 9, connect: "changeText", cb: 12 });
  const invokes: string[] = [];
  d.setInvokeSink((_fn, arg) => invokes.push(arg));
  d.fireEvent(9, "changeText", "typed");
  assert.deepStrictEqual(JSON.parse(invokes[0]), [12, "typed"]);
});

test("sandbox: a child VM cannot touch a widget outside its subtree", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  // Root VM builds widget 1 (unrestricted).
  rn(d, { new: "RNView", def: 1 });
  // A sandboxed VM (sbx root = 500) builds its own subtree: node 501 under 500.
  rn(d, { new: "RNView", def: 500, __sbx: 500 });
  rn(d, { new: "RNText", def: 501, __sbx: 500 });
  rn(d, { ref: 500, method: "add_child", args: [{ ref: 501 }], __sbx: 500 });

  // Reaching its own node: allowed.
  const okReply = rn(d, { ref: 501, set: "text", value: "mine", __sbx: 500 });
  assert.strictEqual(okReply, null);
  assert.strictEqual(d.store.get(501)!.props.text, "mine");

  // Reaching the root VM's widget 1: refused with the wire-error convention.
  const denied = rn(d, { ref: 1, set: "text", value: "hax", __sbx: 500 }) as {
    __dart_error__?: string;
  };
  assert.ok(denied && denied.__dart_error__, "cross-sandbox write is refused");
  assert.strictEqual(d.store.get(1)!.props.text, undefined);
});

test("sandbox: chk probes containment; grant shares a handle", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  rn(d, { new: "RNView", def: 500, __sbx: 500 });
  rn(d, { new: "RNText", def: 501, __sbx: 500 });
  rn(d, { ref: 500, method: "add_child", args: [{ ref: 501 }], __sbx: 500 });

  assert.strictEqual(rn(d, { chk: 501, __sbx: 500 }), true, "own node contained");
  rn(d, { new: "RNView", def: 1 }); // root VM's node
  assert.strictEqual(rn(d, { chk: 1, __sbx: 500 }), false, "foreign node not contained");

  // Grant node 1 to sandbox 500, then it becomes reachable as an owner.
  rn(d, { grant: 1, sbx: 500 });
  const reply = rn(d, { ref: 1, set: "text", value: "shared", __sbx: 500 });
  assert.strictEqual(reply, null);
  assert.strictEqual(d.store.get(1)!.props.text, "shared");
});

test("3D: godot.op forwards to the embedded engine; Scene3D mounts a surface", () => {
  const engine = new MockScene3dEngine();
  const d = new HostDispatcher(engine);
  // A Scene3D widget; the guest allocates the Godot mount node handle (4242).
  rn(d, { new: "RNScene3D", def: 30 });
  rn(d, { ref: 30, method: "scene3d_mount", args: [{ ref: 4242 }] });
  assert.strictEqual(engine.surfaces.get(30), 4242, "surface bound to mount node");

  // Guest builds 3D content with the ordinary godot.op seam.
  const cam = d.handle("godot.op", JSON.stringify([{ new: "Camera3D", def: 40 }]));
  assert.strictEqual(JSON.parse(cam!), 40);
  d.handle("godot.op", JSON.stringify([{ ref: 40, set: "current", value: true }]));
  assert.ok(
    engine.ops.some((o) => o.new === "Camera3D"),
    "engine received the 3D op",
  );
});

test("free drops a widget and its subtree", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  rn(d, { new: "RNView", def: 1 });
  rn(d, { new: "RNText", def: 2 });
  rn(d, { ref: 1, method: "add_child", args: [{ ref: 2 }] });
  rn(d, { ref: 1, free: 1 });
  assert.strictEqual(d.store.get(1), null);
  assert.strictEqual(d.store.get(2), null, "child freed with parent");
});

test("log family collects print lines", () => {
  const d = new HostDispatcher(new MockScene3dEngine());
  d.handle("log", JSON.stringify(["hello"]));
  d.handle("log", JSON.stringify(["world"]));
  assert.deepStrictEqual(d.log, ["hello", "world"]);
});

console.log(`\n${passed} host-core tests passed.`);
