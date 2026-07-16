# 01 — Architecture

## The core idea

Victor exists to run **application code delivered at runtime** on platforms that
forbid it the normal way:

- **iOS** forbids JIT (no writable-executable memory; App Store Guideline
  2.5.2). So you cannot ship a code interpreter that generates machine code.
- **Web** has no Dart VM, and dynamically-delivered native code is impossible.

The answer is the **Elpian VM**: a *pausing AST/bytecode interpreter* that
**never generates machine code**. It compiles a JS-subset (or a Dart-subset, or
a pre-built AST) to bytecode and walks it. No codegen → no W^X violation →
App-Store-legal, and it compiles to `wasm32` for the web.

Everything else in Victor is built so that a program running on this no-codegen
VM can nonetheless drive a full game engine and real UI toolkits.

## The layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  GUEST PROGRAM  (your app/game — JavaScript or a Dart subset)          │
│    uses preludes: godot.js/dart, ui.js (VUI), react.js (VReact),       │
│                   flutter.js (FL), net.js, caspar.js                   │
└───────────────┬──────────────────────────────────────────────────────┘
                │  compiled by
┌───────────────▼──────────────────────────────────────────────────────┐
│  FRONT-ENDS   js2elpian (JS→AST)   ·   dart2elpian (Dart→AST)          │
│    language-specific rules live here; the VM stays language-neutral.   │
└───────────────┬──────────────────────────────────────────────────────┘
                │  Elpian AST JSON → bytecode
┌───────────────▼──────────────────────────────────────────────────────┐
│  ELPIAN VM   (elpian-vm)  — pausing bytecode interpreter               │
│    suspends on askHost(apiName, payload); resumes with the reply.      │
│    first-class null · neutral type tags · shape operators · caps+limits│
└───────────────┬──────────────────────────────────────────────────────┘
                │  askHost(...)  ⇄  reply
┌───────────────▼──────────────────────────────────────────────────────┐
│  HOST  — the Godot 4 GDExtension (victor/bridge/extension)             │
│    GodotController   reflective over ClassDB → the WHOLE engine        │
│    FlutterController + FlutterView  → an embedded real Flutter engine  │
│    VmManager         → a sandboxed TREE of VMs in one scene            │
│    (Rust C-ABI: elpian-godot-capi wraps the VM tree for C++)          │
└──────────────────────────────────────────────────────────────────────┘
```

### Why the split matters (for writing correct code)

- **The VM knows no language.** JavaScript and Dart both compile to the *same*
  Elpian AST. Every language-specific rule (JS 32-bit bitwise, Dart `~/`, which
  spelling of `null`) is resolved **at compile time** in the front-end. See
  `02-elpian-vm.md`.
- **The VM knows no engine.** It only emits `askHost(name, payload)` JSON
  requests. `godot.op` / `flutter.op` / `vm.*` / `dart:*` / `log` are just
  *names*; the host decides what they do. This is why the same guest can target
  Godot, a Flutter engine, or (in principle) another host.
- **One seam, everything reachable.** The Godot bridge does not wrap ~900 engine
  classes by hand. It interprets a tiny uniform "op" protocol that addresses the
  engine **by name** through ClassDB (`instantiate`/`callv`/`get`/`set`/
  `connect`). Coverage is complete by construction. See `05-godot-bridge.md`.

## Execution model: pausing + askHost

The VM is a **coroutine**. When the guest calls `askHost(apiName, payload)`:

1. the VM **suspends** and hands `(apiName, payload)` to the embedder;
2. the embedder services it (e.g. runs a Godot op, renders a frame) and produces
   a reply;
3. the VM **resumes** with that reply as the return value of `askHost`.

Guests almost never call `askHost` directly — the preludes wrap it (`GD.create`,
`FL.mount`, `Net.get`, …). But understanding it explains the whole system:
**everything the guest does to the outside world is a host call.**

Host-call families you will meet:

| Name | Serviced by | Purpose |
|---|---|---|
| `log` | host | `print(x)` output |
| `godot.op` / `godot.batch` | C++ `GodotController` | drive the Godot engine |
| `flutter.op` / `flutter.batch` | C++ `FlutterController` | drive the embedded Flutter engine |
| `vm.*` | Rust `VmManager` | spawn/manage child VMs |
| `dart:async/*` | prelude/runtime | timers, microtasks |
| `dart:ui/*`, `dart:typed_data/*` | `dart` crate | Flutter foundational libraries (on-VM path) |

## Repo map (what lives where)

```
victor/
  elpian-vm/         the VM (executor only). Rust. Builds native + wasm32.
  js2elpian/         JavaScript → Elpian AST compiler. Rust.
  dart2elpian/       Dart subset → Elpian AST compiler. Rust.
  dart/              optional dart:* "group 3" host libraries (dart:ui recorder,
                     typed_data, …). Gated behind the `dart` cargo feature.
  godot/
    capi/            elpian-godot-capi — Rust C-ABI wrapping the VM tree +
                     the multi-VM VmManager (manager.rs). Tests live here.
    extension/       the C++ GDExtension:
      src/godot_controller.*   reflective op interpreter over ClassDB
      src/elpian_vm_node.*     the ElpianVM scene node (drives the VM per frame)
      src/flutter_*            the embedded-Flutter bridge (ELPIAN_WITH_FLUTTER)
      CMakeLists.txt / SConstruct   build files
    prelude/         the guest libraries composed ahead of a program:
      godot.js / godot.dart    GD/GObj/G3/GTimer/VMs + marshaling
      ui.js                    VUI widget kit + canvas + gestures
      react.js                 VReact (React on the VM)
      flutter.js               FL (drive the embedded Flutter engine)
      net.js / caspar.js       networking
    flutter_host/    the fixed AOT Flutter "interpreter app" the engine embeds
    project/         a ready Godot 4.3+ project with demo scenes + scripts
  web-demo/          the web/CanvasKit reflective bridge + demo
.github/workflows/   android-apk.yml, web-demo-pages.yml, android-apk-flutter.yml
wiki/                you are here
```

## The two UI stories (choose deliberately)

Victor has two ways to render UI, and they are NOT the same:

1. **Native (VUI / VReact / raw Godot Controls).** Renders directly on Godot
   `Control` nodes. **Works on every target** (desktop, Android, web) with no
   extra binaries. This is what the shipped Android/web artifacts use. See
   `06-vui.md`, `08-vreact.md`.
2. **Real embedded Flutter (`FL`).** Runs an actual `libflutter` engine inside
   the GDExtension. Only present in a build made with `ELPIAN_WITH_FLUTTER` +
   the engine artifact; **never on the web** (libflutter can't embed in a wasm
   export), and **hard on Android** (needs a from-source engine build). The `FL`
   API degrades to VUI when the engine is absent. See `07-flutter-bridge.md`.

**Rule of thumb:** for something you want to ship on Android/web today, use VUI
or VReact. Use `FL` only if you specifically need the real Flutter framework and
you control the build. The canvas + event surfaces are available on both.

## Where to go next

- New to guest coding → `02-elpian-vm.md`, then `03-javascript.md`.
- Building a game/3D scene → `05-godot-bridge.md`.
- Building a 2D app UI → `06-vui.md` (native) or `08-vreact.md` (React).
- Deploying → `10-building-and-ci.md`.
- **Always** → `12-gotchas.md`.
