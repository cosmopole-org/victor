# Elpian ↔ Godot — a tree of Dart VMs (no JIT) driving the full Godot engine

This directory wires the **Elpian VM** (with the `dart` feature: the
Dart→Elpian front-end + the Dart runtime layer from `elpian/dart/`) into a
**Godot 4 project**, and implements a **C++ controller for the whole engine**
that the VM drives over its `askHost` seam. A Dart program running on Elpian
can create/control/manage every layer of Godot — scene tree, all node classes,
rendering, physics, navigation, audio, input, GUI, resources, tweens, signals,
servers (RID APIs), reflection — with the same no-JIT/App-Store-legal execution
model as the rest of this repo.

One `ElpianVM` node now hosts a **multi-VM system**: a Rust `VmManager` owns a
*tree* of VM instances sharing the same Godot scene. The root VM manages the
whole scene and the inter-VM space; any VM can instantiate further VMs
(`VMs.spawn(...)`) and holds complete, hierarchical control over them —
lifecycle, resource limits, permissions, messaging — while each spawned VM is
**sandboxed to an assigned node subtree**. See "The multi-VM tree" below.

```text
 Dart program (guest)                       C++ GDExtension (native)
 ────────────────────                       ─────────────────────────
 import 'godot.dart';        JSON ops        GodotController
 GD.create('RigidBody2D') ──askHost──▶  ── ClassDB::instantiate  (by name)
 node.call('add_child',[c])             ── Object::callv         (any method)
 node.set('position', v)                ── Object::set/get       (any property)
 btn.connect('pressed', fn)             ── Object::connect → ElpianCallable
 GD.singleton('RenderingServer')        ── Engine::get_singleton (any server)
 GD.constant('KEY_ESCAPE')              ── generated @GlobalScope table
 GD.eval('clamp(x,0,1)',…)              ── Expression             (any utility fn)
 GD.classes()/classInfo()/audit()       ── ClassDB introspection
 VMs.spawn(src, node, opts) ─askHost─▶  (vm.* stays in Rust: the VmManager)
        ◀───────────── JSON reply / queued signal dispatch ─────────────
```

## Why a *reflective* controller (the "no exceptions" strategy)

Godot exposes ~900 classes / ~12,000 methods, and every one of them — every
node, every server, every resource type — is registered in **ClassDB** and
addressable by name through `instantiate` / `callv` / `get` / `set` /
`connect`. So instead of generating or hand-writing thousands of wrappers
(which would always lag the engine), the controller is an **interpreter of a
small, uniform op protocol** that addresses the engine by name — exactly the
paradigm this repo already proved against Skia in
`web-demo/canvaskit_bridge.js` (575 symbols audited, 0 unreachable). Coverage
is *complete by construction*, including classes added in future Godot
versions, and the `{"audit": true}` op walks all of ClassDB at runtime to
machine-check it (class/method/property/signal/constant counts + any
unreachable entries; singletons verified against `Engine.get_singleton_list`).

