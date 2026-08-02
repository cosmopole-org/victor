// Web Godot engine routing test — no browser, no WebGL. Installs a fake
// `globalThis.__ElpianGodotWeb` (the shape a loaded Godot HTML5 export exposes)
// and drives 3D ops through the real HostDispatcher into WebGodotEngine. Proves
// the web twin of the native Godot seam: godot.op/godot.batch are posted to the
// export, the guest's allocated handle is echoed synchronously, and
// scene3d_mount binds the surface to the canvas the DomWidgetRenderer created.
// The real export swaps this fake for the WebAssembly GodotController.
//
//   node --experimental-strip-types test/webGodotEngine.test.ts

import assert from "node:assert";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { WebGodotEngine, type SurfaceResolver } from "../src/scene3d/webGodotEngine.ts";
import { getElpianGodotWeb, type ElpianGodotWeb } from "../src/scene3d/webGodotBinding.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

interface FakeState {
  ops: Array<Record<string, unknown>>;
  mounts: Array<[number, unknown, number]>;
  released: number[];
}

function installFakeWeb(): FakeState {
  const state: FakeState = { ops: [], mounts: [], released: [] };
  const fake: ElpianGodotWeb = {
    op(opJson) {
      state.ops.push(JSON.parse(opJson) as Record<string, unknown>);
    },
    mountSurface(surfaceId, canvas, mountNode) {
      state.mounts.push([surfaceId, canvas, mountNode]);
    },
    releaseSurface(surfaceId) {
      state.released.push(surfaceId);
    },
  };
  (globalThis as { __ElpianGodotWeb?: ElpianGodotWeb }).__ElpianGodotWeb = fake;
  return state;
}

function uninstall(): void {
  delete (globalThis as { __ElpianGodotWeb?: ElpianGodotWeb }).__ElpianGodotWeb;
}

const noSurface: SurfaceResolver = () => null;

test("isAvailable reflects whether the web export is loaded", () => {
  uninstall();
  assert.strictEqual(WebGodotEngine.isAvailable(), false);
  assert.strictEqual(getElpianGodotWeb(), null);
  installFakeWeb();
  assert.strictEqual(WebGodotEngine.isAvailable(), true);
  uninstall();
});

test("godot.op is posted to the export and the guest's handle is echoed", () => {
  const state = installFakeWeb();
  try {
    const d = new HostDispatcher(new WebGodotEngine(noSurface));
    const reply = d.handle("godot.op", JSON.stringify([{ new: "Node3D", def: 10 }]));
    assert.strictEqual(reply, "10");
    assert.ok(state.ops.some((o) => o.new === "Node3D" && o.def === 10), "op posted");
  } finally {
    uninstall();
  }
});

test("godot.batch posts every op and echoes each handle", () => {
  const state = installFakeWeb();
  try {
    const d = new HostDispatcher(new WebGodotEngine(noSurface));
    const reply = d.handle(
      "godot.batch",
      JSON.stringify([[{ new: "Camera3D", def: 11 }, { new: "MeshInstance3D", def: 12 }]]),
    );
    assert.deepStrictEqual(JSON.parse(reply ?? "null"), [11, 12]);
    assert.strictEqual(state.ops.length, 2);
  } finally {
    uninstall();
  }
});

test("scene3d_mount binds the surface to its resolved canvas", () => {
  const state = installFakeWeb();
  try {
    const canvas = { tag: "canvas-for-1" };
    const resolve: SurfaceResolver = (id) => (id === 1 ? canvas : null);
    const d = new HostDispatcher(new WebGodotEngine(resolve));
    d.handle("rn.op", JSON.stringify([{ new: "RNScene3D", def: 1 }]));
    d.handle("rn.op", JSON.stringify([{ ref: 1, method: "scene3d_mount", args: [{ ref: 777 }] }]));
    assert.deepStrictEqual(state.mounts, [[1, canvas, 777]], "surface bound to its canvas");
  } finally {
    uninstall();
  }
});

test("without the export loaded, constructing the engine throws a clear error", () => {
  uninstall();
  assert.throws(() => new WebGodotEngine(noSurface), /web embedded-Godot export .* not loaded/);
});

console.log(`\n${passed} web-godot-engine tests passed.`);
