# Web Scene3D — the Godot HTML5 export

The **web** embedded-Godot engine: a Godot 4.3 HTML5 export of the same
`godot-project` the native module embeds
(`modules/elpian-godot/godot-project`), so `RN.Scene3D` renders real 3D on web
through the *identical* reflective `GodotController` (`ElpianScene3D`
GDExtension) that runs on device. These are build artifacts — like the native
`.so`/`.aar` — and are **not** checked in (see `.gitignore`); the
`react-native-web-pages.yml` workflow regenerates them.

## Flat layout, by basename

The export's files are served **flat next to `index.html`** and referenced by
their bare basenames:

```
web/elpian_godot.js            web/elpian_godot.pck
web/elpian_godot.wasm          web/elpian_godot.audio.worklet.js
web/elpian_godot.side.wasm     web/libelpian_godot.web.wasm32.wasm
```

This layout is not cosmetic — it is what makes the GDExtension load. Godot web
dlopens libraries by **basename** (`OS_Web` uses `get_file()` of the
`res://bin/…` path), and Emscripten registers each `gdextensionLibs` entry under
the *exact* string it is given. So `bootGodot` (in `godotWeb.ts`) passes the
bare basename `libelpian_godot.web.wasm32.wasm`: the dlopen key matches, and the
same string is a valid page-relative fetch URL. A subdir-prefixed entry
registers under the wrong key and dlopen falls back to a synchronous fetch that
browsers can't do — failing with "file not found, synchronous loading … not
available".

## What the page does

`installGodotWeb()` (called before `mountDom`, see `main.ts`) installs the
binding `WebGodotEngine` drives:

```js
globalThis.__ElpianGodotWeb = {
  op(opJson)                          { /* queue {"op":…} for the OpSink */ },
  mountSurface(surfaceId, canvas, h)  { /* queue {"mount":h} */ },
  releaseSurface(surfaceId)           {},
  stats()                             { /* queue depth */ },
};
globalThis.__elpianGodotDrain = () => /* [ …queued messages… ] as JSON */;
```

`WebGodotEngine` (`src/scene3d/webGodotEngine.ts`) posts the guest's
`godot.op`/`godot.batch` to `op()` while `mountDom` builds the DOM (incl. the
Scene3D `<canvas>`). Then `bootGodot(canvas)` starts the export into that canvas
and the embedded `OpSink.gd` drains the queue each frame over
`JavaScriptBridge` (`window.__elpianGodotDrain()`) — the exact twin of the JNI
`ElpianGodotBridge.pollOps()` the native `OpSink.gd` polls: same message shapes
(`{op:…}` / `{mount:h}`), same `GodotController`, so one guest program's 3D is
identical on web and device. Without the binding, `mountDom` leaves Scene3D
surfaces blank and the 2D app runs unchanged — the same graceful degradation as
native.

## Building the export (what CI does)

Prerequisites: Emscripten 3.1.64 (matches Godot 4.3's official web templates),
Rust 1.81.0 with `wasm32-unknown-emscripten`, SCons, the Godot 4.3 editor + Web
export templates.

```sh
# 1. Elpian VM → wasm32-unknown-emscripten static archive
CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_RUSTFLAGS="-C link-arg=-sSIDE_MODULE=2" \
  cargo +1.81.0 build -p elpian-godot-capi --release --target wasm32-unknown-emscripten

# 2. GDExtension → nothreads wasm side module (bridge/extension SConstruct)
scons platform=web threads=no target=template_release generate_bindings=yes \
  elpian_capi=../../target/wasm32-unknown-emscripten/release/libelpian_godot.a
#    → bridge/project/bin/libelpian_godot.web.wasm32.wasm  (copy into godot-project/bin/)

# 3. Export the Web preset (from modules/elpian-godot/godot-project)
godot --headless --export-release "Web" web-export/elpian_godot.html

# 4. Patch the glue for Rust's emscripten-style panic unwinding
node ../../../../bridge/patch-web-export.mjs web-export/elpian_godot.js

# 5. Stage web-export/* flat into web/ (by basename)
```

Verify end-to-end with `npm run test:web:godot` (headless Chromium via
Playwright: asserts the extension loads, the op queue drains, and the Scene3D
canvas paints non-uniform 3D pixels).
