// Native Godot engine (JSI) routing test — no device, no GPU.
//
//   node --experimental-strip-types test/godotEngine.test.ts
//
// Installs a fake `globalThis.__ElpianGodot` binding (the shape the on-device
// embedded-Godot module exposes) and drives 3D ops through the real
// HostDispatcher into GodotScene3dEngineCore. This proves the RN→Godot seam:
// godot.op/godot.batch the guest emits are forwarded to the native binding and
// its handle replies flow back, and scene3d_mount binds a surface. The device
// build swaps this fake for the real libgodot module (whose op servicing is the
// GodotController proven headless in bridge/extension); the JS contract here is
// identical.

import assert from "node:assert";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import {
  GodotScene3dEngineCore,
} from "../src/scene3d/godotEngineCore.ts";
import { getElpianGodotNative, type ElpianGodotNative } from "../src/scene3d/godotBinding.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

interface FakeState {
  ops: Array<Record<string, unknown>>;
  mounts: Array<[number, number]>;
  released: number[];
}

function installFakeGodot(): FakeState {
  const state: FakeState = { ops: [], mounts: [], released: [] };
  let handle = 5000;
  const mint = (op: Record<string, unknown>): number =>
    typeof op.def === "number" ? op.def : ++handle;

  const fake: ElpianGodotNative = {
    op(opJson) {
      const op = JSON.parse(opJson) as Record<string, unknown>;
      state.ops.push(op);
      return op.new ? JSON.stringify(mint(op)) : "null";
    },
    batch(opsJson) {
      const ops = JSON.parse(opsJson) as Array<Record<string, unknown>>;
      return JSON.stringify(
        ops.map((op) => {
          state.ops.push(op);
          return op.new ? mint(op) : null;
        }),
      );
    },
    mountSurface(surfaceId, mountNode) {
      state.mounts.push([surfaceId, mountNode]);
    },
    releaseSurface(surfaceId) {
      state.released.push(surfaceId);
    },
    viewName: "ElpianGodotView",
  };
  (globalThis as { __ElpianGodot?: ElpianGodotNative }).__ElpianGodot = fake;
  return state;
}

function uninstallFakeGodot(): void {
  delete (globalThis as { __ElpianGodot?: ElpianGodotNative }).__ElpianGodot;
}

test("isAvailable reflects whether the Godot binding is installed", () => {
  uninstallFakeGodot();
  assert.strictEqual(GodotScene3dEngineCore.isAvailable(), false);
  assert.strictEqual(getElpianGodotNative(), null);
  installFakeGodot();
  assert.strictEqual(GodotScene3dEngineCore.isAvailable(), true);
  uninstallFakeGodot();
});

test("godot.op is routed to the native binding and its handle reply flows back", () => {
  const state = installFakeGodot();
  try {
    const engine = new GodotScene3dEngineCore();
    const d = new HostDispatcher(engine);

    // A guest building a 3D node: the reply is the node handle it will reuse.
    const reply = d.handle("godot.op", JSON.stringify([{ new: "Node3D", def: 10 }]));
    assert.strictEqual(reply, "10");
    assert.ok(
      state.ops.some((o) => o.new === "Node3D"),
      "the native binding should have received the Node3D op",
    );
  } finally {
    uninstallFakeGodot();
  }
});

test("godot.batch services many ops in one crossing, one reply each", () => {
  const state = installFakeGodot();
  try {
    const d = new HostDispatcher(new GodotScene3dEngineCore());
    const reply = d.handle(
      "godot.batch",
      JSON.stringify([[{ new: "Camera3D", def: 11 }, { new: "MeshInstance3D", def: 12 }]]),
    );
    assert.deepStrictEqual(JSON.parse(reply ?? "null"), [11, 12]);
    assert.strictEqual(state.ops.length, 2);
  } finally {
    uninstallFakeGodot();
  }
});

test("scene3d_mount binds the Scene3D surface to its Godot mount node", () => {
  const state = installFakeGodot();
  try {
    const d = new HostDispatcher(new GodotScene3dEngineCore());
    // The guest allocates the Scene3D widget and its Godot mount-node handle,
    // then requests the mount — exactly what the reactnative.js prelude emits.
    d.handle("rn.op", JSON.stringify([{ new: "RNScene3D", def: 1 }]));
    d.handle("rn.op", JSON.stringify([{ ref: 1, method: "scene3d_mount", args: [{ ref: 777 }] }]));
    assert.deepStrictEqual(state.mounts, [[1, 777]]);
  } finally {
    uninstallFakeGodot();
  }
});

test("without a binding, constructing the engine throws a clear error", () => {
  uninstallFakeGodot();
  assert.throws(() => new GodotScene3dEngineCore(), /native embedded-Godot backend .* not installed/);
});

console.log(`\n${passed} godot-engine tests passed.`);
