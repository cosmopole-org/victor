# Web Scene3D — the Godot HTML5 export

This directory holds the **web** embedded-Godot engine: a Godot 4 HTML5 export of
the same `godot-project` the native module embeds (`modules/elpian-godot/godot-project`),
so `RN.Scene3D` renders real 3D on web with the *identical* reflective
`GodotController` (`ElpianScene3D` GDExtension) that runs on device. It is a build
artifact — like the native `.so`/`.aar` — and is **not** checked in.

## What the page loads

A web build that wants 3D loads `web/godot/elpian_godot.js` (the export's JS glue).
On boot it must install the binding the JS side drives:

```js
globalThis.__ElpianGodotWeb = {
  op(opJson)                          { /* push into the OpSink queue */ },
  mountSurface(surfaceId, canvas, h)  { /* bind a SubViewport → canvas, seed node h */ },
  releaseSurface(surfaceId)           { /* drop the surface's viewport */ },
};
```

`WebGodotEngine` (`src/scene3d/webGodotEngine.ts`) posts `godot.op`/`godot.batch`
to `op()` and binds each `Scene3D` widget's `<canvas>` (created by
`DomWidgetRenderer`) through `mountSurface()`. Without this binding present,
`mountDom` leaves Scene3D surfaces as blank canvases and the 2D app runs
unchanged — the same graceful degradation as native.

The engine drains `op()` exactly like the JNI `ElpianGodotBridge.pollOps()` the
native `OpSink.gd` polls: same message shapes (`{op:…}` / `{mount:h}`), same
`GodotController`, so one guest program's 3D is pixel-identical on web and device.

## Building the export

Prerequisites: Godot 4.3 + the **Web export templates**, and the
`elpian_godot` GDExtension built for `wasm32` (Emscripten) into
`godot-project/bin/` (the web counterpart of the Android `.so`).

```sh
# from modules/elpian-godot/godot-project
godot --headless --export-release "Web" \
  ../../../web/godot/elpian_godot.html
```

The `Web` preset (add it to `export_presets.cfg`) emits `elpian_godot.js`,
`.wasm`, `.pck` and the html shell here. The thin JS shim that installs
`__ElpianGodotWeb` around the export's `Engine` wraps `op/mountSurface/releaseSurface`
onto the `ElpianGodotBridge`-equivalent the export exposes to JS.
