// Capture the exact godot.op stream the showcase emits through the REAL wasm VM,
// with a fire-and-forget engine (echoes def) that replicates the on-device/web
// embed. Dumps the mount message and the add_child ops so the mount-handle vs
// content-parent mismatch is visible. node --experimental-strip-types test/capture-godot.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WasmBackend } from "../src/vm/backend.ts";
import { ElpianRuntime } from "../src/vm/runtime.ts";
import { SHOWCASE_GUEST_SOURCE } from "../src/example/showcaseSource.ts";
import type { Op } from "../src/core/protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, "../web/elpian_rn.wasm");
const wasm = fs.readFileSync(wasmPath);

const captured: Array<{ kind: string; op?: Op; mount?: number; surface?: number }> = [];
const engine = {
  op(op: Op) {
    captured.push({ kind: "op", op });
    return typeof op.def === "number" && op.def !== 0 ? (op.def as number) : null;
  },
  batch(ops: Op[]) {
    return ops.map((o) => this.op(o));
  },
  mountSurface(surfaceId: number, mountNode: number) {
    captured.push({ kind: "mount", mount: mountNode, surface: surfaceId });
  },
  releaseSurface() {},
};

let host: (n: string, a: string) => string | null = () => null;
const backend = await WasmBackend.instantiate(wasm, (n, a) => host(n, a));
const rt = new ElpianRuntime(backend, { scene3d: engine as never });
host = (n, a) => rt.dispatcher.handle(n, a);
rt.start(SHOWCASE_GUEST_SOURCE, { lang: "js" });
rt.stop();

const mount = captured.find((c) => c.kind === "mount");
console.log("MOUNT message:", JSON.stringify(mount));

const creates = captured.filter((c) => c.op && (c.op as Op).new !== undefined);
console.log(`\nfirst 6 creates (new):`);
for (const c of creates.slice(0, 6)) console.log(" ", JSON.stringify(c.op));

const adds = captured.filter(
  (c) => c.op && (c.op as { method?: string }).method === "add_child",
);
console.log(`\nfirst 6 add_child ops (parent ref -> child):`);
for (const c of adds.slice(0, 6)) console.log(" ", JSON.stringify(c.op));

const mountVal = mount?.mount;
const addsToMount = adds.filter((c) => (c.op as { ref?: number }).ref === mountVal);
console.log(
  `\nmount handle = ${mountVal}; add_child ops targeting it = ${addsToMount.length} / ${adds.length} total`,
);
console.log(`total godot ops captured = ${captured.length}`);

// Write the full ordered queue exactly as OpSink drains it, for headless replay.
const queue = captured.map((c) =>
  c.kind === "mount" ? { mount: c.mount } : { op: c.op },
);
const outPath = path.join(os.tmpdir(), "godot-ops.json");
fs.writeFileSync(outPath, JSON.stringify(queue));
console.log(`\nwrote full queue (${queue.length} msgs) -> ${outPath}`);
