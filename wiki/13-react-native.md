# 13 — The React Native host (2D React Native + 3D Godot)

Victor's third UI story (after native VUI/VReact and embedded Flutter) is a
**React Native / Expo host**: the Elpian VM drives a real React Native widget
tree for 2D and keeps **Godot** for 3D as an embedded `Scene3D` widget. It
**inverts** the Godot host — there Godot owns the scene and 2D is painted on
`Control` nodes; here **React Native owns the 2D tree and Godot is a widget in
it** — so a Victor app becomes a first-class, cross-platform (mobile / desktop /
web) React Native app that still has all of Godot's 3D.

Code lives in `victor/react-native/`. Read that package's `README.md` for the
file map and build steps; this page explains *why it is correct* — how it keeps
the VM, the multi-VM governance, and the whole 3D engine intact.

## The one idea

Everything the guest does to the outside world is still `askHost(name, payload)`
(see `02-elpian-vm.md`). The React Native host services the same host-call
families the Godot host does, only the 2D one targets React Native instead of
Godot Controls:

| Family | Serviced by | Drives |
|---|---|---|
| `log` | host | `print` output |
| `rn.op` / `rn.batch` | `HostDispatcher` (TS) | the **React Native** widget tree |
| `godot.op` / `godot.batch` | the embedded Godot engine | the **3D** world inside a `Scene3D` |
| `vm.*` | the Rust `VmManager` (in wasm) | the multi-VM tree |

The guest imports `reactnative.js` for the 2D vocabulary and the ordinary
`godot.js` / `G3` for 3D. Both preludes are composed ahead of the program by the
same `compose_godot_program_js` used everywhere else (see
`bridge/capi/src/lib.rs`).

## Why the VM and its governance are unchanged

`victor/react-native/native/elpian-rn` compiles the **exact same**
`elpian-godot-capi::VmManager` to `wasm32-unknown-unknown`. The only new code is
a length-prefixed byte seam and a single imported `host_call` the JavaScript host
implements. Consequences:

- **Multi-VM / hierarchy / lifecycle** — `vm.spawn` / `pause` / `resume` /
  `terminate` / `send`, the VM tree, and aggregate budget sweeps are the same
  Rust code as on Godot (`05-godot-bridge.md`, "the multi-VM system").
- **Capabilities + resource limits** — enforced inside the executor, unchanged
  (`02-elpian-vm.md`, "Governance").
- **Sandboxing** — the manager namespaces every handle (`def`/`ref`/…) and
  callback (`cb`) into the calling VM's id space and stamps each op with the
  caller's sandbox root (`__sbx`). `rn.op`/`rn.batch` were added to the manager's
  `handle()` next to `godot.op`, so they get the **identical `sanitize_op`
  treatment**. A sandboxed child VM can therefore only touch widgets inside its
  assigned subtree, and its widget events route back to it — exactly the guarantee
  the Godot host gives, now for the React Native tree.

The host dispatcher (`src/core/hostDispatcher.ts`) is the React Native analogue
of the C++ `GodotController`: it interprets the op protocol (`new`/`set`/`get`/
`method`/`connect`/`free`/`chk`/`grant`/…) against a widget object model, honors
the `__sbx` containment stamp for `chk`/`grant` and every `ref`, and forwards
3D ops to the Godot engine.

## Why all of Godot's 3D is kept

An `RN.Scene3D` is a widget (an `rn.op` node) that the host renders as a viewport
into an embedded Godot engine. Its **contents are built with the ordinary `GD` /
`G3` surface** — every engine class, reflectively, exactly as in `05`. Those
calls cross the normal `godot.op` seam and are serviced by a real Godot 4 engine
(a Godot HTML5 export on web; a native Godot view on device). So you lose nothing:
cameras, lights, meshes, materials, physics, GLTF, shaders — all still Godot.

```js
var scene = RN.scene3d({ height: 240 });
var mount = scene.scene3d;                       // a GObj — the Godot mount node
mount.call("add_child", [G3.environment({})]);
mount.call("add_child", [G3.camera({ position: [0, 2, 6] })]);
mount.call("add_child", [G3.dirLight({ rotation: [-50, -30, 0] })]);
mount.call("add_child", [G3.mesh("box", { color: new Color(0.3, 0.6, 1, 1) })]);
```

## The `rn.op` protocol (what the prelude emits)

Same wire shape as the Godot op protocol so the manager's namespacing applies:

```
{ new: "RNView", def: id }                               create + bind handle
{ ref: id, props: { … } }  /  { ref: id, set: k, value } patch props
{ ref: id, method: "add_child", args: [{ ref: child }] } structural (add/insert/remove/clear)
{ ref: id, connect: "press", cb: cbId }                  bind an event -> guest closure
{ ref: id, method: "scene3d_mount", args: [{ ref: n }] } bind a Scene3D to a Godot node
{ root: true, ref: id }                                  mark the app root
{ ref: id, free: id }                                    drop a widget
```

### Complete component coverage (by construction)

The renderer does **not** hard-code a per-widget `switch`. It resolves the host
class **reflectively** against the *entire* React Native component surface — the
same "complete by construction" principle as the Godot ClassDB bridge (`05`) and
the Skia bridge (`08`):

- `src/render/rnComponents.ts` — framework-agnostic metadata naming **every**
  React Native element and its render `kind` (Node-testable; no `react-native`
  import). `test/components.test.ts` asserts the whole set is present, so the
  renderer can never fall behind React Native's component list.
