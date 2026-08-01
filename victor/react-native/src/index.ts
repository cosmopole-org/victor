// victor-react-native — run the Elpian VM as a cross-platform 2D (React Native)
// + 3D (embedded Godot) engine. The VM owns all app-code execution; React
// Native and Godot are the presentation layer, bridged over the op protocol
// exactly as the Godot host bridges them today.
//
// Typical use (Expo):
//
//   const runtime = await createWasmRuntime(wasmBytes, { onLog: console.log });
//   runtime.start(source);              // source = your guest program (JS)
//   return <VictorHost runtime={runtime} engine={godotEngine} />;

export * from "./core/protocol.ts";
export { WidgetStore, type WidgetNode } from "./core/widgetStore.ts";
export { HostDispatcher, type InvokeSink } from "./core/hostDispatcher.ts";
export {
  MockScene3dEngine,
  type Scene3dEngine,
} from "./core/scene3dEngine.ts";
export type { RnScene3dEngine } from "./scene3d/engine.ts";
export { Scene3dSurface } from "./scene3d/Scene3dSurface.tsx";
export {
  getElpianGodotNative,
  type ElpianGodotNative,
} from "./scene3d/godotBinding.ts";
export { GodotScene3dEngineCore } from "./scene3d/godotEngineCore.ts";
export {
  GodotScene3dEngine,
  createGodotScene3dEngine,
} from "./scene3d/GodotScene3dEngine.tsx";

export {
  type VmBackend,
  type HostCall,
  WasmBackend,
} from "./vm/backend.ts";
export {
  NativeVmBackend,
  getElpianRnNative,
  type ElpianRnNative,
} from "./vm/nativeBackend.ts";
export { ElpianRuntime, type RuntimeOptions } from "./vm/runtime.ts";

// Mini-app management — run many isolated Elpian mini apps in one shared VM
// instance, each rendering its own React Native tree.
export { VictorEngine } from "./miniapps/engine.ts";
export {
  VictorMiniApps,
  type VictorMiniAppsProps,
  type MiniAppDef,
  type MiniAppsLayout,
} from "./miniapps/VictorMiniApps.tsx";

export { VictorHost, type VictorHostProps } from "./render/VictorHost.tsx";
export { renderNode, WidgetView, type RenderContext } from "./render/renderNode.tsx";
export { toStyle, STYLE_KEYS } from "./render/style.ts";
export { componentFor, registerComponent } from "./render/components.ts";
export {
  RN_COMPONENTS,
  RN_ALIASES,
  specFor,
  canonicalName,
  type ComponentSpec,
  type WidgetKind,
} from "./render/rnComponents.ts";

import { WasmBackend, type HostCall } from "./vm/backend.ts";
import { NativeVmBackend } from "./vm/nativeBackend.ts";
import { ElpianRuntime, type RuntimeOptions } from "./vm/runtime.ts";

/**
 * Instantiate the `elpian_rn.wasm` VM and wrap it in a ready `ElpianRuntime`.
 * Resolves the backend ⇄ dispatcher wiring: the wasm module's `host_call`
 * import is late-bound to the runtime's dispatcher created just after.
 *
 * `wasmBytes` is the module built from `native/elpian-rn`
 * (`cargo build -p elpian-rn --target wasm32-unknown-unknown --release`).
 * Call `runtime.start(source)` afterwards.
 */
export async function createWasmRuntime(
  wasmBytes: BufferSource,
  opts: RuntimeOptions = {},
): Promise<ElpianRuntime> {
  // Late-bound host: the wasm import needs a callback at instantiation, but the
  // dispatcher that services it only exists once the runtime is built.
  let host: HostCall = () => null;
  const backend = await WasmBackend.instantiate(wasmBytes, (n, a) => host(n, a));
  const runtime = new ElpianRuntime(backend, opts);
  host = (n, a) => runtime.dispatcher.handle(n, a);
  return runtime;
}

/**
 * Instantiate the VM through the **native** JSI backend (`libelpian_rn`),
 * synchronously — the on-device path where Hermes has no WebAssembly. The host
 * dispatcher is bound when `runtime.start(source)` calls `backend.create`, so
 * unlike {@link createWasmRuntime} there is no wasm module to fetch. Throws if
 * the native library/JSI module is not installed; gate with
 * `NativeVmBackend.isAvailable()`.
 */
export function createNativeRuntime(opts: RuntimeOptions = {}): ElpianRuntime {
  return new ElpianRuntime(new NativeVmBackend(), opts);
}

/**
 * Pick the best available backend: the native JSI VM when installed (device),
 * otherwise the wasm VM from `wasmBytes` (web/Expo). `wasmBytes` may be omitted
 * on platforms known to be native; it is required for the wasm fallback.
 */
export async function createRuntime(
  opts: RuntimeOptions & { wasmBytes?: BufferSource } = {},
): Promise<ElpianRuntime> {
  const { wasmBytes, ...runtimeOpts } = opts;
  if (NativeVmBackend.isAvailable()) {
    return createNativeRuntime(runtimeOpts);
  }
  if (!wasmBytes) {
    throw new Error(
      "No VM backend available: the native JSI backend is not installed and no " +
        "wasmBytes were supplied for the wasm fallback.",
    );
  }
  return createWasmRuntime(wasmBytes, runtimeOpts);
}
