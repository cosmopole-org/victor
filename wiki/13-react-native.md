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

Widget classes the renderer maps (`src/render/renderNode.tsx`): `RNView`
(+ `direction` for row/column), `RNScroll`, `RNText`, `RNButton`, `RNInput`,
`RNImage`, `RNSwitch`, `RNActivityIndicator`, `RNScene3D`. Events surface as
`press`, `changeText`, `submit`, `valueChange` — routed back through
`__godotDispatch`, the same callback path the Godot host uses, so they are
multi-VM-correct.

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
round-trip. The declarative `h()` layer in `reactnative.js` diffs a description
tree; wiring VReact (`08-vreact.md`) onto the `rn.op` backend so the full React
hook model targets React Native components is the natural next step. Native
(iOS/Android/desktop) uses the documented JSI `VmBackend` + native Godot view
seams; Expo web runs the real wasm now.
