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

## Install (as a package) & run mini apps

Add it to any Expo / React Native project and use it as a **mini-app management
system**: a sized view into which you drop mini apps, each defined by its own
Elpian-based JS program. Victor runs every mini app as its own **isolated VM**
(separate instance — separate memory and globals) rendering its own React Native
tree, and reconciles them by `id` (add boots a VM, remove frees it, changing a
program restarts just that one).

```sh
npm install victor-react-native
# peers you already have in an Expo app: expo, react, react-native
```

```tsx
import { VictorMiniApps } from "victor-react-native";

// The VM module (elpian_rn.wasm) as bytes. On web, fetch the shipped asset;
// pass whatever returns an ArrayBuffer for your platform.
const loadWasm = () =>
  fetch(require("victor-react-native/wasm")).then((r) => r.arrayBuffer());

const clock = `
  import 'reactnative.js';
  var t = null; var n = 0;
  function tick(){ n = n + 1; t.set("text", "tick " + n); }
  function main(){
    var c = RN.column({ flex:1, bg:"#0b1220", padding:16, justify:"center" });
    t = RN.text("tick 0", { color:"#38bdf8", fontSize:28, textAlign:"center" });
    c.add(t);
    c.add(RN.button({ title:"+1", onPress: function(e){ tick(); } }));
    RN.mount(c);
  }
  main();
`;

const counter = `
  import 'reactnative.js';
  var n = 0; var label = null;
  function main(){
    var c = RN.column({ flex:1, bg:"#111827", padding:16, gap:8, justify:"center" });
    label = RN.text("count: 0", { color:"#e2e8f0", fontSize:22, textAlign:"center" });
    c.add(label);
    c.add(RN.row({ gap:8 }));
    c.add(RN.button({ title:"increment", onPress: function(e){ n = n + 1; label.set("text","count: "+n); } }));
    RN.mount(c);
  }
  main();
`;

export function MiniAppBoard() {
  return (
    <VictorMiniApps
      width="100%"
      height={480}
      wasm={loadWasm}          // or engine={preloadedVictorEngine}
      layout="grid"
      columns={2}
      gap={8}
      apps={[
        { id: "clock",   source: clock },
        { id: "counter", source: counter },
      ]}
      onLog={(appId, line) => console.log(appId, line)}
    />
  );
}
```

Each mini app's program is ordinary JavaScript compiled by `js2elpian` and run
on the VM (see “Writing a guest” below and `assets/guest/showcase.js` for a rich
one that also embeds a Godot 3D scene). Mini apps are isolated by construction: a
separate VM instance per app means one mini app can neither read nor touch
another's state or widgets. `layout` is `"column" | "row" | "grid" | "stack"`;
per-app `width`/`height`/`flex` override the cell size.

Lower-level control (one embedded mini app, manual lifecycle):

```tsx
import { VictorEngine, VictorHost } from "victor-react-native";

const engine = await VictorEngine.load(await loadWasm()); // compile once
const app = engine.createRuntime({ onLog: console.log });
app.start(source, { lang: "js" });
// render: <VictorHost runtime={app} />
// later:  app.stop();   // frees just this mini app's VM
```

> Import resolution uses the package `exports` map (`.` → the TypeScript
> library entry), so consumers get the library, while this repo's own Expo demo
> still boots from `index.js`. React Native 0.74+/Expo 51+ honor package
> exports. **On-device note:** Hermes has no WebAssembly, so today mini apps run
> live on **Expo web**; the native JSI `VmBackend` seam is where a device
> runtime plugs in (see “Platform notes”).

## Complete coverage + efficient patching

- **Every React Native element, by construction.** The renderer has no
  per-component `switch`: it resolves the host class reflectively against the
  full `react-native` surface (`rnComponents.ts` names the whole set;
  `components.ts` resolves each to a real component, `Animated.*` included), and
  passes **every** prop and **every** event through generically. Adding an
  element is a metadata line, so coverage can't drift. `registerComponent()`
  plugs in community/custom widgets. `test/components.test.ts` asserts the set is
  complete.