The only name tables in the bridge are **generated from the engine's own API
dump** (`tools/gen_global_constants.py` → the `@GlobalScope` constant table,
built from godot-cpp's `extension_api.json` at build time) — never written by
hand.

## Layout

| Path | What it is |
|---|---|
| `capi/` | `elpian-godot-capi` — Rust crate exposing the VM as a **C ABI** (`elpian_godot_new/new_lang/run/invoke/pump/…`) with a host-callback seam for `godot.*` calls. Workspace member; `cargo test` runs the protocol e2e suite. |
| `prelude/godot.dart` | The Dart guest library (`GD`, `GObj`, value types, `GTimer`, marshaling). Embedded into the Rust crate via `include_str!` and composed ahead of the user program. |
| `prelude/godot.js` | The **JavaScript** guest library — the JS twin of `godot.dart`: same wire protocol, same `GD`/`GObj`/`VMs`/`GTimer` surface, compiled by `js2elpian`. Composed ahead of a JS guest program. |
| `prelude/ui.js` | **VUI — the Victor UI kit**: a full widget toolkit in pure JavaScript built on Godot `Control` nodes over the bridge (see "JavaScript guests & the Victor UI kit" below). Composed ahead of a JS guest that has an `import 'ui.js';` line. |
| `extension/` | The C++ GDExtension: `GodotController` (reflective op interpreter + Variant↔JSON marshaling + handle table), `ElpianCallable` (Dart-closure-backed `Callable`), `ElpianVM` (the scene node), build files (CMake + SCons). |
| `project/` | A ready Godot 4.3+ project with three scenes. **`ui_demo.tscn` is the Victor UI showcase — a complete phone-style app written 100% in JavaScript** (`scripts/ui_demo.js`): a full-screen 2D page (CanvasLayer) embedded in a 3D scene (the root is a Node3D world that keeps existing, unshown, underneath), locked to portrait, content-scaled from a 720×1280 design space, with a dashboard, a widget gallery and a System page where the VM introspects itself and spawns a sandboxed JavaScript child VM. **`tps.tscn` (the main scene) is VICTOR: CITY STRIKE — a complete third-person shooter written entirely in Dart on the VM** (`scripts/tps_main.dart`): a procedurally assembled city built from CC0 GLB kits (`project/assets/tps/`), an animated player character with an over-the-shoulder SpringArm camera, two hitscan weapons with pooled tracers/impacts/damage numbers, three enemy archetypes with a chase/attack/line-of-sight AI, waves, pickups, a full HUD + menus, touch controls, and fully synthesized embedded audio — see [`GAME_DESIGN.md`](GAME_DESIGN.md). `main.tscn` remains the **multi-VM showcase**: the root VM builds the environment/camera/dashboard, then spawns a tree of sandboxed child VMs into the same scene (a spinning-ring VM that spawns its own grandchild, a physics VM that also probes the sandbox and reports the denials, and a rogue VM whose deliberate hang is trapped by its budget), with live per-VM metering and pause/resume/terminate controls. |

## The op protocol (one seam, everything reachable)

Two host-call names cross the VM seam:

* `godot.op` — one op (a small tagged JSON object) → one result.
* `godot.batch` — an **array of ops → array of results in ONE crossing** (the
  high-performance path; `GD.beginBatch()`/`GD.endBatch()` in Dart).

Ops: `new`, `singleton`, `tree`, `self`, `load`, `method`, `get`/`set`,
`geti`/`seti` (indexed property paths), `connect`/`disconnect`, `free`
(handle/queue/now), `const`, `expr` (Godot `Expression` — reaches every
`@GlobalScope` utility function), `static` (ClassDB.class_call_static on
4.4+ engines, resolved at runtime), `classes`, `classinfo`, `audit`, plus
the multi-VM support ops `chk` (sandbox containment probe) and `grant`
(share a handle with another VM's sandbox). Ops forwarded from sandboxed
VMs carry a manager-stamped `__sbx` key the controller enforces.

A third host-call family, `vm.*` (spawn / pause / resume / terminate / state /
usage / usageTree / limits / setLimits / setPermission / permissions / list /
send / grant / info), never reaches C++: the Rust `VmManager` services it.

Marshaling covers **every Variant shape** in both directions: `vec2/2i/3/3i/
4/4i`, `color`, `rect2/2i`, `plane`, `quat`, `aabb`, `basis`, `xform2d`,
`xform3d`, `proj`, `sname`, `npath`, `rid`, `callable`, `sig`, dictionaries
(string-keyed `dict` / arbitrary-keyed `dictv`), arrays, and all ten packed
arrays (`u8` as base64, `i32/i64/f32/f64/strs/pv2/pv3/pv4/pcol`).

Objects never cross the seam — 64-bit **handles** do (guest-chosen ids
positive, host-assigned negative; RefCounted objects are kept alive by the
handle table, plain Objects are liveness-checked through ObjectID on every
resolve). Op failures resume the guest as `{"__dart_error__": …}`, which the
front-end lowers back into a Dart `throw`.

## JavaScript guests & the Victor UI kit (ui.js)

The bridge is **language-front-end agnostic**: a guest program can be Dart
(compiled by `dart2elpian`) or **JavaScript** (compiled by `js2elpian`) — both
lower to the same Elpian AST/bytecode and speak the identical op protocol.
`prelude/godot.js` is the JS twin of `godot.dart`: the same `GD`/`GObj`
reflective surface, the same value-type vocabulary, `GTimer` on the VM event
loop and the `VMs` multi-VM facade. Set the `ElpianVM` node's `language`
property (`auto`/`dart`/`js` — `auto` goes by the script extension), or call
`elpian_godot_new_lang(source, "js", …)` from an embedder. Spawned children
inherit their parent's language (`VMs.spawn(src, node, {lang: 'js'})`
overrides), so Dart and JS VMs can share one scene, one sandbox model, one
budget hierarchy.

On top of the JS prelude sits **VUI, the Victor UI kit** (`prelude/ui.js`) — a
complete widget toolkit written in pure JavaScript, pulled in by an
`import 'ui.js';` line. Every widget is a *retained* Godot `Control` created
reflectively over the bridge (no wrappers, no image assets — even the slider
grabber is a code-generated radial-gradient texture), styled from a themable
token set (`VUI.themeDark()` / `themeLight()`), and animated with real engine
Tweens:

* **layout** — `column`, `row`, `grid`, `scroll`, `margin`, `center`,
  `panel`, `spacer`, `divider`, `expand`;
* **content** — `text`/`heading`/`title`/`caption`, `icon`, `badge`, `chip`,
  `avatar`, `card`, `stat`, `listTile`;
* **controls** — `button` (filled/tonal/outline/ghost/danger), `iconButton`,
  `field`, `toggle` (hand-built animated switch), `checkbox`, `slider`,
  `progress`;
* **structure** — `appBar`, `tabs`, `bottomNav`, `dialog`, `sheet`, `toast`;
* **root** — `VUI.app({design: [720, 1280], portrait: true})` creates a
  CanvasLayer + full-rect page **inside any scene, 2D or 3D** (a CanvasLayer
  composites over the viewport, so the UI covers the screen while a Node3D
  world keeps existing underneath), content-scales the design space to the
  real screen, and locks portrait — `DisplayServer.screen_set_orientation` on
  handheld devices, a portrait-sized window on desktop.

`ui_demo.tscn` + `scripts/ui_demo.js` is the shipped showcase (see Layout),
and `capi/tests/run_ui_demo.rs` plays it end to end on a real VM.

## The multi-VM tree (VmManager)

The layers divide cleanly: the **VM↔Godot binding stays the existing bridge**
(one `GodotController`, one op protocol), while everything multi-VM lives in
Rust (`capi/src/manager.rs`) behind new `vm.*` host APIs the guest reaches
through the `VMs`/`VmController` prelude facade:

```text
root VM (scene manager: whole scene + inter-VM space, unrestricted)
├─ child VM     ← sandboxed to a node its parent assigned
│  └─ grandchild VM  ← sandboxed to a node inside ITS parent's node, …
└─ child VM
```

* **Spawning** — `VMs.spawn(source, node, {label, limits, permissions,
  maxHostCalls, maxBytesMoved, scene})` compiles a new Dart program into a
  fresh VM, verifies `node` lies inside the caller's own sandbox (the `chk`
  probe against the real tree), adopts it into the hierarchy and boots it in
  the same frame. Gated by the `vm_manage` capability.
