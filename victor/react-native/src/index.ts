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
  type VmBackend,
  type HostCall,
  WasmBackend,
} from "./vm/backend.ts";
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
