// VictorMiniAppsController — the object-oriented mini-app manager. Proves the
// imperative API drives the same isolated multi-VM model the declarative
// component used to manage internally: add boots a VM, update restarts just one,
// stop frees a VM while others keep running, remove drops it, and subscribers
// are notified on every change.
//
//   1. build:  cargo build -p elpian-rn --target wasm32-unknown-unknown --release
//   2. run:    node --experimental-strip-types test/miniappsController.test.ts
//
// Skips (does not fail) when the module isn't built.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VictorEngine } from "../src/miniapps/engine.ts";
import { VictorMiniAppsController } from "../src/miniapps/controller.ts";
import { ElpianRuntime } from "../src/vm/runtime.ts";
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

function textsOf(rt: ElpianRuntime | null): string[] {
  if (!rt) return [];
  const out: string[] = [];
  const store = rt.dispatcher.store;
  const walk = (id: number | undefined) => {
    if (!id) return;
    const n: WidgetNode | null = store.get(id);
    if (!n) return;
    if (n.className === "RNText" && typeof n.props.text === "string") {
      out.push(n.props.text);
    }
    for (const c of n.children) walk(c);
  };
  walk(store.root()?.id);
  return out;
}

function firstButton(rt: ElpianRuntime | null): number {
  if (!rt) return 0;
  const store = rt.dispatcher.store;
  let found = 0;
  const walk = (id: number | undefined) => {
    if (!id || found) return;
    const n = store.get(id);
    if (!n) return;
    if (n.className === "RNButton") { found = n.id; return; }
    for (const c of n.children) walk(c);
  };
  walk(store.root()?.id);
  return found;
}

const APP = (label: string) => String.raw`
import "reactnative.js";
var n = 0; var lbl = null;
function main() {
  var col = RN.column({});
  lbl = RN.text("${label}: 0", {});
  col.add(lbl);
  col.add(RN.button({ title: "inc", onPress: function (e) { n = n + 1; lbl.set("text", "${label}: " + n); } }));
  RN.mount(col);
  print("${label} up");
}
main();
`;

const wasm = fs.readFileSync(wasmPath);
const engine = await VictorEngine.load(wasm);

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// A controller built on a preloaded engine is ready immediately.
const logs: Array<[string, string]> = [];
let changes = 0;
const controller = new VictorMiniAppsController({
  engine,
  onLog: (id, line) => logs.push([id, line]),
  onChange: () => { changes++; },
});

test("ready synchronously with a preloaded engine", () => {
  assert.ok(controller.isReady());
  assert.strictEqual(controller.list().length, 0);
});

test("add() boots a mini app and notifies subscribers", () => {
  const before = changes;
  const h = controller.add({ id: "a", source: APP("A") });
  assert.strictEqual(h.status, "running");
  assert.ok(h.runtime, "handle carries a live runtime");
  assert.ok(changes > before, "onChange fired");
  assert.ok(logs.some(([id, l]) => id === "a" && l.includes("A up")));
  assert.deepStrictEqual(textsOf(h.runtime), ["A: 0"]);
});

test("a second add() runs in its own isolated VM", () => {
  controller.add({ id: "b", source: APP("B") });
  assert.deepStrictEqual(controller.ids(), ["a", "b"]);
  const a = controller.get("a")!;
  const b = controller.get("b")!;
  assert.notStrictEqual(a.runtime, b.runtime);
  assert.notStrictEqual(a.runtime!.dispatcher.store, b.runtime!.dispatcher.store);
  assert.deepStrictEqual(textsOf(b.runtime), ["B: 0"]);
});

test("events route to the right mini app only", () => {
  const a = controller.get("a")!.runtime!;
  a.fireEvent(firstButton(a), "press", null);
  assert.deepStrictEqual(textsOf(a), ["A: 1"], "A advanced");
  assert.deepStrictEqual(textsOf(controller.get("b")!.runtime), ["B: 0"], "B untouched");
});