* **Lifecycle binding** — `pause()` / `resume()` / `terminate()` act on the
  target **and its whole descendant subtree**; terminating a parent kills all
  children, their children, and so on. A paused branch receives no events,
  timers or messages; a mid-turn pause parks the continuation intact.
* **Aggregate resource accounting** — a VM's usage is measured as its own plus
  its whole subtree's (`usageTree()`), and its `limits` budget is enforced
  against that aggregate (`elpian_vm::api::enforce_tree_budgets`, swept every
  frame): an overrunning branch — parent, siblings, offender — is terminated
  *together*. A hung child first traps on its own per-turn instruction cap and
  the parent is notified (`VMs.onChildTrapped`) so it can handle it; a parent
  that never does eventually pays with its whole branch.
* **Hierarchical permissions** — a VM's *effective* capability set is the AND
  of the local grants along its ancestor path (`elpian-vm`'s
  `sdk/hierarchy.rs`). A parent lacking a permission can never confer it; a
  parent holding one may grant it per child; `setPermission(name, allowed)`
  recomputes and pushes the effective sets for the entire affected subtree
  immediately — enforcement happens inside each VM's executor (a denied
  family short-circuits to null before reaching the host).
* **Messaging** — `send(msg)` / `VMs.sendParent(msg)` deliver to the target's
  `VMs.onMessage(cb)`; notifications (`trapped` / `terminated`) arrive at
  `VMs.onNotify` / `onChildTrapped` / `onChildTerminated`.
* **Callback namespacing** — each VM's signal-callback ids are namespaced by
  the manager (`vm << 32 | local`), so one shared `GodotController` dispatches
  every bridged signal back to the VM that owns the closure.

### The Godot node sandbox

Every spawned VM is assigned a node in the shared scene and all of its engine
access is confined to that node's subtree. The manager stamps each forwarded
op with the caller's sandbox root (`"__sbx"` — stripped from guest input
first, so it cannot be forged), and the C++ controller enforces at resolve
time:

* object refs (as targets **or arguments**) only resolve to Nodes inside the
  sandbox root's subtree — a parent can freely manipulate its children's node
  trees (they sit inside its own sandbox by construction), a child can never
  address outward, even holding a handle it obtained via `get_parent()`;
