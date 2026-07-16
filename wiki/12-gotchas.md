# 12 — Gotchas (read this before writing code)

The concentrated list of mistakes that look fine but break at runtime. Every one
was hit in real development. If your code fails on the first run, the cause is
almost certainly here.

## Language / VM

1. **List vs map: use `__isType`, never `.length`.**
   ```js
   if (__isType(v, "list")) { ... }   // ✅ array
   if (__isType(v, "map"))  { ... }   // ✅ object
   ```
   Probing a map for `.length` (or `v.length == null`) to guess array-ness raises
   `"non object value can not be indexed by string"`. This is the #1 runtime
   error. (`typeof` returns `"object"` for both, so it can't distinguish them.)

2. **`0` is falsy but is NOT null.** `if (x)` is false for `0`; `x == null` is
   false for `0`. Absent reads (missing arg/member/key/index) yield `null`.

3. **`sin`, `cos`, `min`, `max`, `clamp`, `abs`, `sqrt`, `PI`, `TAU`, … are
   global functions/constants.** Call `sin(x)` directly. (`Math.sin` also works
   in JS — it maps to the same builtin.)

4. **No `async`/`await`, Promises, generators, or `sleep`.** Use `GTimer.after`/
   `GTimer.periodic` and callback style, or `GD.onProcess` for per-frame work.

5. **Preludes were written in a conservative JS subset** (their headers say "no
   try/catch, no spread…"). The *current* `js2elpian` supports the full tower
   (try/catch, spread, destructuring, template literals — see `03-javascript.md`),
   so your own code can use them. But **if you edit a prelude, match its
   conservative style** to be safe.

6. **A failed host op throws in the guest** (it resumes as `{__dart_error__:…}`
   which the front-end lowers to a throw). Wrap risky host calls in `try/catch`
   when you need to detect failure. (`FL.mount` uses exactly this to detect a
   missing engine.)

## The Godot bridge

7. **`GD.host()` is the ElpianVM node ITSELF, not its parent.** Add your scene
   under it: `GD.host().call("add_child",[x])` or `GD.mount(x)`. In a sandboxed
   child VM it binds the VM's assigned sandbox node.

8. **`GInt` / `GFloat` for int-vs-float.** A guest number is ambiguous at the
   Godot boundary. When an API needs a specific int (enums, indices, flags,
   sizes) or float, wrap it: `n.set("...font_size", GInt(18))`,
   `m.set("radius", GFloat(0.5))`. Number misbehavior is almost always this.
   Dart's `int`/`double` distinction is erased at the boundary — the same rule
   applies to Dart guests.

9. **Signal callbacks are DEFERRED, not synchronous.** `obj.connect(sig, cb)`
   queues the callback; it runs at the next frame boundary, not during the call
   that emitted the signal. Do not assume a connected callback has fired by the
   next line.

10. **You cannot draw with `draw_*` from a bridged signal.** The `draw` signal
    callback runs outside Godot's draw phase (deferred), so `CanvasItem.draw_*`
    is rejected. For custom drawing use `VUI.canvas` (which uses
    `RenderingServer.canvas_item_add_*`, phase-independent) — see `06-vui.md`.

11. **Batch heavy op sequences.** Building many nodes/props per frame? Wrap in
    `GD.beginBatch()` … `GD.endBatch()` (one seam crossing) instead of N calls.

12. **The sandbox is real.** A spawned child VM can only address Nodes inside its
    assigned subtree; whole-scene ops (`tree`/`singleton`/`expr`/`static`) and
    script injection are refused. Don't try to reach outward from a child.

## VUI

13. **`VUI.app({ bg: false })` to show a 3D scene under the UI.** `VUI.app`
    paints an **opaque full-screen background** by default (that's how `ui_demo`
    hides its 3D). If "the 3D doesn't render", this is why.

14. **`VUI.repaint(node)` to animate a `VUI.canvas`.** The painter runs once at
    creation; call `VUI.repaint` (e.g. from `GD.onProcess`) to re-run it.

15. **Canvas geometry is `Rect = [left, top, right, bottom]`** (not x/y/w/h). Use
    `FL.ltwh(l,t,w,h)` if you think in width/height. `Offset = [x,y]`,
    `Color = [r,g,b,a]` (0..1) or `0xAARRGGBB`.

16. **Give gradient paints a fallback `color`.** The native (`VUI.canvas`) path
    ignores `FL.sweepGradient/linearGradient` shaders and uses the paint's plain
    `color`; without one it draws white.

17. **`mouse_filter` governs input passthrough.** A full-rect Control with
    `mouse_filter = STOP` blocks input to things behind it. Set IGNORE (2) on
    pass-through layers; interactive controls STOP for themselves. (This is why
    layering an interactive panel over an interactive area is fiddly — prefer a
    bottom-anchored panel over a full-screen one.)

## Flutter (`FL`)

18. **`FL.mount(...)` returns `null` when no Flutter engine is present** (every
    web export; any build without `ELPIAN_WITH_FLUTTER`). ALWAYS handle null and
    fall back to VUI. The shipped Android/web artifacts run the VUI path.

19. **Handlers only mutate state; the framework re-renders.** Do NOT call the
    render from inside a widget event handler (synchronous re-render inside a
    dispatched handler trips a front-end closure-capture edge case). For a state
    change outside an event, call `view.update()`.

20. **Web can never embed real Flutter** (libflutter doesn't build into a wasm
    Godot export). **Android real-Flutter needs a from-source engine build**
    (the stock Android engine hides the embedder C-API symbols). See
    `victor/bridge/FLUTTER.md`. Default: use VUI for shipped artifacts.

## Building / testing

21. **The `elpian/flutter/*` ProjectSettings keys keep the `elpian/` prefix** —
    they are code keys defined in `flutter_view.cpp`
    (`elpian/flutter/{aot_library_path,assets_path,icu_data_path}`), not repo
    paths. Do not "rename" them to `victor/`.

22. **Changing a prelude or guest script needs no C++/Rust rebuild** — the VM
    recompiles the program at load. Only C++/Rust changes need `scons`/`cargo`.

23. **Build the host (linux) extension before an Android/web export** — the
    headless editor loads the `.gdextension` during import.

24. **Web build pins Rust 1.81.0 + emsdk 3.1.64** and needs `generate_bindings=
    yes` on both scons calls (arch-size mismatch otherwise corrupts Variant
    layouts).

25. **Test-harness pitfall: `take_log()` drains.** In a Rust test, call it once
    and store the result; calling it twice returns empty the second time and
    fails a later assertion that looks unrelated.

26. **`run_tritonland` tests fail outside their environment** (they read an
    external `/home/user/TritonLand/...` file). That failure is pre-existing and
    not caused by your change.

## The meta-rule

When something "looks fine but breaks," check: (a) list-vs-map (`__isType`),
(b) int/float (`GInt`/`GFloat`), (c) deferred callbacks, (d) `null` from an
absent read or a missing engine. Those four cover most first-run failures.
