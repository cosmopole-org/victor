# 05 — The Godot bridge (`godot.js` / `godot.dart`)

The Godot bridge lets a guest drive the **entire** Godot 4 engine — every node
class, method, property, signal, server, constant — from a no-JIT VM. It is
*reflective*: it does not wrap engine classes by hand. Instead the C++
`GodotController` interprets a tiny uniform "op" protocol that addresses the
engine **by name** through ClassDB. Coverage is complete by construction,
including classes added in future Godot versions.

`import 'godot.js';` (or `'godot.dart'`) gives you `GD`, `GObj`, the value
types, `G3`, `GTimer`, and `VMs`.

## `GD` — the engine facade

`GD` reaches every engine surface. Full method list (from `godot.js`):

| Category | Methods |
|---|---|
| objects | `GD.create(className)` · `GD.singleton(name)` · `GD.tree()` · `GD.host()` · `GD.mount(node)` · `GD.load(path)` |
| raw ops | `GD.op(m)` · `GD.beginBatch()` / `GD.endBatch()` · `GD.m(v)` (marshal) |
| constants / expr | `GD.constant("Class.NAME" | "GLOBAL_NAME")` · `GD.eval(expr, names, values)` |
| introspection | `GD.classes()` · `GD.classInfo(cls)` · `GD.audit()` |
| named singletons | `GD.renderingServer()` · `GD.physicsServer2D()` · `GD.physicsServer3D()` · `GD.audioServer()` · `GD.displayServer()` · `GD.input()` · `GD.engine()` · `GD.os()` · `GD.time()` · `GD.projectSettings()` · `GD.resourceLoader()` |
| callables | `GD.callable(fn)` · `GD.isError(v)` |
| color helpers | `GD.rgb(r,g,b[,a])` · `GD.hex(0xRRGGBB)` |
| lifecycle | `GD.onReady/onProcess/onPhysicsProcess/onInput/onUnhandledInput/onNotification/onExit(cb)` |
| multi-VM | `GD.spawn/trySpawn(...)` and the `VMs` facade (see below) |
| packed arrays | `GD.bytesBase64 / i32 / i64 / f32 / f64 / strings / vector2s / vector3s / vector4s / colors` (also on `Packed`) |

Key ones:

```js
let node = GD.create("RigidBody2D");   // instantiate ANY ClassDB class by name
let rs   = GD.singleton("RenderingServer");
let tree = GD.tree();                  // the SceneTree
let self = GD.host();                  // the ElpianVM node itself
GD.mount(node);                        // == GD.host().call("add_child",[node])
let esc  = GD.constant("KEY_ESCAPE");  // any @GlobalScope / class constant
let clamped = GD.eval("clamp(x,0,1)", ["x"], [v]); // any Godot Expression / utility fn
```

> `GD.host()` returns the **ElpianVM node itself** (a `{self:true}` op), NOT its
> parent. Add your scene under it with `GD.mount(x)` or
> `GD.host().call("add_child",[x])`. In a sandboxed child VM, `GD.host()` binds
> the VM's assigned sandbox node.

## `GObj` — a handle to any engine object

`GD.create` / `GD.singleton` / etc. return a `GObj`. Objects never cross the VM
seam — 64-bit **handles** do. `GObj` methods:

```js
obj.call(method, args)         // Object::callv — call ANY method by name
obj.get(prop)                  // read ANY property
obj.set(prop, value)           // write ANY property
obj.getIndexed(path)           // nested sub-property, e.g. "position:x"
obj.setIndexed(path, value)
obj.connect(signal, cb, flags) // connect ANY signal to a JS/Dart closure -> cb id
obj.disconnect(signal, cbId)
obj.signal(name)               // a GSignal value
obj.emitSignal(name, args)
obj.queueFree()                // queue_free()
obj.freeNow()                  // memdelete
obj.release()                  // drop the handle (RefCounted may then free)
```

