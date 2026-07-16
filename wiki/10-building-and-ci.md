# 10 — Building, running, and CI

## The `ElpianVM` scene node (how a program runs)

A guest program runs by attaching it to an **`ElpianVM`** node in a Godot scene.
The node owns the VM, pumps it each frame, forwards lifecycle events, and flushes
signal callbacks.

A minimal scene (`.tscn`):

```
[gd_scene format=3 uid="uid://myapp1"]
[node name="World" type="Node3D"]                 ; or Node2D / Control for pure 2D
[node name="ElpianVM" type="ElpianVM" parent="."]
script_path = "res://scripts/myapp.js"            ; your program
language = "js"                                    ; js | dart | auto (by extension)
autostart = true
prepend_prelude = true                             ; compose the godot prelude ahead
```

`ElpianVM` node properties: `script_path` (res:// path) OR `guest_source`
(inline), `language`, `autostart`, `prepend_prelude`, `max_host_calls`,
`max_bytes_moved`. It emits `guest_log` and `vm_error` signals and is scriptable
from GDScript (`exec_op_json`, `invoke_guest`, `audit_json`).

Put your `.js`/`.dart` under `victor/bridge/project/scripts/` and point a scene at
it. Set the scene as the project's main scene (`project.godot`
`run/main_scene`), or select it per export.

## Building the GDExtension

The extension is C++ (`victor/bridge/extension/`) linking the Rust VM
(`elpian-godot-capi`, a staticlib). Two equivalent build systems:

**SCons (Godot-conventional):**
```sh
git clone -b godot-4.3-stable https://github.com/godotengine/godot-cpp \
    victor/bridge/extension/godot-cpp
cd victor && cargo build -p elpian-godot-capi --release      # the Rust staticlib
cd victor/bridge/extension && scons                                  # native host build
```

**CMake:**
```sh
cmake -B build -DGODOT_CPP_PATH=/path/to/godot-cpp -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
```

Output lands in `victor/bridge/project/bin/` with the name the bundled
`elpian_godot.gdextension` expects (`libelpian_godot.<platform>.<arch>.<ext>`).
`godot-cpp` must be a checkout (branch `godot-4.3-stable` or newer).

### Targets

- **Native (linux/macos/windows):** `scons` / CMake as above.
- **Android arm64:** cross-build the Rust staticlib for `aarch64-linux-android`
  (NDK clang linker) then `scons platform=android target=template_release
  arch=arm64 elpian_capi=...`. GDExtension on Android requires the gradle export.
- **Web (wasm):** cross-build the Rust staticlib for
  `wasm32-unknown-emscripten` (pin Rust 1.81.0 to match emsdk 3.1.64), then
  `scons platform=web threads=no target=template_release generate_bindings=yes`.
  The exported JS glue is patched by `victor/bridge/patch-web-export.mjs` (Rust
  side-module `invoke_*` thunks). No threads → no SharedArrayBuffer requirement,
  so plain static hosting works.

### Optional: embed the real Flutter engine

Off by default (`flutter_view.cpp` compiles as an inert placeholder). Enable:

- SCons: `scons with_flutter=yes flutter_engine_dir=/path/to/engine`
- CMake: `-DELPIAN_WITH_FLUTTER=ON -DFLUTTER_ENGINE_DIR=/path/to/engine`

`FLUTTER_ENGINE_DIR` must hold `flutter_embedder.h` + the engine library. Also
stage the AOT snapshot of `flutter_host` at
`res://flutter/{app.so,flutter_assets,icudtl.dat}` (override paths via
ProjectSettings `elpian/flutter/{aot_library_path,assets_path,icu_data_path}`).
**Not available on web.** On Android the engine must be built from source. Full
recipe: `victor/bridge/FLUTTER.md`, and see `12-gotchas.md`.

## Running / verifying without the editor

The Rust test suite drives guests exactly as the node does (a mock host for the
`godot.op`/`flutter.op` seam). This is how you verify a program headlessly:

```sh
cd victor && cargo test -p elpian-godot-capi
```

Existing tests you can copy as harnesses: `bridge/capi/tests/run_ui_demo.rs`,
`run_flutter_demo.rs`, `run_flutter_3d_demo.rs`, `run_react_demo.rs`,
`run_tps.rs`. They compile the shipped script, run `run_root()`, then drive
`__godotEvent`/`__godotDispatch`/`pump` and assert on the ops the mock saw. When
you add a demo, add a test like these — it catches compile + runtime errors
without a GPU. (Note: `run_tritonland.rs` depends on an external file and fails
outside its environment — that failure is not yours.)

## CI workflows (`.github/workflows/`)

| Workflow | Trigger | What it ships |
|---|---|---|
| `android-apk.yml` | push to main/master, or manual | Builds the extension (arm64), exports the demo scene as an APK, commits it to the repo root. Rewrites `run/main_scene` to `res://flutter_3d_demo.tscn` (portrait 720×1280). VUI path (no Flutter engine). |
| `web-demo-pages.yml` | push, or manual | Builds the wasm extension, exports the demo to GitHub Pages. VUI path (web can't embed Flutter). |
| `android-apk-flutter.yml` | **manual only** | EXPERIMENTAL. Builds the android-arm64 Flutter engine from source (or takes a prebuilt `engine_url`), AOT-snapshots `flutter_host`, links with `ELPIAN_WITH_FLUTTER`, bundles the engine .so, exports a real-Flutter APK. Heavy/fragile; may exceed the runner. |

To ship a **different** scene, change the `sed` step that rewrites
`run/main_scene` in `android-apk.yml` / `web-demo-pages.yml` (e.g.
`res://ui_demo.tscn`, `res://react_3d_demo.tscn`, or your own).

## Practical build gotchas

- **godot-cpp version must match** the Godot editor/templates you export with
  (4.3-stable here). Mismatch → import/export crashes.
- **Web:** use the pinned Rust (1.81.0) + emsdk (3.1.64) pairing; and
  `generate_bindings=yes` on both the wasm and host scons calls (arch-size
  mismatch otherwise corrupts Variant layouts).
- **The host (linux) extension must also be built** before an Android/web export,
  because the headless editor loads the `.gdextension` during import.
- After changing a prelude or a guest script, no rebuild of the extension is
  needed — the program is recompiled by the VM at load. Only C++/Rust changes
  need a rebuild.