- `src/render/components.ts` — `componentFor(name)` resolves each name to the
  real `react-native` component (including `Animated.*`), degrading gracefully
  to a `View`/`Text` fallback for a component absent on the current platform
  (e.g. `DrawerLayoutAndroid` on web). `registerComponent(name, Component)` is
  the open extension point for community/custom widgets
  (`@react-native-community/slider`, `react-native-webview`, `react-native-maps`, …).
- `src/render/renderNode.tsx` — a generic builder: it passes **every** prop the
  guest set through by name, translates the convenience/style keys into a
  `style` object (any RN style property is expressible via `style={{…}}`), and
  reconstructs **every** connected event as its `on<Event>` handler. So any RN
  prop and any event work, not a curated few.

Elements covered: the containers (`View`/`SafeAreaView`/`KeyboardAvoidingView`/
`Modal`/`Pressable`/`Touchable*`/`InputAccessoryView`/`DrawerLayoutAndroid`), the
scrollers/lists (`ScrollView`/`FlatList`/`SectionList`/`VirtualizedList`/
`VirtualizedSectionList`), the leaves (`Text`/`TextInput`/`Image`/
`ImageBackground`/`Switch`/`Button`/`ActivityIndicator`/`StatusBar`/
`RefreshControl`), the whole `Animated.*` family, plus the Victor widgets
`RNScene3D` (embedded Godot) and the ergonomic `RNButton`. Virtualized lists
render the node's retained children as their data set, so you build a list by
`add()`-ing children like any other container. The legacy `RN`-prefixed class
names (`RNView`, `RNText`, …) remain as aliases. Events surface as `press`,
`changeText`, `valueChange`, `submitEditing`, `scroll`, … — routed back through
`__godotDispatch`, the same callback path the Godot host uses, so they are
multi-VM-correct.

### Efficient patching — one widget re-renders, never the page

The tree is **retained**, and updates are **targeted**, not whole-tree
re-renders. The store (`src/core/widgetStore.ts`) keeps a **per-node revision**
and a per-node subscriber set; each op marks only the node(s) it touched dirty,
and `flush()` (once per frame) bumps just those revisions and notifies just
their subscribers. Each widget is its own `React.memo`'d `<WidgetView/>` that
subscribes (`useSyncExternalStore`) to only its node's revision, so:

- patching one prop re-renders **that one widget** — siblings, ancestors and the
  app root are untouched (their revisions never changed, and memo bails out);
- a child-list edit dirties **only the parent**, which re-renders its child
  slots while every unaffected subtree is reused as-is;
- a burst of writes in one frame coalesces into a **single** re-render per node.

The app-level `version` bumps only for root-swap / toast. `test/patching.test.ts`
asserts all of this (a leaf change bumps only its node; a structural edit bumps
only the parent; writes coalesce) directly against the store, framework-free.

## Mini-app management (the installable package)

`victor-react-native` publishes as an npm/Expo package whose headline API is a
**mini-app manager**: `<VictorMiniApps width height apps=[…]/>` hosts a set of
Elpian programs, each rendering its own React Native tree (with optional embedded
Godot 3D), reconciled by `id`. `VictorEngine.load(wasmBytes)` compiles the VM
module once; each mini app is a fresh **isolated instance** (`createRuntime()` →
`ElpianRuntime` over `WasmBackend.fromModule`).

Why one instance per mini app rather than one shared instance with a VM subtree
each: the `js2elpian` front-end keeps **process-global compile-time state**, so
two *independently-compiled* programs in the same wasm instance corrupt each
other (a later compile breaks an earlier program's `invoke`-by-name — verified).
Separate instances share the compiled `WebAssembly.Module` (cheap synchronous
`new WebAssembly.Instance`) but get their own memory and globals, which is both
correct and the strongest sandbox — a mini app literally cannot address another's
memory. (A single-instance multi-VM-subtree mode becomes possible if the
front-end's interning is made per-compilation or stable append-only.)
`test/miniapps.test.ts` boots two mini apps from one module and asserts isolation
end-to-end on the real VM.

## Gotchas (learned here)

- **String indexing is `charAt`, not `s[i]`.** In the `js2elpian` subset
  `s[0]` reads as `null`; the prelude uses `s.charAt(0)`. (This is why the event
  split in `reactnative.js` uses `charAt`.)
- **Event handlers must be `connect` ops, never props.** Only `connect`/
  `disconnect` ops get their `cb` id namespaced by the manager. `RN.*` factories
  split `on*` closures out of the prop map into `connect` ops for you; don't pass
  a closure through `set`/`props`.
- **Handles must be guest-allocated.** The `root` marker and the `Scene3D` mount
  node ride on `ref`/args so the manager namespaces them — a host-minted handle
  would not match the guest's id space.
- **`print` goes to the log buffer, not the bridge.** Read it with
  `take_log` (the runtime forwards it to `onLog`), not as an `rn.op`.

## Status & roadmap

Verified end-to-end today (`test/wasm.test.ts` runs the real VM wasm): guest
boot, widget mount, embedded 3D ops, and an event → guest logic → prop update
round-trip. Component coverage is the **entire** React Native element set by
construction (`test/components.test.ts`), and updates are **targeted** — one
widget re-renders per change, not the tree (`test/patching.test.ts`). The
declarative `h()` layer in `reactnative.js` diffs a description tree. Native
(iOS/Android/desktop) uses the documented JSI `VmBackend` + native Godot view
seams; Expo web (via `react-native-web`) runs the real wasm now, which is also
the web build target — one Expo codebase for native and web.