* non-Node objects resolve only if created by the same sandbox, created by an
  unrestricted context (the shared inter-VM space), or explicitly shared via
  `VmController.grant(obj)`;
* `GD.host()`/`GD.mount()` bind the VM's own sandbox root, not the ElpianVM
  node; the SceneTree (`MainLoop`), singletons, `expr`, and `static` calls
  require the `scene` permission (the whole-scene role, root by default,
  grantable/revocable down the tree on the fly);
* script injection is refused (`set_script`, `script` property writes,
  instantiating/loading Script-derived types).

## Signals, callables, reentrancy

`btn.connect('pressed', (args) { … })` mints an `ElpianCallable` — a real
`CallableCustom` whose target is the Dart closure. Because the VM may be
**paused inside an op** when a synchronous signal fires, bridged callables
never re-enter the VM: they queue `(cb_id, args)` on the controller, and the
`ElpianVM` node flushes the queue into the guest's `__godotDispatch` at each
frame boundary (and after every run/invoke). The same mechanism serves bare
Dart closures passed as arguments to any Godot API taking a `Callable`
(tweens, timers, …) — invocations are fire-and-forget by design.

## Performance model

1. **Batching** — construction and multi-op updates coalesce into one seam
   crossing (`godot.batch`).
2. **Retained scene** — Godot renders retained nodes; the guest does *not*
   redraw per frame. Steady-state per-frame guest work is `_process` logic
   plus a few property writes.
3. **Handles, not objects** — marshaling is by 64-bit id; StringName interning
   is the engine's own; signal dispatch is queued and delivered in frame-batches.
4. **Governed** — the VM's instruction/memory limits plus the Dart layer's
   `ResourceMeter` (host-call count + bytes moved, settable on the node as
   `max_host_calls`/`max_bytes_moved`) bound a runaway guest at both layers.

## The ElpianVM node

Drop an `ElpianVM` node in any scene, set `script_path` to a `.dart` file
(or paste into `guest_source`), and it: composes the prelude, compiles
Dart→AST→bytecode, runs `main()`, then per frame flushes bridged signals →
dispatches `_process` → pumps VM timers/futures. `_ready`,
`_physics_process`, `_input`, `_unhandled_input`, `_notification` and
`_exit_tree` are forwarded to the guest's `GD.on*` handlers. From GDScript you
can call `exec_op_json()`, `invoke_guest()`, `audit_json()`,
`start/stop/restart()`, and listen to `guest_log` / `vm_error` signals.
Guest `print()` lines surface on the Godot console prefixed `[elpian]`.

## Building

```sh
# 1. The Rust half (from elpian/):
cargo build -p elpian-godot-capi --release

# 2. The C++ half (from elpian/godot/extension/):
git clone -b godot-4.3-stable https://github.com/godotengine/godot-cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release      # or: scons
cmake --build build -j

# 3. Run the TPS game (the main scene; Godot 4.3+):
godot --path ../project
# …or the multi-VM showcase scene:
godot --path ../project main.tscn
# …or the Victor UI kit showcase (JavaScript guest, portrait):
godot --path ../project ui_demo.tscn
```

The library lands in `project/bin/` where `elpian_godot.gdextension` expects
it. `-DGODOT_CPP_PATH=…` / `elpian_capi=…` override the default checkout and
archive locations.

### CI: web (GitHub Pages) and Android APK

Two workflows at the repo root build the demo for the other platforms
(`export_presets.cfg` carries the Web and Android presets):

