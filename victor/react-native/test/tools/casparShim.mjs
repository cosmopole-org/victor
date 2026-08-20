// Fake Caspar signaling shim + real tools-creature loader.
//
// It hosts the REAL decillionai-server `tools/registerCommands` and
// `tools/listCommands` WASM creatures (built by build-creatures.sh as reactor
// c-shared modules) and services their single `hostCall` seam with an in-memory
// key/value store — exactly the getJson/putJson/signalUser contract the Caspar
// node provides. Both creatures share one store, so a register is visible to a
// later list, just like on-chain.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dec = new TextDecoder();
const enc = new TextEncoder();
const here = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS = path.join(here, "artifacts");
export function creaturesBuilt() {
  return (
    fs.existsSync(path.join(ARTIFACTS, "listCommands.reactor.wasm")) &&
    fs.existsSync(path.join(ARTIFACTS, "registerCommands.reactor.wasm"))
  );
}

// The in-memory chain store + the host that services a creature's hostCall.
export function makeCaspar() {
  const kv = new Map(); // key -> (path -> value)
  const get = (key, p) => (kv.get(key) ? kv.get(key).get(p) : undefined);
  const put = (key, p, data, merge) => {
    let m = kv.get(key);
    if (!m) { m = new Map(); kv.set(key, m); }
    if (merge && data && typeof data === "object" && !Array.isArray(data)) {
      const cur = m.get(p) && typeof m.get(p) === "object" ? m.get(p) : {};
      for (const [k, v] of Object.entries(data)) {
        if (v === null) delete cur[k];
        else cur[k] = v;
      }
      m.set(p, cur);
    } else m.set(p, data);
  };
  const host = (op, input) => {
    input = input || {};
    if (op === "getJson") return { data: get(input.key, input.path) ?? {} };
    if (op === "putJson") { put(input.key, input.path, input.data, !!input.merge); return { ok: true }; }
    if (op === "signalUser") return { ok: true };
    return {};
  };
  return { kv, host };
}

function wasiShim(getMem) {
  const dv = () => new DataView(getMem().buffer);
  return {
    sched_yield: () => 0,
    proc_exit: (c) => { throw new Error("creature proc_exit " + c); },
    args_get: () => 0,
    args_sizes_get: (a, b) => { dv().setUint32(a, 0, true); dv().setUint32(b, 0, true); return 0; },
    environ_get: () => 0,
    environ_sizes_get: (a, b) => { dv().setUint32(a, 0, true); dv().setUint32(b, 0, true); return 0; },
    clock_time_get: (id, prec, out) => {
      dv().setBigUint64(out, BigInt(Math.max(1, Math.floor(performance.now() * 1e6))), true);
      return 0;
    },
    random_get: (ptr, len) => { new Uint8Array(getMem().buffer, ptr, len).fill(7); return 0; },
    poll_oneoff: () => 0,
    fd_close: () => 0,
    fd_write: (fd, iovs, n, nw) => {
      let total = 0;
      for (let i = 0; i < n; i++) total += dv().getUint32(iovs + i * 8 + 4, true);
      dv().setUint32(nw, total, true);
      return 0;
    },
    fd_fdstat_get: (fd, ptr) => { new Uint8Array(getMem().buffer, ptr, 24).fill(0); return 0; },
    fd_fdstat_set_flags: () => 0,
    fd_prestat_get: () => 8,
    fd_prestat_dir_name: () => 8,
  };
}

// Load one creature and return a `signal(action, payload, ctx)` function.
export async function loadCreature(name, host) {
  const mod = await WebAssembly.compile(fs.readFileSync(path.join(ARTIFACTS, `${name}.reactor.wasm`)));
  let inst;
  let mem;
  const env = {
    hostCall: (ptr, len) => {
      const req = JSON.parse(dec.decode(new Uint8Array(mem.buffer, ptr, len)));
      const res = host(req.op, req.input || {});
      const rb = enc.encode(JSON.stringify(res));
      const resPtr = inst.exports.hresptr();
      new Uint8Array(mem.buffer, resPtr, rb.length).set(rb);
      return (BigInt(resPtr) << 32n) | BigInt(rb.length);
    },
  };
  inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasiShim(() => mem), env });
  mem = inst.exports.memory;
  inst.exports._initialize();
  return (action, payload, ctx = {}) => {
    const envelope = JSON.stringify({ path: action, payload, requesterId: ctx.requesterId || "1@global" });
    const ib = enc.encode(envelope);
    new Uint8Array(mem.buffer, inst.exports.hinptr(), ib.length).set(ib);
    const n = inst.exports.handle(ib.length);
    return JSON.parse(dec.decode(new Uint8Array(mem.buffer, inst.exports.houtptr(), n)));
  };
}
