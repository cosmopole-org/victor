// Native VM backend (JSI) transport test — no device, no wasm.
//
//   node --experimental-strip-types test/nativeBackend.test.ts
//
// Installs a fake `globalThis.__ElpianRN` binding (the shape the on-device JSI
// module exposes) and drives a full ElpianRuntime through it: this proves the
// `NativeVmBackend` ⇄ dispatcher wiring — that `create` forwards source/lang/
// prepend and a working synchronous host, that a guest host call round-trips
// through the runtime's dispatcher to build the widget tree, and that
// run/invoke/free reach the binding. The device build swaps this fake for the
// real Rust library; the JS contract exercised here is identical.

import assert from "node:assert";
// Import the Node-safe modules directly (not the barrel `../src/index.ts`,
// which re-exports React Native `.tsx` components Node cannot type-strip).
import {
  getElpianRnNative,
  NativeVmBackend,
  type ElpianRnNative,
} from "../src/vm/nativeBackend.ts";
import { ElpianRuntime, type RuntimeOptions } from "../src/vm/runtime.ts";

/** Mirror of `createNativeRuntime` from the barrel, inlined so this test stays
 * free of the React Native imports the barrel pulls in. */
function createNativeRuntime(opts: RuntimeOptions = {}): ElpianRuntime {
  return new ElpianRuntime(new NativeVmBackend(), opts);
}

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** A fake native binding: on `run`, it replays a small op stream through the
 * host exactly as the real VM would when a guest builds a View+Text and mounts
 * it, then records every C-ABI call for assertions. */
function installFakeNative(): { calls: string[] } {
  const calls: string[] = [];
  let host: ((name: string, argsJson: string) => string | null) | null = null;
  const log: string[] = [];

  const fake: ElpianRnNative = {
    create(source, lang, prepend, h) {
      calls.push(`create:${lang}:${prepend}:${source.length > 0}`);
      host = h;
      return 42; // non-zero runtime handle
    },
    run(rt) {
      calls.push(`run:${rt}`);
      // Mirror the guest: create RNView(1), RNText(2, "hi"), add child, root=1.
      const op = (o: object) => host!("rn.op", JSON.stringify([o]));
      assert.strictEqual(JSON.parse(op({ new: "RNView", def: 1 }) ?? "null"), 1);
      op({ new: "RNText", def: 2 });
      op({ ref: 2, props: { text: "hi native" } });
      op({ ref: 1, method: "add_child", args: [{ ref: 2 }] });
      op({ root: true, ref: 1 });
      log.push("native runtime up");
    },
    pump(rt, deltaMs) {
      calls.push(`pump:${rt}:${deltaMs}`);
    },
    invoke(rt, fnName, argJson) {
      calls.push(`invoke:${rt}:${fnName}:${argJson}`);
    },
    takeLog(rt) {
      calls.push(`takeLog:${rt}`);
      const out = log.slice();
      log.length = 0;
      return JSON.stringify(out); // native returns a JSON string
    },
    stats(rt) {
      calls.push(`stats:${rt}`);
      return JSON.stringify({ vms: 1 });
    },
    lastError() {
      return "";
    },
    free(rt) {
      calls.push(`free:${rt}`);
    },
  };
  (globalThis as { __ElpianRN?: ElpianRnNative }).__ElpianRN = fake;
  return { calls };
}

function uninstallFakeNative(): void {
  delete (globalThis as { __ElpianRN?: ElpianRnNative }).__ElpianRN;
}

test("isAvailable reflects whether the binding is installed", () => {
  uninstallFakeNative();
  assert.strictEqual(NativeVmBackend.isAvailable(), false);
  assert.strictEqual(getElpianRnNative(), null);
  installFakeNative();
  assert.strictEqual(NativeVmBackend.isAvailable(), true);
  assert.ok(getElpianRnNative());
  uninstallFakeNative();
});

test("createNativeRuntime drives the VM through the JSI binding", () => {
  const { calls } = installFakeNative();
  try {
    const rt = createNativeRuntime({ onLog: () => {} });
    rt.start("function main(){}\nmain();", { lang: "js", prepend: true });

    // The backend forwarded create(source, lang, prepend, host) and ran.
    assert.ok(
      calls.some((c) => c.startsWith("create:js:true:true")),
      `expected a create call; got ${calls.join(", ")}`,
    );
    assert.ok(calls.some((c) => c.startsWith("run:42")), "expected run to be called");

    // The host round-trip built the widget tree inside the runtime's dispatcher.
    const root = rt.dispatcher.store.root();
    assert.ok(root, "expected a mounted root");
    assert.strictEqual(root!.className, "RNView");
    assert.strictEqual(rt.dispatcher.store.get(2)!.props.text, "hi native");

    // Stats + events reach the binding.
    assert.deepStrictEqual(rt.stats(), { vms: 1 });
    rt.stop();
  } finally {
    uninstallFakeNative();
  }
});

test("requiring the native backend without a binding throws a clear error", () => {
  uninstallFakeNative();
  assert.throws(() => new NativeVmBackend(), /native Elpian VM backend .* not installed/);
});

console.log(`\n${passed} native-backend tests passed.`);