test("stop() frees one VM but leaves the set (restartable) and others running", () => {
  controller.stop("a");
  const a = controller.get("a")!;
  assert.strictEqual(a.status, "stopped");
  assert.strictEqual(a.runtime, null);
  // b keeps running.
  const b = controller.get("b")!.runtime!;
  b.fireEvent(firstButton(b), "press", null);
  assert.deepStrictEqual(textsOf(b), ["B: 1"]);
});

test("start() reboots a stopped mini app from its source", () => {
  controller.start("a");
  const a = controller.get("a")!;
  assert.strictEqual(a.status, "running");
  assert.deepStrictEqual(textsOf(a.runtime), ["A: 0"], "fresh VM, counter reset");
});

test("replaceSource() restarts just that mini app with the new program", () => {
  const aRtBefore = controller.get("a")!.runtime;
  const bRt = controller.get("b")!.runtime;
  controller.replaceSource("a", APP("A2"));
  const a = controller.get("a")!;
  assert.deepStrictEqual(textsOf(a.runtime), ["A2: 0"], "new program running");
  assert.notStrictEqual(a.runtime, aRtBefore, "a got a fresh VM");
  // b's runtime identity is unchanged — it was not restarted.
  assert.strictEqual(controller.get("b")!.runtime, bRt);
});

test("update() with only a sizing change does NOT restart the VM", () => {
  const rtBefore = controller.get("a")!.runtime;
  controller.update("a", { height: 321 });
  assert.strictEqual(controller.get("a")!.runtime, rtBefore, "same VM kept");
  assert.strictEqual(controller.get("a")!.def.height, 321);
});

test("remove() frees the VM and drops it from the set", () => {
  const removed = controller.remove("a");
  assert.ok(removed);
  assert.strictEqual(controller.get("a"), null);
  assert.deepStrictEqual(controller.ids(), ["b"]);
});

test("setApps() reconciles like the declarative prop (add/keep/remove)", () => {
  const bRt = controller.get("b")!.runtime;
  controller.setApps([
    { id: "b", source: APP("B") }, // unchanged → same VM kept
    { id: "c", source: APP("C") }, // new → boots
  ]);
  assert.deepStrictEqual(controller.ids(), ["b", "c"]);
  assert.strictEqual(controller.get("b")!.runtime, bRt, "unchanged b kept its VM");
  assert.deepStrictEqual(textsOf(controller.get("c")!.runtime), ["C: 0"]);
});

test("subscribe()/unsubscribe() delivers change notifications", () => {
  let hits = 0;
  const unsub = controller.subscribe(() => { hits++; });
  controller.add({ id: "d", source: APP("D") });
  assert.strictEqual(hits, 1, "notified on add");
  unsub();
  controller.remove("d");
  assert.strictEqual(hits, 1, "no notification after unsubscribe");
});

test("dispose() frees all remaining VMs", () => {
  controller.dispose();
  assert.strictEqual(controller.list().length, 0);
  assert.throws(() => controller.add({ id: "x", source: APP("X") }), /disposed/);
});

// A controller built from wasm bytes boots pending apps once the module loads.
// (Awaited directly — the sync `test()` helper can't host an async body.)
const lazy = new VictorMiniAppsController({ wasm });
{
  const h = lazy.add({ id: "late", source: APP("L") });
  assert.strictEqual(h.status, "pending", "queued while the module compiles");
  assert.strictEqual(lazy.get("late")!.runtime, null);
  await lazy.ready();
  assert.strictEqual(lazy.get("late")!.status, "running", "booted on engine ready");
  assert.deepStrictEqual(textsOf(lazy.get("late")!.runtime), ["L: 0"]);
  lazy.dispose();
  passed++;
  console.log("  ok  pending before ready, running after ready() resolves");
}

console.log(`\n${passed} mini-app controller tests passed.`);
