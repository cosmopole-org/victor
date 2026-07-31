// VictorEngine — the mini-app host. Compile the Elpian VM wasm **once**, then
// run any number of mini apps, each in its own isolated instance of the VM (its
// own linear memory + VM state) driving its own React Native widget tree. This
// is the multi-VM idea put to work host-side: one compiled module, many isolated
// mini apps, added/removed/restarted cleanly.
//
//   const engine = await VictorEngine.load(await loadWasmBytes());
//   const app = engine.createRuntime({ onLog });
//   app.start(elpianJsSource);            // boots this mini app's VM
//   <VictorHost runtime={app} />          // renders its widget tree
//   app.stop();                           // frees just this mini app's VM
//
// Prefer the <VictorMiniApps/> component, which manages a whole set of these for
// you (add / remove / restart by id, sized layout). Use this class directly when
// you want manual control over a single embedded mini app.
//
// WHY ONE INSTANCE PER MINI APP. `WebAssembly.compile` runs once; each
// `createRuntime` does a cheap synchronous `WebAssembly.Instance` from that
// shared compiled module, so the compiled code is shared but every mini app gets
// its own memory and globals. That isolation is required, not just tidy: the
// js2elpian front-end keeps process-global compile-time state, so two
// independently-compiled programs must live in separate instances or they would
// corrupt each other. Separate instances also give each mini app the strongest
// possible sandbox — it literally cannot address another's memory.

import { ElpianRuntime, type RuntimeOptions } from "../vm/runtime.ts";
import { WasmBackend } from "../vm/backend.ts";

export class VictorEngine {
  private module: WebAssembly.Module;

  private constructor(module: WebAssembly.Module) {
    this.module = module;
  }

  /**
   * Compile the shared VM module from the `elpian_rn.wasm` bytes (built from
   * `native/elpian-rn`). Compiled once; each mini app instantiates from it.
   */
  static async load(wasmBytes: BufferSource): Promise<VictorEngine> {
    return new VictorEngine(await WebAssembly.compile(wasmBytes));
  }

  /** Wrap an already-compiled module (advanced / testing). */
  static fromCompiled(module: WebAssembly.Module): VictorEngine {
    return new VictorEngine(module);
  }

  /**
   * Create an **unstarted** mini-app runtime in a fresh isolated instance.
   * Call `.start(source, { lang })` to boot it, `<VictorHost runtime={…}/>` to
   * render it, and `.stop()` to free just that mini app's VM instance.
   */
  createRuntime(opts: RuntimeOptions = {}): ElpianRuntime {
    // Late-bind the host: the wasm import must exist at instantiation, but the
    // dispatcher that services it only exists once the runtime is built.
    let host: (n: string, a: string) => string | null = () => null;
    const backend = WasmBackend.fromModule(this.module, (n, a) => host(n, a));
    const runtime = new ElpianRuntime(backend, opts);
    host = (n, a) => runtime.dispatcher.handle(n, a);
    return runtime;
  }

  /** Create and boot a mini-app runtime in one call. */
  startRuntime(source: string, opts: RuntimeOptions = {}): ElpianRuntime {
    const rt = this.createRuntime(opts);
    rt.start(source, opts);
    return rt;
  }
}