```js
let btn = GD.create("Button");
btn.set("text", "Tap");
btn.connect("pressed", (a) => { print("tapped"); });   // signal -> closure
GD.mount(btn);
```

## Value types (from `godot.js`)

Construct with `new` (JS) and pass to any Godot API; the bridge marshals them to
the matching Variant. Reading a Variant back gives you the same wrapper.

```
Vector2 Vector2i Vector3 Vector3i Vector4 Vector4i
Color Rect2 Rect2i Plane Quaternion AABB Basis
Transform2D Transform3D Projection StringName NodePath
GRid (RID) GSignal GCallable GDict Packed
GInt GFloat        ← int/float disambiguation, see below
```

```js
node.set("position", new Vector2(4, 2));
node.set("modulate", new Color(1, 0, 0, 1));
mesh.set("size", new Vector3(1, 1, 1));
```

### `GInt` / `GFloat` — the marshaling rule you must know

A guest number is ambiguous: Godot may need an `int` (e.g. an enum, an index, a
flag) or a `float`. When a specific type is required, wrap it:

```js
node.set("theme_override_font_sizes/font_size", GInt(18));   // int
mesh.set("radius", GFloat(0.5));                             // float
```

If a call misbehaves with numbers, this is almost always the cause. (See
`12-gotchas.md`.) Bare numbers usually work for positions/scalars, but enums,
sizes, and counts often need `GInt`/`GFloat`.

## The op protocol (how it works underneath)

Two host-call names cross the seam: `godot.op` (one op → one result) and
`godot.batch` (an array of ops → array of results in ONE crossing — the
high-performance path, `GD.beginBatch()` … `GD.endBatch()`). Op kinds: `new`,
`singleton`, `tree`, `self`, `load`, `method`, `get`/`set`, `geti`/`seti`,
`connect`/`disconnect`, `free`, `const`, `expr`, `static`, `classes`,
`classinfo`, `audit`, plus the multi-VM ops `chk`/`grant`. You rarely write ops
directly — `GD.op(m)` is the escape hatch. Marshaling covers every Variant shape
in both directions (vectors, transforms, colors, rects, packed arrays, dicts,
node paths, string names, RIDs, callables, signals).

**Batch for performance:** building many nodes/props per frame? Wrap them:

```js
GD.beginBatch();
for (let i = 0; i < 100; i++) { /* GD.create / .set ... queue locally */ }
let results = GD.endBatch();   // ONE seam crossing
```

## `G3` — the 3D convenience layer

`G3` composes the reflective bridge into ergonomic 3D helpers (from `godot.js`):

```
G3.node(o)          Node3D group with a transform
G3.mesh(shape, o)   MeshInstance3D with a primitive + material + transform
G3.primitive(shape,o)  raw {box,sphere,cylinder,capsule,plane,prism,torus} mesh
G3.material(o)      StandardMaterial3D (color, emission, metallic, roughness, …)
G3.camera(o)        Camera3D (fov, current, transform)
G3.dirLight(o) / G3.omniLight(o) / G3.spotLight(o)
G3.environment(o)   WorldEnvironment + Environment (bg, ambient)
G3.viewport(o)      SubViewportContainer + SubViewport (the 2D↔3D bridge)
G3.gltf(src, o)     load a .glb (path, user://, or {base64})
G3.instanceScene(path) / G3.fitHeight(node, h) / G3.setTransform(node, o) / G3.raycast(...)
```

`o` accepts `position:[x,y,z]`, `rotation:[deg,deg,deg]`, `scale`, plus
shape/material options (`size`, `radius`, `innerRadius`, `outerRadius`, `height`,
`color`, `emission`, `emissionEnergy`, `metallic`, `roughness`). Example:

```js
let host = GD.host();
host.call("add_child", [G3.environment({ bg: new Color(0.05,0.06,0.09,1) })]);
host.call("add_child", [G3.dirLight({ energy: 1.3, shadow: true, rotation: [-50,-30,0] })]);
host.call("add_child", [G3.camera({ position: [0,3,8], rotation: [-18,0,0], fov: 55 })]);
host.call("add_child", [G3.mesh("torus", { color: new Color(0.4,0.6,1,1), position: [0,1,0] })]);
```