- **A change re-renders one widget, not the page.** The retained store keeps a
  per-node revision + per-node subscribers; each widget is a `React.memo`'d
  `<WidgetView/>` subscribed (`useSyncExternalStore`) to just its own node. A
  prop patch bumps only that node → only that component re-renders; a child-list
  edit bumps only the parent; a burst of writes coalesces to one re-render per
  node. `test/patching.test.ts` asserts it.

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
      rnComponents.ts         the complete RN element set (metadata; Node-testable)
      components.ts           reflective name -> RN component + registerComponent()
      renderNode.tsx          memoized per-widget <WidgetView/> (targeted patching)
      VictorHost.tsx          the top-level host component
      style.ts                prop -> RN style (+ STYLE_KEYS)
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
node --experimental-strip-types test/host.test.ts        # op interpreter + sandbox
node --experimental-strip-types test/style.test.ts       # prop → style
node --experimental-strip-types test/components.test.ts  # complete RN element coverage
node --experimental-strip-types test/patching.test.ts    # targeted re-render (no whole-tree)
node --experimental-strip-types test/wasm.test.ts        # REAL VM wasm end-to-end
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

See `assets/guest/app.js` for the minimal example and
**`assets/guest/showcase.js`** for a rich one — a scrollable page (header,
counter, text-input echo, `Switch`, `Slider`, `FlatList`, `Modal`,
`ActivityIndicator`, buttons) whose 2D controls **drive an embedded Godot
`Scene3D`** live (the switch toggles the key light, the slider rotates the mesh
group, buttons spawn/clear spheres). It is the Expo app's boot program
(`App.tsx` → `src/example/showcaseSource.ts`) and is compiled + run end-to-end
by the Rust test `boots_the_rich_showcase_example`.

## Android APK

`.github/workflows/react-native-android-apk.yml` builds this app into an
installable Android APK (Expo prebuild → `gradlew assembleDebug`) and commits it
to the repo root as `elpian-react-native-demo.apk`. Because Hermes has no
WebAssembly, the APK boots the RN shell and shows the graceful placeholder until
the native JSI `VmBackend` + native Godot view seams are installed; Expo **web**
runs the real VM today. (The separate `android-apk.yml` builds the native Godot
host demo — a different app.)

## One widget set, every platform (zero React glue)

The VM emits one op stream against **one canonical widget set** (the
`WidgetSink` interface in `src/core/widgetSink.ts`); a per-platform *renderer*
turns those ops into that platform's **own** native widgets, with no React
reconciler, state, or rendering in the path — the VM mutates the native tree
directly:

| Platform | VM backend | Widget renderer | 3D `Scene3D` |
| --- | --- | --- | --- |
| **Web** | `elpian_rn.wasm` | `DomWidgetRenderer` → real DOM (`mountDom`) | `WebGodotEngine` → Godot HTML5 |
| **Android** | JSI `NativeVmBackend` (`libelpian_rn.so`) | `NativeWidgetRenderer` → `android.view.View` (FlexboxLayout) | embedded Godot view |
| **iOS** | JSI `NativeVmBackend` (`libelpian_rn.a`) | `NativeWidgetRenderer` → `UIView` (UIStackView) | embedded Godot view |
| **Desktop** | the web build | `DomWidgetRenderer` in a shell | `WebGodotEngine` |

One guest program naming widget kinds (`view`, `text`, `scroll`, `input`,
`switch`, `slider`, `button`, `scene3d`, …) renders on all of them — the shared
`WIDGET_CATALOG` (`src/render/widgetCatalog.ts`) maps each kind to the right
native widget per platform. `scene3d` is just another widget in that set.

When a platform's native toolkit is present the VM drives it directly (the
single `<VictorSurface/>` host on mobile, the container element on web);
otherwise the React `<VictorHost/>` renders the retained store — the same graceful
fallback everywhere.

## Platform notes

- **Web / Expo web** — runs the real `elpian_rn.wasm` and drives real DOM through
  `DomWidgetRenderer` (jsdom-tested). `RN.Scene3D` renders through a Godot HTML5
  export when loaded (`web/godot/`), else a blank canvas.
- **Android** — the JSI `NativeVmBackend` runs the VM natively (Hermes has no
  WebAssembly); `NativeWidgetRenderer` builds an `android.view.View` tree and the
  embedded Godot module renders 3D. Built + shipped by the APK workflow.
- **iOS** — the same three native modules, authored to the Expo/iOS build (Swift
  + shared JSI C++); the Rust static lib, `libgodot.ios`, and the iOS GDExtension
  are Mac-only build artifacts (see each module's `ios/README.md`).
- **Desktop** — desktop *is* the web renderer: package the web build (real DOM
  widgets + Godot HTML5) in a native shell (Tauri/Electron). No new widget code —
  the same `mountDom` entry and guest program. Per-ABI/other-arch Godot binaries
  beyond `arm64` are additional build artifacts, not code changes.
