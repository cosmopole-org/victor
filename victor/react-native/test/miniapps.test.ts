// Mini-app manager end-to-end: run TWO mini apps from ONE compiled VM module,
// each in its own isolated instance, and prove they are isolated — each mounts
// its own widget tree, an event in one mini app does not touch the other, and
// freeing one leaves the other running.
//
//   1. build:  cargo build -p elpian-rn --target wasm32-unknown-unknown --release
//   2. run:    node --experimental-strip-types test/miniapps.test.ts
//
// Skips (does not fail) when the module isn't built.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VictorEngine } from "../src/miniapps/engine.ts";
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

function textsOf(rt: ElpianRuntime): string[] {
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

function firstButton(rt: ElpianRuntime): number {
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

const APP_A = String.raw`
import "reactnative.js";
var n = 0; var label = null;
function main() {
  var col = RN.column({});
  label = RN.text("A: 0", {});
  col.add(label);
  col.add(RN.button({ title: "inc", onPress: function (e) { n = n + 1; label.set("text", "A: " + n); } }));
  RN.mount(col);
  print("A up");
}
main();
`;

const APP_B = String.raw`
import "reactnative.js";
function main() {
  var col = RN.column({});
  col.add(RN.text("B: hello", {}));
  RN.mount(col);
  print("B up");
}
main();
`;

const wasm = fs.readFileSync(wasmPath);
const engine = await VictorEngine.load(wasm);

// Two mini apps from one compiled module, each its own isolated instance
// (own dispatcher + widget store + VM memory).
const logsA: string[] = [];
const logsB: string[] = [];
const appA = engine.createRuntime({ onLog: (l) => logsA.push(l) });
const appB = engine.createRuntime({ onLog: (l) => logsB.push(l) });
appA.start(APP_A, { lang: "js" });
appB.start(APP_B, { lang: "js" });

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test("each mini app booted its own VM and printed", () => {
  assert.ok(logsA.some((l) => l.includes("A up")), `A logs: ${logsA}`);
  assert.ok(logsB.some((l) => l.includes("B up")), `B logs: ${logsB}`);
});

test("each mini app mounted its own isolated widget tree", () => {
  assert.deepStrictEqual(textsOf(appA), ["A: 0"]);
  assert.deepStrictEqual(textsOf(appB), ["B: hello"]);
  // Distinct stores — different object identities, no shared root.
  assert.notStrictEqual(appA.dispatcher.store, appB.dispatcher.store);
});

test("an event in mini app A routes to A only; B is untouched", () => {
  const btn = firstButton(appA);
  assert.ok(btn, "app A has a button");
  appA.fireEvent(btn, "press", null);

  assert.deepStrictEqual(textsOf(appA), ["A: 1"], "A updated");
  assert.deepStrictEqual(textsOf(appB), ["B: hello"], "B unchanged");
});

test("host calls routed correctly under interleaving (A again, then B intact)", () => {
  appA.fireEvent(firstButton(appA), "press", null);
  assert.deepStrictEqual(textsOf(appA), ["A: 2"]);
  assert.deepStrictEqual(textsOf(appB), ["B: hello"]);
});

test("freeing one mini app leaves the other running", () => {
  appB.stop(); // frees B's VM in the shared instance
  appA.fireEvent(firstButton(appA), "press", null);
  assert.deepStrictEqual(textsOf(appA), ["A: 3"], "A still live after B freed");
});

appA.stop();
console.log(`\n${passed} mini-app manager tests passed.`);
