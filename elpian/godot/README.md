# Elpian ↔ Godot — a Dart program (no JIT) driving the full Godot engine

This directory wires the **Elpian VM** (with the `dart` feature: the
Dart→Elpian front-end + the Dart runtime layer from `elpian/dart/`) into a
**Godot 4 project**, and implements a **C++ controller for the whole engine**
that the VM drives over its `askHost` seam. A Dart program running on Elpian
can create/control/manage every layer of Godot — scene tree, all node classes,
rendering, physics, navigation, audio, input, GUI, resources, tweens, signals,
servers (RID APIs), reflection — with the same no-JIT/App-Store-legal execution
model as the rest of this repo.

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
| `capi/` | `elpian-godot-capi` — Rust crate exposing the VM as a **C ABI** (`elpian_godot_new/run/invoke/pump/…`) with a host-callback seam for `godot.*` calls. Workspace member; `cargo test` runs the protocol e2e suite. |
| `prelude/godot.dart` | The guest library (`GD`, `GObj`, value types, `GTimer`, marshaling). Embedded into the Rust crate via `include_str!` and composed ahead of the user program. |
| `extension/` | The C++ GDExtension: `GodotController` (reflective op interpreter + Variant↔JSON marshaling + handle table), `ElpianCallable` (Dart-closure-backed `Callable`), `ElpianVM` (the scene node), build files (CMake + SCons). |
| `project/` | A ready Godot 4.3+ project: `main.tscn` hosts an `ElpianVM` node running `scripts/main.dart` (GUI + physics + signals + input + servers demo). |

## The op protocol (one seam, everything reachable)

Two host-call names cross the VM seam:

* `godot.op` — one op (a small tagged JSON object) → one result.
* `godot.batch` — an **array of ops → array of results in ONE crossing** (the
  high-performance path; `GD.beginBatch()`/`GD.endBatch()` in Dart).

Ops: `new`, `singleton`, `tree`, `self`, `load`, `method`, `get`/`set`,
`geti`/`seti` (indexed property paths), `connect`/`disconnect`, `free`
(handle/queue/now), `const`, `expr` (Godot `Expression` — reaches every
`@GlobalScope` utility function), `static` (ClassDB.class_call_static on
4.4+ engines, resolved at runtime), `classes`, `classinfo`, `audit`.

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
(or paste into `dart_source`), and it: composes the prelude, compiles
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

# 3. Run the demo project (Godot 4.3+):
godot --path ../project
```

The library lands in `project/bin/` where `elpian_godot.gdextension` expects
it. `-DGODOT_CPP_PATH=…` / `elpian_capi=…` override the default checkout and
archive locations.

## What is verified today

* `cargo test -p elpian-godot-capi` — **11 e2e tests** running real guest
  programs (prelude + test Dart, compiled by dart2elpian, executed on the real
  VM) against a mock engine behind the host hook, pinning the wire protocol:
  create/set/get/call round-trips, every value shape, batching (N ops = 1
  crossing), signal → closure dispatch, closure → Callable marshaling,
  lifecycle events, singletons/constants/loads, `GTimer` on the VM event loop,
  the C ABI surface itself (boot/run/log/invoke/pump/teardown + compile-error
  reporting), and that the shipped demo program compiles.
* The GDExtension **compiles and links against real godot-cpp 4.3**
  (`libelpian_godot.linux.x86_64.so`, entry symbol exported), Rust archive
  included.
* The full existing suite (190+ tests across the workspace) stays green.

Not yet verified here: an interactive run inside the Godot editor/runtime
(no engine binary in this environment) — the demo project is the first thing
to open once you have one.

## Trust & governance note

Guest Dart code reaches the whole engine **by design** (that is the point of
the bridge). `DartCapabilitySet`/`ResourceMeter` bound *how much* it can call,
not *what* — `OS.execute`, file access etc. are engine surfaces like any
other. Treat a `.dart` program you load like a `.gd` script: code you run is
code you trust. (The signed-bundle machinery in `dart/src/bundle.rs` applies
unchanged if you deliver Dart programs dynamically.)
