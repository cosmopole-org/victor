// Zero-React web entry: boot the Elpian VM (wasm) and render its widgets as
// native DOM directly into a container — no React, no reconciler. This is the
// web analogue of the native mount: the VM drives the DOM through the shared
// WidgetSink. Import this module directly (not the React barrel) so a web build
// pulls in no React.
//
//   import { mountDom } from "victor-react-native/src/render/mountDom.ts";
//   const rt = await mountDom({ wasmBytes, source, container: document.body });

import { WasmBackend, type HostCall } from "../vm/backend.ts";
import { ElpianRuntime } from "../vm/runtime.ts";
import type { Scene3dEngine } from "../core/scene3dEngine.ts";
import { DomWidgetRenderer, type DomDocument, type DomEl } from "./domWidgetRenderer.ts";

export interface MountDomOptions {
  /** The `elpian_rn.wasm` bytes (fetch them, e.g. from the served asset). */
  wasmBytes: BufferSource;
  /** The guest program to run. */
  source: string;
  /** The DOM element the Victor UI mounts into (e.g. `document.body`). */
  container: DomEl;
  /** Document to build in; defaults to the global `document`. */
  document?: DomDocument;
  lang?: "js" | "dart";
  /** Optional web Scene3D engine (Godot HTML5) for `RNScene3D` widgets. */
  scene3d?: Scene3dEngine;
  onLog?: (line: string) => void;
}

/**
 * Mount a Victor guest as native DOM. Returns the running `ElpianRuntime` (call
 * `.stop()` to tear down). The VM's `rn.op` stream drives the DOM through
 * `DomWidgetRenderer`; widget events route back into the VM — all without React.
 */
export async function mountDom(opts: MountDomOptions): Promise<ElpianRuntime> {
  const doc: DomDocument =
    opts.document ?? (globalThis as { document?: DomDocument }).document!;

  let runtime: ElpianRuntime;
  const renderer = new DomWidgetRenderer({
    document: doc,
    container: opts.container,
    fire: (id, event, arg) => runtime.fireEvent(id, event, arg),
  });

  // Late-bound host: the wasm import needs a callback at instantiate time, but
  // the dispatcher that services it exists only once the runtime is built.
  let host: HostCall = () => null;
  const backend = await WasmBackend.instantiate(opts.wasmBytes, (n, a) => host(n, a));
  runtime = new ElpianRuntime(backend, {
    widgets: renderer,
    scene3d: opts.scene3d,
    onLog: opts.onLog,
  });
  host = (n, a) => runtime.dispatcher.handle(n, a);

  runtime.start(opts.source, { lang: opts.lang ?? "js" });
  return runtime;
}