* `.github/workflows/web-demo-pages.yml` — cross-compiles the VM to
  `wasm32-unknown-emscripten` (Rust pinned to 1.81.0 and Emscripten to
  3.1.64: the emsdk must match Godot 4.3's official web templates, and newer
  rustc emits wasm target features that emsdk's wasm-opt rejects), builds the
  extension as a **non-threaded** `.wasm` side module (`scons platform=web
  threads=no` — Rust's prebuilt emscripten std has no atomics, and nothreads
  also removes the SharedArrayBuffer/COOP/COEP requirement GitHub Pages
  cannot meet), exports headless with the nothreads dlink templates
  (`variant/extensions_support=true`, `variant/thread_support=false`), and
  deploys to **GitHub Pages**. Enable Pages with source "GitHub Actions" in
  the repo settings.
* `.github/workflows/android-apk.yml` — cross-compiles the VM to
  `aarch64-linux-android` (NDK clang as linker), builds the extension for
  arm64 (`scons platform=android`), installs the gradle build template
  (required for GDExtension APKs), exports headless with a CI-generated
  keystore, uploads the APK as an artifact, and **commits
  `elpian-godot-demo.apk` to the repository root** on the triggering branch
  (`[skip ci]` guards the loop). Swap the keystore env vars for repository
  secrets to sign for a store.

Both trigger on pushes to `main`/`master` touching `elpian/**` and support
manual `workflow_dispatch` from any branch. Each also builds the linux
extension so the headless editor can load the `.gdextension` during
import/export.

## What is verified today

* `cargo test -p elpian-godot-capi` — **26 e2e tests** running real guest
  programs (prelude + test Dart, compiled by dart2elpian, executed on real
  VMs) against a mock engine behind the host hook, pinning the wire protocol:
  create/set/get/call round-trips, every value shape, batching (N ops = 1
  crossing), signal → closure dispatch, closure → Callable marshaling,
  lifecycle events, singletons/constants/loads, `GTimer` on the VM event loop,
  the C ABI surface itself (boot/run/log/invoke/pump/teardown + compile-error
  reporting), **the whole multi-VM contract** (`tests/multi_vm.rs`: child
  spawn/boot with sandbox stamping, forged-`__sbx` stripping, callback-id
  namespacing + routed dispatch, hierarchical permission revocation/re-grant
  down the subtree, terminate-parent-kills-subtree, pause/resume event gating,
  a hung child trapped on its per-turn budget + parent notification, the
  aggregate-budget branch kill, spawn rejection for out-of-sandbox nodes,
  parent↔child messaging, on-the-fly `scene`-permission toggling, cross-tree
  usage/state introspection), and that the shipped multi-VM demo **runs** —
  boots the 5-VM tree, keeps the physics child's periodic mounting bodies,
  and traps the rogue's hang — under the real frame-loop drive.
* `tests/js_guest.rs` — **the JavaScript guest surface**: `godot.js` compiled
  by js2elpian on real VMs against a mock engine — protocol round-trips and
  value-shape marshaling, batching, signal → JS-closure dispatch, `GTimer` on
  the pumped event loop, a JS parent spawning a JS child (language inheritance
  through `vm.spawn`) with parent↔child messaging, and the `import 'ui.js'`
  composition seam building real Control-node op streams.
* `tests/run_ui_demo.rs` — **the shipped Victor UI demo runs end to end**: the
  full phone-style app boots against a mock engine (portrait + content-scale
  ops verified), every wired button is pressed through the real
  `__godotDispatch` path (nav walk, tap counter, toggles/checkboxes, dialogs,
  sheets, toasts), the slider/field value signals reach their closures, the
  JavaScript child VM spawns → messages the UI → is terminated, and ~4s of
  frames drive the dashboard's periodic refresh — all under a watchdog.
* `tests/run_tps.rs` — **the shipped TPS game plays a full mission headless**
  on the real VM against a mock engine: boot + city build (≥60 mounted
  branches), menu frames, mission start, wave 1 deployment, hostiles closing
  in on Dart-side predicted movement until the player falls (game over), a
  clean restart, and the debug hooks (fire / kill-nearest / status) — all
  under a watchdog. This pins the game's whole prediction/fallback layer:
  it must run with **no** assets, physics answers, or raycast hits.
* The GDExtension **compiles and links against real godot-cpp 4.3**
  (`libelpian_godot.linux.x86_64.so`, entry symbol exported), Rust archive
  included.
* The full existing suite (190+ tests across the workspace) stays green.

Not yet verified here: an interactive run inside the Godot editor/runtime
(no engine binary in this environment) — the demo project is the first thing
to open once you have one.

## Trust & governance note

The **root** guest program reaches the whole engine **by design** (that is
the point of the bridge). `DartCapabilitySet`/`ResourceMeter` bound *how
much* it can call, not *what* — `OS.execute`, file access etc. are engine
surfaces like any other. Treat the root `.dart` program you load like a
`.gd` script: code you run is code you trust. (The signed-bundle machinery
in `dart/src/bundle.rs` applies unchanged if you deliver Dart programs
dynamically.)

**Child VMs are different**: a spawned VM runs inside real engineering
isolation — node-subtree containment, handle ownership, MainLoop/singleton/
expression/script-injection guards, capability intersection with its ancestor
path, and hierarchical resource budgets. That makes children the right place
for third-party or dynamically delivered modules: the parent decides the
node, the budget and the permission set, can change them on the fly, and can
pause or kill the branch at any time.
