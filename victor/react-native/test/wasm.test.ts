// Full end-to-end test: the REAL Elpian VM (compiled to WebAssembly) drives the
// REAL host dispatcher through the REAL `reactnative.js` prelude. Nothing is
// mocked except the 3D engine. This is the whole stack the Expo app runs, minus
// React Native's native views.
//
//   1. build the module:  cargo build -p elpian-rn --target wasm32-unknown-unknown --release
//   2. run:               node --experimental-strip-types test/wasm.test.ts
//
// Skips (does not fail) when the module hasn't been built, so the pure-JS suite
// stays runnable without a Rust toolchain.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WasmBackend } from "../src/vm/backend.ts";
import { HostDispatcher } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";
import { EXAMPLE_GUEST_SOURCE } from "../src/example/guestSource.ts";
import type { WidgetNode } from "../src/core/widgetStore.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(
  here,
  "../../target/wasm32-unknown-unknown/release/elpian_rn.wasm",
);

if (!fs.existsSync(wasmPath)) {
  console.log(`  skip  elpian_rn.wasm not built (${wasmPath})`);
  process.exit(0);
}

function findByClass(d: HostDispatcher, cls: string): WidgetNode[] {
  const out: WidgetNode[] = [];
  const root = d.store.root();
  const walk = (id: number | undefined) => {
    if (!id) return;
    const n = d.store.get(id);
    if (!n) return;
    if (n.className === cls) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root?.id);
  return out;
}

const wasm = fs.readFileSync(wasmPath);
const engine = new MockScene3dEngine();
const dispatcher = new HostDispatcher(engine);
const logs: string[] = [];

const backend = await WasmBackend.instantiate(wasm, (n, a) => dispatcher.handle(n, a));
// Widget events route back into the VM (as <VictorHost/> wires them).
dispatcher.setInvokeSink((fn, arg) => backend.invoke(fn, arg));
backend.create(EXAMPLE_GUEST_SOURCE, "js", true, () => null);
backend.run();
for (const l of backend.takeLog()) logs.push(l);

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("the guest booted and printed", () => {
  assert.ok(logs.some((l) => l.includes("victor react-native demo up")), `logs: ${logs}`);
});

test("a widget root tree was mounted", () => {
  const root = dispatcher.store.root();
  assert.ok(root, "an app root was mounted");
  assert.strictEqual(root!.className, "RNView");
  assert.ok(root!.children.length >= 3, "root has the title, label, button, scene");
});

test("the title text is present", () => {
  const texts = findByClass(dispatcher, "RNText").map((n) => n.props.text);
  assert.ok(
    texts.some((t) => typeof t === "string" && t.includes("React Native + Godot")),
    `texts: ${JSON.stringify(texts)}`,
  );
});

test("an embedded Godot Scene3D was created and mounted", () => {
  const scenes = findByClass(dispatcher, "RNScene3D");
  assert.strictEqual(scenes.length, 1, "one Scene3D widget");
  assert.strictEqual(engine.surfaces.size, 1, "surface bound to a Godot mount node");
  // The 3D content was driven over the ordinary godot.op seam into the engine.
  assert.ok(
    engine.ops.some((o) => o.new === "Camera3D"),
    "the Godot camera op reached the engine",
  );
  assert.ok(
    engine.ops.some((o) => typeof o.new === "string" && o.new.includes("Mesh")),
    "a mesh op reached the engine",
  );
});

test("pressing the button runs guest logic and updates the label", () => {
  const buttons = findByClass(dispatcher, "RNButton");
  assert.strictEqual(buttons.length, 1);
  const before = findByClass(dispatcher, "RNText")
    .map((n) => n.props.text)
    .find((t) => typeof t === "string" && t.startsWith("Count:"));
  assert.strictEqual(before, "Count: 0");

  // Fire the press: the host routes it to the guest, which mutates state and
  // patches the label prop — all on the VM.
  dispatcher.fireEvent(buttons[0].id, "press", null);

  const after = findByClass(dispatcher, "RNText")
    .map((n) => n.props.text)
    .find((t) => typeof t === "string" && t.startsWith("Count:"));
  assert.strictEqual(after, "Count: 1", "label reflects the VM's new state");
});

backend.free();
console.log(`\n${passed} wasm end-to-end tests passed.`);
