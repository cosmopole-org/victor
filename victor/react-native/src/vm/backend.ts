// The VM backend — how the host actually runs the Elpian VM. There is one real
// backend (`WasmBackend`, the `elpian_rn.wasm` module built from
// `native/elpian-rn`) plus an injectable interface so tests and future native
// JSI transports can stand in. The VM does *all* app-code execution; this layer
// only marshals bytes across the wasm boundary and hands host calls to the
// dispatcher.

/** Services a forwarded guest host call: (name, argsJson) -> replyJson | null. */
export type HostCall = (name: string, argsJson: string) => string | null;

export interface VmBackend {
  /** Compile + boot a root VM running `source`. */
  create(source: string, lang: string, prepend: boolean, host: HostCall): void;
  /** Run `main()` and settle the tree. */
  run(): void;
  /** Advance clocks by `deltaMs`, fire due timers/microtasks, sweep budgets. */
  pump(deltaMs: number): void;
  /** Deliver a guest function one JSON argument (events, lifecycle). */
  invoke(fnName: string, argJson: string): void;
  /** Fresh `print` lines since the last call. */
  takeLog(): string[];
  /** JSON snapshot of the VM tree (per-VM + aggregate usage). */
  stats(): unknown;
  /** Last error string ("" when none). */
  lastError(): string;
  /** Destroy the tree. */
  free(): void;
}

interface RnExports {
  memory: WebAssembly.Memory;
  elpian_rn_alloc(len: number): number;
  elpian_rn_free_buf(ptr: number, total: number): void;
  elpian_rn_new(
    srcPtr: number,
    srcLen: number,
    langPtr: number,
    langLen: number,
    prepend: number,
  ): number;
  elpian_rn_run(rt: number): number;
  elpian_rn_pump(rt: number, deltaMs: bigint): number;
  elpian_rn_invoke(
    rt: number,
    fnPtr: number,
    fnLen: number,
    argPtr: number,
    argLen: number,
  ): number;
  elpian_rn_take_log(rt: number): number;
  elpian_rn_stats(rt: number): number;
  elpian_rn_last_error(): number;
  elpian_rn_free(rt: number): void;
}

/**
 * Runs the real Elpian VM (+ full multi-VM manager) compiled to WebAssembly.
 * Construct with the instantiated module; `create` boots the root VM and wires
 * the single `host_call` import to the dispatcher.
 */
export class WasmBackend implements VmBackend {
  private ex: RnExports;
  private rt = 0;
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  private constructor(ex: RnExports) {
    this.ex = ex;
  }

  /**
   * Instantiate `elpian_rn.wasm`. `host` is bound now because the wasm module
   * imports it; it is the dispatcher's `handle`. Works with a raw byte buffer
   * (web/Expo) — native JSI transports implement `VmBackend` directly instead.
   */
  static async instantiate(
    wasmBytes: BufferSource,
    host: HostCall,
  ): Promise<WasmBackend> {
    // Late-bound so the import can reach exports set after instantiation.
    let ex: RnExports | null = null;
    const readStr = (ptr: number, len: number): string =>
      this_dec(ex!).decode(new Uint8Array(ex!.memory.buffer, ptr, len));

    const importObject = {
      env: {
        host_call: (
          namePtr: number,
          nameLen: number,
          argsPtr: number,
          argsLen: number,
        ): number => {
          const name = readStr(namePtr, nameLen);
          const argsJson = readStr(argsPtr, argsLen);
          const reply = host(name, argsJson);
          if (reply === null || reply === undefined) return 0;
          return writePrefixed(ex!, reply);
        },
      },
    };
    const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
    ex = instance.exports as unknown as RnExports;
    return new WasmBackend(ex);
  }

  create(source: string, lang: string, prepend: boolean, _host: HostCall): void {
    const src = this.write(source);
    const lg = this.write(lang);
    this.rt = this.ex.elpian_rn_new(src.ptr, src.len, lg.ptr, lg.len, prepend ? 1 : 0);
    this.ex.elpian_rn_free_buf(src.ptr, src.len);
    this.ex.elpian_rn_free_buf(lg.ptr, lg.len);
    if (this.rt === 0) throw new Error(`elpian_rn_new failed: ${this.lastError()}`);
  }

  run(): void {
    this.ex.elpian_rn_run(this.rt);
  }

  pump(deltaMs: number): void {
    this.ex.elpian_rn_pump(this.rt, BigInt(Math.max(0, Math.round(deltaMs))));
  }

  invoke(fnName: string, argJson: string): void {
    const fn = this.write(fnName);
    const arg = this.write(argJson);
    this.ex.elpian_rn_invoke(this.rt, fn.ptr, fn.len, arg.ptr, arg.len);
    this.ex.elpian_rn_free_buf(fn.ptr, fn.len);
    this.ex.elpian_rn_free_buf(arg.ptr, arg.len);
  }

  takeLog(): string[] {
    const ptr = this.ex.elpian_rn_take_log(this.rt);
    if (ptr === 0) return [];
    const json = this.readPrefixed(ptr);
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  }

  stats(): unknown {
    const ptr = this.ex.elpian_rn_stats(this.rt);
    if (ptr === 0) return null;
    try {
      return JSON.parse(this.readPrefixed(ptr));
    } catch {
      return null;
    }
  }

  lastError(): string {
    return this.readPrefixed(this.ex.elpian_rn_last_error());
  }

  free(): void {
    if (this.rt) {
      this.ex.elpian_rn_free(this.rt);
      this.rt = 0;
    }
  }

  // --- memory helpers ----------------------------------------------------
  private write(s: string): { ptr: number; len: number } {
    const bytes = this.enc.encode(s);
    const ptr = this.ex.elpian_rn_alloc(bytes.length || 1);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  private readPrefixed(ptr: number): string {
    if (ptr === 0) return "";
    const view = new DataView(this.ex.memory.buffer);
    const len = view.getUint32(ptr, true);
    const s = this.dec.decode(new Uint8Array(this.ex.memory.buffer, ptr + 4, len));
    this.ex.elpian_rn_free_buf(ptr, 4 + len);
    return s;
  }
}

// Free helpers used by the late-bound import closure.
function this_dec(_ex: RnExports): TextDecoder {
  return SHARED_DECODER;
}
const SHARED_DECODER = new TextDecoder();
const SHARED_ENCODER = new TextEncoder();

function writePrefixed(ex: RnExports, s: string): number {
  const bytes = SHARED_ENCODER.encode(s);
  const total = 4 + bytes.length;
  const ptr = ex.elpian_rn_alloc(total);
  const view = new DataView(ex.memory.buffer);
  view.setUint32(ptr, bytes.length, true);
  new Uint8Array(ex.memory.buffer, ptr + 4, bytes.length).set(bytes);
  return ptr;
}
