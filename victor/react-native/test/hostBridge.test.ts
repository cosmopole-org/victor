// Host-bridge tests — exercise the `host.call` seam that lets a mini app reach
// the embedding app asynchronously (and get the reply back via `__hostReply`),
// against the framework-agnostic HostDispatcher. This is the path a Decillion
// "desktop" uses to sign a tool frontend's Caspar request with the human user's
// identity: the mini app asks, the host performs, the value comes back.
//
//   node --experimental-strip-types test/hostBridge.test.ts

import assert from "node:assert";
import { HostDispatcher, type HostBridge } from "../src/core/hostDispatcher.ts";
import { MockScene3dEngine } from "../src/core/scene3dEngine.ts";

let passed = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`  ok  ${name}`);
  });
}

// A dispatcher wired like the runtime wires it: `__hostReply` invocations are
// captured so a test can assert the guest-visible reply.
function make(bridge?: HostBridge) {
  const d = new HostDispatcher(new MockScene3dEngine());
  const replies: Array<[string | number, boolean, unknown]> = [];
  d.setInvokeSink((fn, argJson) => {
    if (fn === "__hostReply") replies.push(JSON.parse(argJson));
  });
  if (bridge) d.setHostBridge(bridge);
  return { d, replies };
}

function call(d: HostDispatcher, rid: number, method: string, payload: unknown) {
  return d.handle("host.call", JSON.stringify([{ rid, method, payload }]));
}

async function tick() {
  // Drain the whole microtask queue (bridge promise + reply chain) via a
  // macrotask boundary — simpler than counting individual turns.
  await new Promise((r) => setTimeout(r, 0));
}

await test("resolves a host.call back into the guest with its rid", async () => {
  const { d, replies } = make(async (method, payload) => {
    assert.strictEqual(method, "sandbox.invoke");
    return { ok: true, echo: payload };
  });
  const sync = call(d, 7, "sandbox.invoke", { function: "list_dir", path: "/" });
  // host.call returns null synchronously — the answer is delivered out-of-band.
  assert.strictEqual(sync, null);
  assert.strictEqual(replies.length, 0, "reply is async, not synchronous");
  await tick();
  assert.strictEqual(replies.length, 1);
  const [rid, ok, data] = replies[0];
  assert.strictEqual(rid, 7);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(data, { ok: true, echo: { function: "list_dir", path: "/" } });
});

await test("a rejecting bridge surfaces as an error reply", async () => {
  const { d, replies } = make(async () => {
    throw new Error("access denied");
  });
  call(d, 1, "sandbox.invoke", {});
  await tick();
  assert.deepStrictEqual(replies[0], [1, false, "access denied"]);
});

await test("no host bridge fails cleanly instead of hanging", async () => {
  const { d, replies } = make(); // no bridge installed
  call(d, 2, "whatever", {});
  await tick();
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0][1], false);
});

await test("a synchronous bridge value is delivered too", async () => {
  const { d, replies } = make((_m, _p) => 42);
  call(d, 3, "answer", null);
  await tick();
  assert.deepStrictEqual(replies[0], [3, true, 42]);
});

await test("concurrent calls keep their own rids", async () => {
  const { d, replies } = make(async (_m, payload) => payload);
  call(d, 10, "a", "first");
  call(d, 20, "b", "second");
  await tick();
  const byRid = new Map(replies.map((r) => [r[0], r[2]]));
  assert.strictEqual(byRid.get(10), "first");
  assert.strictEqual(byRid.get(20), "second");
});

console.log(`\n${passed} passed`);
