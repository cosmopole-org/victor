# victor-react-native — the React Native / Expo host for Victor

Run the **Elpian VM** as a fully cross-platform **2D + 3D** engine. The VM does
all app-code execution (no JIT — App-Store-legal, runs on the web); **React
Native / Expo** renders the 2D widget tree and **Godot** renders embedded 3D
`Scene3D` worlds. It is the exact inverse of the Godot host: there Godot owns the
scene and 2D is drawn on `Control` nodes; here **React Native owns the 2D tree
and Godot is a widget in it.**

```
  Guest program (JavaScript)  — all logic, on the Elpian VM
        │  import 'godot.js'; import 'reactnative.js';
        ▼
  Elpian VM  (elpian_rn.wasm — the SAME multi-VM manager the Godot host uses)
        │  askHost("rn.op" | "rn.batch")            askHost("godot.op")
        ▼                                                   ▼
  React Native widget tree  ◀── VictorHost ──▶  embedded Godot  ◀── Scene3dSurface
  (View/Text/Pressable/…)                        (Camera/Lights/Meshes/Physics)
```

## Why this design

- **The VM is unchanged.** `elpian_rn.wasm` reuses `elpian-godot-capi`'s
  `VmManager` verbatim, so the **multi-VM hierarchy, per-VM capabilities and
  resource limits, and sandboxed handle namespacing** all work exactly as on the
  Godot host. A child VM can only touch widgets inside its assigned subtree, and
  its events route back to it — governance for free.
- **The op protocol is unchanged.** The 2D `rn.op` seam is a twin of the Godot
  `godot.op` seam (same handle/callback shapes), so the manager applies the
  identical `sanitize_op` sandbox stamping to it (see
  `bridge/capi/src/manager.rs`).
- **All of Godot's 3D is kept.** Inside an `RN.Scene3D` you build with the
  ordinary `GD` / `G3` surface from `godot.js` — every engine class, unchanged.

## Layout

```
react-native/
  native/elpian-rn/       Rust → wasm bridge. Reuses VmManager; one host_call import.
  src/
    core/                 Framework-agnostic, Node-testable:
      protocol.ts           the op wire types
      widgetStore.ts        the retained 2D tree
      hostDispatcher.ts     the op interpreter (the "GodotController" for RN)
      scene3dEngine.ts      the embedded-Godot seam + a mock
    vm/
      backend.ts            VmBackend interface + WasmBackend (loads the .wasm)
      runtime.ts            frame loop + event routing
      loadWasm[.web].ts     platform module loader
    render/                 React Native renderer:
      renderNode.tsx          WidgetNode -> RN component
      VictorHost.tsx          the top-level host component
      style.ts                prop -> RN style
    scene3d/                Scene3dSurface.tsx + the RnScene3dEngine contract
    index.ts              public API (createWasmRuntime, VictorHost, …)
  App.tsx                 Expo entry: load VM, boot guest, render host
  test/                   host.test.ts · style.test.ts · wasm.test.ts (real VM)
```

## Build & run

```sh
# 1. Build the VM to WebAssembly (the real app-execution layer)
cd victor
cargo build -p elpian-rn --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/elpian_rn.wasm react-native/web/elpian_rn.wasm

# 2. Install and run the Expo app (web is the zero-native-deps target)
cd react-native
npm install
npm run web        # or: npm run ios / npm run android
```

## Tests

No emulator needed. The core is pure and Node-testable; the wasm test drives the
real VM:

```sh
cargo test -p elpian-rn                        # Rust: prelude → VM → rn.op pipeline
cd react-native
node --experimental-strip-types test/host.test.ts    # op interpreter + sandbox
node --experimental-strip-types test/style.test.ts    # prop → style
node --experimental-strip-types test/wasm.test.ts     # REAL VM wasm end-to-end
```

## Writing a guest

Guest code is ordinary JavaScript compiled by `js2elpian` and run on the VM:

```js
import 'godot.js';
import 'reactnative.js';

function main() {
  var page = RN.column({ flex: 1, bg: '#0f172a', padding: 24, gap: 12 });
  page.add(RN.text('Hello', { color: '#e2e8f0', fontSize: 22 }));
  page.add(RN.button({ title: 'Tap', onPress: (e) => RN.toast('hi') }));

  var scene = RN.scene3d({ height: 220 });        // Godot, as a widget
  scene.scene3d.call('add_child', [G3.camera({ position: [0, 2, 6] })]);
  scene.scene3d.call('add_child', [G3.mesh('box', { color: new Color(0.3, 0.6, 1, 1) })]);
  page.add(scene);

  RN.mount(page);
}
main();
```

See `assets/guest/app.js` for the full example. Prefer the React programming
model? The same `rn.op` backend can drive VReact — see the roadmap in
`wiki/13-react-native.md`.

## Platform notes

- **Web / Expo web** — runs the real `elpian_rn.wasm` today. Godot 3D can be a
  Godot HTML5 export wired to an `RnScene3dEngine`.
- **iOS / Android / desktop** — Hermes has no WebAssembly runtime, so the
  production native path is a JSI `VmBackend` (build `native/elpian-rn` as a
  static lib behind an Expo module) plus a native Godot view. The seams for both
  are defined (`VmBackend`, `RnScene3dEngine`); until they're installed, native
  shows a graceful placeholder while the 2D app runs.