> Place a ring of objects without trig by nesting each under a rotated pivot:
> `G3.node({ rotation:[0, i*360/n, 0] })` with the mesh at `position:[radius,0,0]`.

## `GTimer` — timers on the VM event loop

```js
GTimer.after(ms, () => { ... });        // one-shot
let t = GTimer.periodic(ms, () => {...}); t.cancel();   // repeating
```

Timers fire on real elapsed time as the `ElpianVM` node pumps the VM each frame.
Prefer them over busy loops (there is no `sleep`).

## Engine lifecycle handlers

The `ElpianVM` node forwards engine callbacks into the guest:

```js
GD.onReady(() => { ... });
GD.onProcess((delta) => { ... });          // every frame; delta in seconds
GD.onPhysicsProcess((delta) => { ... });
GD.onInput((event) => { ... });            // event is a GObj (InputEvent)
GD.onUnhandledInput((event) => { ... });
GD.onNotification((what) => { ... });
GD.onExit(() => { ... });
```

Input events arrive as `GObj` handles — read them with `event.call("is_class",
["InputEventMouseButton"])`, `event.get("position")`, `event.get("relative")`,
`event.get("pressed")`, etc. (This is what `VUI.gestures` does; see `06`.)

## Signals & deferred dispatch (critical)

`obj.connect(signal, cb)` returns a callback id. But **the callback does NOT run
synchronously** when the signal fires: while the VM is paused inside an op, a
synchronously-emitted signal cannot re-enter the VM, so bridged callables
**queue** their invocation and the `ElpianVM` node flushes the queue into the
guest at the next frame boundary. Consequences:

- Do not assume a connected callback has fired by the next line.
- Inside a signal callback, drawing directly (`draw_*`) does **not** work — the
  callback runs outside the draw phase (this is why VUI's canvas uses
  `RenderingServer.canvas_item_add_*`, which is phase-independent; see `06`).

## The multi-VM system (`VMs`) and the sandbox

One `ElpianVM` node hosts a **tree** of VMs sharing one scene. The root VM manages
the whole scene; any VM can spawn children it fully controls, each **sandboxed to
an assigned node subtree**.

```js
let child = VMs.spawn(sourceString, node, {
  label: "physics", lang: "js",
  limits: { instructions: 5e7, instructionsPerTurn: 1e6, memoryBytes: 8e6 },
  permissions: { scene: false }, maxHostCalls: 0, maxBytesMoved: 0,
});
child.pause(); child.resume(); child.terminate();
child.send(msg); child.setPermission(name, allowed); child.setLimits(limits);
VMs.onMessage((sender, msg) => { ... });
VMs.onChildTrapped((kind, vmId, detail) => { ... });
VMs.sendParent(msg);
```

Sandbox rules the C++ controller enforces (a child cannot escape):

- Object references (as targets **or arguments**) only resolve to Nodes inside
  the sandbox root's subtree. A parent can reach into its children's subtrees
  (they are inside its own sandbox); a child can never address outward.
- Non-Node objects resolve only if created by the same sandbox, by an
  unrestricted context, or explicitly shared via `grant`.
- Whole-scene ops (`tree`/`singleton`/`expr`/`static`) and script injection are
  refused for sandboxed VMs.
- Terminating a parent kills its whole subtree; budgets are enforced against
  aggregate subtree usage; effective permissions are the AND along the ancestor
  path.

Use this to run untrusted/user code safely, or to structure a large app into
isolated modules.

## Where this runs

The guest program is attached to an **`ElpianVM` node** in a Godot scene (set its
`script_path` to `res://scripts/yourprogram.js` and `language` to `js`/`dart`/
`auto`). The node pumps the VM each frame, forwards lifecycle events, and flushes
signal callbacks. See `10-building-and-ci.md` for scenes + export.
