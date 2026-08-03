// Host-bridge END-TO-END against the REAL wasm VM — the gap that let a mini-app
// front-end hang on "Loading…" forever slip through.
//
// `test/hostBridge.test.ts` exercises the HostDispatcher in isolation with a mock
// invoke sink, so it never runs guest bytecode. But the documented guest pattern
// registers its reply callbacks in a plain object keyed by the request id, and
// the Elpian VM keys objects/maps by STRING only: `__hostCbs[<int>] = cb` traps
// the guest ("__setIndex expects a string, got i64") *before* `askHost` runs, so
// the host.call is never issued and the reply never comes. This test drives the
// real VM through the whole round-trip so that regression is caught here.
//
//   1. build:  cargo build -p elpian-rn --target wasm32-unknown-unknown --release
//   2. run:    node --experimental-strip-types test/hostBridgeVm.test.ts
//
// Skips (does not fail) when the module isn't built.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VictorEngine } from "../src/miniapps/engine.ts";
import { ElpianRuntime } from "../src/vm/runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Prefer a freshly built module; fall back to the one shipped in the package so
// the round-trip is still guarded on a checkout with no Rust toolchain.
const candidates = [
  path.resolve(here, "../../target/wasm32-unknown-unknown/release/elpian_rn.wasm"),
  path.resolve(here, "../web/elpian_rn.wasm"),
];
const wasmPath = candidates.find((p) => fs.existsSync(p));
if (!wasmPath) {
  console.log(`  skip  elpian_rn.wasm not found (${candidates.join(", ")})`);
  process.exit(0);
}

// The documented guest host-bridge (README § "The host bridge"), the exact shape
// a tool front-end ships. `rid` is a string on purpose — see the file header.
const GUEST = String.raw`
import 'reactnative.js';
var __hostSeq = 0;
var __hostCbs = {};
function __hostReply(a){
  var rid = '' + a[0];
  var cb = __hostCbs[rid];
  if (cb != null) { __hostCbs[rid] = null; cb(a[1] ? null : a[2], a[1] ? a[2] : null); }
}
function hostCall(method, payload, cb){
  __hostSeq = __hostSeq + 1;
  var rid = '' + __hostSeq;
  __hostCbs[rid] = cb;
  askHost('host.call', [{ rid: rid, method: method, payload: payload }]);
}
function main(){
  hostCall('list_dir', { path: '.' }, function(err, res){
    if (err != null) print('CB_ERR ' + err);
    else print('CB_OK ' + res.entries.length + ' first=' + res.entries[0].name);
  });
}
main();
`;

async function drain(rt: ElpianRuntime, ms: number): Promise<void> {
  // Let the runtime's own frame loop pump and the async bridge reply settle.
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  void rt;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const engine = await VictorEngine.load(fs.readFileSync(wasmPath));

await test("a guest host.call round-trips through the real VM to __hostReply", async () => {
  const logs: string[] = [];
  const calls: Array<{ method: string; payload: unknown }> = [];
  const runtime = engine.createRuntime({
    onLog: (line) => logs.push(line),
    onHostCall: async (method, payload) => {
      calls.push({ method, payload });
      await new Promise((r) => setTimeout(r, 5)); // async, like a Caspar round-trip
      return { ok: true, entries: [{ name: "README.md" }, { name: "src" }] };
    },
  });
  runtime.start(GUEST, { lang: "js" });
  await drain(runtime, 300);
  runtime.stop();

  const trapped = logs.find((l) => l.includes("__setIndex") || l.includes("trapped"));
  assert.ok(!trapped, `guest trapped instead of issuing host.call: ${trapped}`);
  assert.strictEqual(calls.length, 1, "the bridge was invoked exactly once");
  assert.deepStrictEqual(calls[0], { method: "list_dir", payload: { path: "." } });
  const ok = logs.find((l) => l.startsWith("CB_OK"));
  assert.ok(ok, `the guest callback never fired with the reply; logs: ${JSON.stringify(logs)}`);
  assert.ok(ok!.includes("first=README.md"), `reply payload not delivered: ${ok}`);
});

console.log(`\n${passed} passed`);
