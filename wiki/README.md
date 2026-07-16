# Victor — the complete wiki (an agent skill)

This `wiki/` is a **skill**: a set of Markdown files that together let any AI
agent (or human) understand the Victor system well enough to build any app,
game, or program on it **without mistakes**. Read the file that matches your
task; each documents one subsystem in depth, with the real API surface, working
examples, and the exact pitfalls to avoid.

> **If you read nothing else, read [`12-gotchas.md`](12-gotchas.md) first.** It
> is the concentrated list of mistakes that *look* fine but break at runtime.
> Every rule there was learned the hard way.

## What Victor is (one paragraph)

Victor runs **dynamically-delivered application code with no JIT and no
ahead-of-time native compilation**, on top of the **Elpian VM** — a pausing
AST/bytecode interpreter. Programs are written in **JavaScript** or a **Dart
subset**, compiled to Elpian bytecode, and executed inside a host. The host is a
**Godot 4 engine** (via a C++ GDExtension) whose *entire* API a guest drives
reflectively, plus optional UI layers: **VUI** (a native widget kit + canvas +
gestures on Godot Controls), a **real embedded Flutter engine** (the `FL`
bridge), and **VReact** (React on the VM). Because nothing generates machine
code, the same program is legal on iOS and runs on the web.

```
 Your program (JS or Dart)
   │  compiled by js2elpian / dart2elpian  →  Elpian AST → bytecode
   ▼
 Elpian VM  (pausing interpreter; suspends on askHost(name, payload))
   │  askHost("godot.op", …) / "flutter.op" / "vm.*" / "dart:*" / "log" …
   ▼
 Host: Godot 4 GDExtension  ── GodotController (reflective over ClassDB)
                            ├─ FlutterController + FlutterView (embedded Flutter)
                            └─ VmManager (a sandboxed tree of VMs)
```

## The files

| File | Read it when you need to… |
|---|---|
| [`01-architecture.md`](01-architecture.md) | Understand the whole system, the layers, the repo map, and the no-JIT rationale. |
| [`02-elpian-vm.md`](02-elpian-vm.md) | Know how the VM executes: `askHost`, first-class null, neutral type tags, truthiness, shape operators, exceptions, the universal stdlib, capabilities + resource limits. |
| [`03-javascript.md`](03-javascript.md) | Write guest code in JavaScript — the exact supported surface of `js2elpian` and its gotchas. |
| [`04-dart.md`](04-dart.md) | Write guest code in Dart — the exact supported subset of `dart2elpian`. |
| [`05-godot-bridge.md`](05-godot-bridge.md) | Drive the Godot engine: `GD`/`GObj`, value types + marshaling, `G3` (3D), `GTimer`, lifecycle, the op protocol, and the multi-VM sandbox (`VMs`). |
| [`06-vui.md`](06-vui.md) | Build a 2D UI natively with the Victor UI kit — widgets, theming, layout, **canvas**, **gestures**. |
| [`07-flutter-bridge.md`](07-flutter-bridge.md) | Use the real embedded Flutter engine (`FL`) — widgets, events, canvas, the builder model, the AOT host app, and how it degrades to VUI. |
| [`08-vreact.md`](08-vreact.md) | Build UIs with React (`react.js`) — hooks, host tags, mixed 2D + 3D. |
| [`09-networking.md`](09-networking.md) | Talk to the network — `net.js` (HTTP/WebSocket/Socket.IO) and `caspar.js`. |
| [`10-building-and-ci.md`](10-building-and-ci.md) | Build the extension for each target and understand the CI workflows (Android APK, web/Pages, real-Flutter). |
| [`11-recipes.md`](11-recipes.md) | Copy working patterns: a 2D app, a 3D scene, a mixed 2D/3D app, a game loop, a multi-VM app. |
| [`12-gotchas.md`](12-gotchas.md) | **The mistakes to never make.** Read this before writing code. |

## How an agent should use this skill

1. Identify the task shape: a 2D app → VUI (`06`) or VReact (`08`) or Flutter
   (`07`); a 3D game → the Godot bridge (`05`) + `G3`; custom drawing → the
   canvas sections of `06`/`07`; networking → `09`.
2. Pick the guest language: JavaScript (`03`) is the primary, best-covered
   front-end; Dart (`04`) for Flutter-style code.
3. **Read [`12-gotchas.md`](12-gotchas.md).** Most first-try failures come from
   there (int/float marshaling, `__isType` vs `.length`, the render/builder
   model, deferred signals).
4. Write the guest program as a `.js` (or `.dart`) file, attach it to an
   `ElpianVM` node in a Godot scene (`05`), and run/export it (`10`).

## Source-of-truth pointers

The wiki is written to be correct, but the **code is the ultimate authority**.
Exhaustive lists (every VUI widget, every Godot class) live in the source:

- Guest preludes: `victor/bridge/prelude/{godot.js,godot.dart,ui.js,react.js,net.js,caspar.js,flutter.js}`
- VM: `victor/elpian-vm/` · JS compiler: `victor/js2elpian/` · Dart compiler: `victor/dart2elpian/`
- Godot bridge (C++): `victor/bridge/extension/src/` · Flutter host app: `victor/bridge/flutter_host/`
- Existing demos (read these as examples): `victor/bridge/project/scripts/{tps_main.dart,ui_demo.js,react_3d_demo.js,flutter_3d_demo.js}`
- Deep docs already in-repo: `victor/README.md`, `victor/bridge/README.md`,
  `victor/bridge/FLUTTER.md`, `victor/bridge/GAME_DESIGN.md`,
  `victor/bridge/prelude/REACT.md`, `victor/bridge/prelude/CASPAR.md`.
