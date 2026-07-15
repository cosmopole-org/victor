# The Flutter UI bridge — a real Flutter engine as Victor's 2D UI, driven by Elpian

This document describes how a **real, embedded Flutter engine** is woven into the
Godot-based Victor engine as the 2D UI layer, and how it is made **fully
controllable from the Elpian VM system** — the same paradigm by which Elpian
already drives Godot.

It is the twin of the reflective Godot bridge (`extension/src/godot_controller.*`,
`prelude/godot.js`): one seam, everything reachable — but where Godot is driven
*reflectively* through ClassDB, Flutter is driven through a small *declarative
widget protocol*, because Flutter has no runtime reflection surface to address by
name (see "Why a registry and not reflection").

```text
 Elpian VM guest (dynamic, no JIT)            GDExtension (native)              Flutter (AOT)
 ─────────────────────────────────           ────────────────────             ─────────────
 import 'flutter.js';
 FL.mount(node, App) ──flutter.op──▶  FlutterController.op_newview
                                       ├─ resolve `node` via GodotController (sandbox-checked)
                                       ├─ add a FlutterView (TextureRect) under it
                                       └─ FlutterView.start_engine ─▶ FlutterEngineRun
 App() -> {t,p,c} tree ──render op──▶  FlutterController.op_render
                                       └─ FlutterView.send_widget_tree
                                          └─ platform msg "elpian/widgets" ─▶ interpreter app
                                                                              rebuilds real widgets
 a widget fires (onTap) ◀──────────────  platform msg "elpian/events" {cb,args}
   __godotDispatch([cb,args])  ◀───────  GodotController callback queue ◀── FlutterView event sink
   → the owning VM's closure runs
       software frame ◀────────────────  FlutterView.present (raster thread)
                                          └─ staging buffer → ImageTexture (main thread)
```

The pieces, and where they live:

| Layer | File | Status in this repo |
|---|---|---|
| Guest facade `FL` (widget builders, event routing, coalesced render loop) | `prelude/flutter.js` | **Implemented + tested** |
| Seam routing + sandbox stamping for `flutter.op`/`flutter.batch` | `capi/src/manager.rs` | **Implemented + tested** |
| Prelude composition (`import 'flutter.js'`) | `capi/src/lib.rs` | **Implemented + tested** |
| Protocol e2e (mount → render → widget-event round trip) | `capi/tests/run_flutter_demo.rs` | **Passing** |
| C++ `FlutterController` (op interpreter, view table, event bridge) | `extension/src/flutter_controller.*` | **Implemented** (builds; drives engine when enabled) |
| C++ `FlutterView` node (embedder API, software compositor, input, metrics) | `extension/src/flutter_view.*` | **Implemented** behind `ELPIAN_WITH_FLUTTER` |
| Node/registration/build wiring | `extension/src/{elpian_vm_node,register_types}.*`, `CMakeLists.txt`, `SConstruct` | **Implemented** |
| Full event surface (gestures/pointer/keyboard/focus/drag/scroll/value) | `prelude/flutter.js` + `flutter_host/lib/main.dart` | **Implemented + swept by test** |
| Event-surface sweep (21 event types × all positions) | `capi/tests/run_flutter_demo.rs` | **Passing** |
| Embedded AOT interpreter app (large hand-written widget/value catalog) | `flutter_host/lib/main.dart` | **Implemented** (needs Flutter SDK to snapshot) |
| Full-coverage registry generator (from Flutter's API) + committed stub | `flutter_host/tool/gen_registry.dart`, `flutter_host/lib/registry.g.dart` | **Implemented** (needs Flutter SDK + analyzer to run) |

> **What is proven here vs. what needs the engine.** The guest→seam→dispatch
> contract is implemented and covered by a passing Rust test that drives a full
> widget-event round trip through a mock host. The native half is written against
> the stable Flutter Embedder API and compiles as an **inert placeholder** by
> default (so the extension builds with no libflutter); turning on
> `ELPIAN_WITH_FLUTTER` and supplying the engine artifact + the AOT snapshot of
> `flutter_host/` lights up the real engine. Those artifacts are per-platform and
> are **not** vendored in this repo.

## Why a registry and not reflection

The Godot bridge is *complete by construction*: every class/method/property is
registered in ClassDB and callable by name, and `{"audit": true}` machine-checks
coverage. Flutter has no equivalent — its widget framework is AOT Dart, tree-
shaken, with `dart:mirrors` unavailable in AOT, and the embedder C API exposes
only engine-level operations (frames, input, platform messages), never widgets.
So "a reflective FlutterController over everything" is impossible *in principle*.

The achievable, App-Store-legal model — the one Google's own `package:rfw` uses —
is a **widget/property registry** inside a fixed AOT interpreter app: the guest
sends declarative widget data, the app materializes real widgets. The guest never
ships code — only data — so no JIT, exactly like the rest of Victor.

### How "no exception" coverage is achieved

Coverage is delivered on three fronts so there is no widget, handler, or event
type the system cannot express:

1. **Guest side — complete by construction, and tested.** `FL.el(type, props,
   children)` builds *any* widget by name, and `__flReifyValue` in `flutter.js`
   converts a handler (or a nested widget) to a wire tag in **every** position —
   a prop, an element of a prop array (`children`/`actions`/`slivers`/…), or a
   value nested in a value map. So any widget type and any handler is expressible
   from the guest with zero per-widget code. `capi/tests/run_flutter_demo.rs`
   proves this with an event-surface sweep that fires 21 event types across all
   those positions and checks each reaches its distinct guest closure.

2. **Event side — the whole bounded surface is enumerated.** `flutter.js` and
   `flutter_host/lib/main.dart` cover every GestureDetector callback (tap /
   double-tap / long-press / vertical+horizontal drag / pan / scale / force-press
   / secondary / tertiary), Listener pointer events, MouseRegion hover,
   Focus/KeyboardListener key events, drag & drop (Draggable/DragTarget),
   Dismissible, scroll notifications, and every widget-specific value callback —
   each serialized to a JSON details object the guest handler receives.

3. **Host widget side — a large hand-written catalog + a build-time generator.**
   `flutter_host/lib/main.dart` hand-writes the common Material/Cupertino/layout/
   scroll/input catalog (the widgets needing bespoke event or slot wiring), and
   `flutter_host/tool/gen_registry.dart` closes the long tail: it walks Flutter's
   *own* public API with the analyzer and generates `lib/registry.g.dart`, a
   builder for **every** public widget (mapping each constructor parameter from
   the props through the `_P` decoders) plus a decoder for every enum. This is
   the Flutter analogue of the Godot bridge's generated `@GlobalScope` table
   (`tools/gen_global_constants.py`, "never written by hand") — the difference
   being that Flutter has no runtime reflection, so it is generated at **build
   time** rather than resolved at runtime. Any widget not in the hand-written
   switch falls through to the generated registry, so no public widget is out of
   reach. A committed stub (`registry.g.dart`) keeps the app compiling before the
   generator has run; running it (with a Flutter SDK) makes coverage complete and
   keeps it current with the SDK.

The remaining honest caveat is the one Flutter itself imposes: coverage is
**enumerated by generation**, not reflective — a brand-new widget added to the
Flutter SDK is reachable after the generator is re-run against that SDK, not the
instant it ships. That is inherent to a no-reflection AOT framework; within it,
this is as close to complete-by-construction as the platform allows.

## Control from Elpian — identical model to Godot

Everything that makes the Godot bridge "fully controlled from Elpian" is reused:

- **One seam.** `flutter.op` / `flutter.batch` cross the same `askHost` boundary
  as `godot.op`, and are sanitized by the *same* `sanitize_op` in the Rust
  `VmManager`: callables and handles are namespaced into the calling VM's id
  space, and each op is stamped with the VM's sandbox root (`__sbx`).
- **Same sandbox.** A Flutter surface mounts under a Godot node, and that node is
  resolved through `GodotController::resolve_handle_checked` under the op's
  sandbox — so a sandboxed VM can only mount a UI inside its own subtree, exactly
  as for native nodes. The multi-VM tree, budgets, and permissions apply
  unchanged.
- **Same dispatch.** Widget events are routed into the *same* callback queue
  bridged Godot signals use, so the `ElpianVM` node's existing per-frame flush
  delivers them via `__godotDispatch` to the owning VM — even deep in a spawned
  subtree.
- **Dart *or* JS guests.** `flutter.js` is the JS facade; a `flutter.dart` twin
  can be added the same way `godot.dart` mirrors `godot.js`.

### The render loop (and a front-end note)

`FL.mount(parent, builder, opts)` takes a *builder* (a function returning the
current widget tree). The framework calls it for the first paint and again after
every widget event, so a handler just **mutates the state the builder reads and
returns** — the React/Flutter `setState` model. Re-renders are **coalesced onto
the VM event loop** (`__later`), so many state changes in a turn collapse to one
reify + one `flutter.op` crossing.

This split is also load-bearing for a subtle front-end reason: a handler that
*synchronously rebuilt* the widget/closure tree from inside its own dispatched
callback tripped a closure-capture edge case in the JS front-end on the resumed
turn. Driving the re-render from framework-owned top-level code (never lexically
inside a dispatch-time closure) sidesteps it — the same reason VReact defers
renders to a microtask. `run_flutter_demo.rs` pins the multi-event round trip so
this stays fixed. *(The underlying front-end capture case is worth fixing in
`js2elpian` independently; the framework structure here does not depend on it.)*

## Compositing: software now, GPU zero-copy later

### Phase 1 — software compositor (implemented)

The engine runs its **software renderer**; its present callback (on the raster
thread) hands us a CPU pixel buffer, which `FlutterView` stages under a mutex and
uploads into an `ImageTexture` on the main thread in `_process`. The
`TextureRect` displays it. This works on **every** Godot renderer (Forward+,
Mobile, Compatibility) and every platform, at the cost of one CPU copy + one
texture upload per frame — fine at UI resolutions and the right first target.

Threading: a custom **platform task runner** posts the engine's platform tasks
onto Godot's main thread (drained in `_process`), so the platform-message
callback that touches the scene is always main-thread; only the pixel present
runs on the raster thread, and it only writes a staging buffer.

### Phase 2 — GPU zero-copy (planned, per-platform)

The copy is avoidable by letting Flutter render into a texture Godot already
owns. Concrete paths:

- **Vulkan (Forward+/Mobile).** Use the embedder's `kOpenGL`→`kVulkan` renderer
  config (`FlutterVulkanRendererConfig`) so Flutter renders into a
  `VkImage`; wrap that image on the Godot side with
  `RenderingDevice.texture_create_from_extension` (Godot 4.2+) and bind it to the
  `TextureRect`/material. No CPU round trip; a fence/semaphore synchronizes the
  engine's raster submit with Godot's frame. This is the primary target.
- **OpenGL (Compatibility).** Share the GL context (or use a shared FBO/texture)
  between the engine's `kOpenGL` renderer and Godot's GL backend; Flutter renders
  into a texture id Godot imports. Simpler API, but tied to the Compatibility
  renderer.
- **Metal (macOS/iOS) / D3D.** Analogous external-image import via the
  platform-specific embedder renderer configs; more engineering per backend.

The op protocol already carries a `gpu: true` hint in `opts`, and `FlutterView`
isolates all rasterizer specifics behind `present`/`ensure_texture`, so Phase 2 is
an internal swap of the renderer config + texture-wrapping path — **no guest, no
protocol, and no `FlutterController` change**. Recommended order: ship software,
then Vulkan zero-copy, then the remaining backends as needed.

## Building with a real engine

1. **Get the engine artifact** for your target: the embedder header
   `flutter_embedder.h` and the engine library (`libflutter_engine.so` /
   `.dylib` / `flutter_engine.dll`) from a matching Flutter engine build.
2. **Build the extension with Flutter on:**
   - CMake: `-DELPIAN_WITH_FLUTTER=ON -DFLUTTER_ENGINE_DIR=/path/to/engine`
   - SCons: `scons with_flutter=yes flutter_engine_dir=/path/to/engine`
   Without these, `flutter_view.cpp` compiles as an inert placeholder and the
   rest of the extension is unchanged.
3. **Snapshot the interpreter app** in `flutter_host/` (see its README) and stage
   the runtime artifacts:
   ```
   res://flutter/app.so
   res://flutter/flutter_assets/
   res://flutter/icudtl.dat
   ```
   Override the locations with ProjectSettings
   `elpian/flutter/{aot_library_path,assets_path,icu_data_path}`.

## Costs, risks, and limits (stated plainly)

- **Binary size / CI.** ~10–15 MB of engine + AOT snapshot per platform, and a
  Dart AOT build step in CI. This is the largest practical burden.
- **Two GPU pipelines** in one process on mobile once Phase 2 lands; the software
  path avoids interop entirely at the cost of copies.
- **Coverage is enumerated,** not reflective (see above). New widgets are a
  one-file change in `flutter_host/lib/main.dart`.
- **IME / text input, focus arbitration, DPI.** Text input and focus hand-off
  between the Flutter surface and the Godot scene need the usual embedder
  plumbing (key events + `TextInput` channel + opaque-region/hit-test reporting);
  the software path and pointer/metrics forwarding are implemented, text-input
  channels are the next increment.
- **Software present byte order.** Some engine builds present BGRA; the copy in
  `FlutterView::present` is a straight RGBA copy with a documented swap point.
- **Web target.** `libflutter` does not embed in a wasm Godot export. The web
  analogue routes through Flutter's **CanvasKit** engine instead — and this repo
  already ships a CanvasKit reflective bridge (`web-demo/canvaskit_bridge.js`),
  so a web story exists but is a separate implementation from this native path.

## An alternative already half-present in the repo

If the Flutter *programming model* (not the real engine) is the goal, the repo
already contains `dart/flutter/flutter.dart` (a Flutter-style widget library that
runs *on Elpian*) lowering to `dart:ui` display lists that `dart/src/dart_ui.rs`
records and `scene_diff.rs` diffs. A Godot-side rasterizer replaying those
display lists through `RenderingServer` canvas commands would give a
Flutter-shaped 2D UI with **full Elpian control by construction**, no Flutter
binary and no second GPU pipeline — at the cost of fidelity (it is Flutter-shaped,
not real Flutter). This document covers the *real-engine* path; that remains the
lighter-weight option if fidelity to the real framework is not required.
