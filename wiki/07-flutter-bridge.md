# 07 — The Flutter bridge (`FL`)

`FL` (`flutter.js`) drives a **real embedded Flutter engine** as the 2D UI. It is
the twin of the Godot bridge but over a declarative widget protocol instead of
ClassDB. A guest describes a widget tree as data; a fixed AOT Flutter
"interpreter app" (`victor/bridge/flutter_host/`) turns it into real Flutter
widgets and paints them; events flow back.

Deep architecture + build instructions: **`victor/bridge/FLUTTER.md`**. This page
is the guest-developer view.

## When to use `FL` vs VUI

- The **real Flutter engine only exists** in a build made with
  `ELPIAN_WITH_FLUTTER` + the engine artifact. It is **never on the web**
  (libflutter can't embed in a wasm export) and is **hard on Android** (needs a
  from-source engine build).
- So `FL.mount(...)` **returns `null` when the engine is absent**, and you should
  fall back to VUI. The shipped Android/web artifacts run the VUI path.
- Use `FL` when you specifically need the real Flutter framework and you control
  the build (desktop, or a custom Android with the engine). Otherwise use VUI
  (`06`) — its canvas and gestures give you the same capabilities natively.

```js
import 'godot.js';
import 'ui.js';
import 'flutter.js';

let layer = GD.create("CanvasLayer");
GD.host().call("add_child", [layer]);
let view = FL.mount(layer, App, { design: [720, 1280], transparent: true });
if (view == null) {
  layer.call("queue_free", []);
  buildVuiFallback();     // engine absent -> use VUI
}
```

## The builder / render model (important)

`FL.mount(parent, builder, opts)` takes a **builder** — a function returning the
current widget tree. The framework calls it for the first paint and again after
every widget event. **A handler only mutates state and returns; the framework
re-renders.** Do NOT call the render yourself from inside a handler.

```js
var count = 0;
function App() {
  return FL.scaffold({
    appBar: FL.appBar(FL.text("Counter")),
    body: FL.center(FL.column([
      FL.text("Taps: " + count, { size: 32 }),
      FL.filledButton("Tap me", function () { count = count + 1; }),  // just mutate
    ])),
  });
}
var view = FL.mount(GD.host(), App, { design: [720, 1280] });
```

For a state change from OUTSIDE an event (a timer, a network reply), call
`view.update()` (or `view.setState(fn)`), and `view.setBuilder(fn)` to navigate.

> **Why the builder model, not synchronous re-render:** re-rendering *inside* a
> dispatched event handler tripped a front-end closure-capture edge case;
> driving re-render from framework-owned code (the coalesced `__later` flush)
> avoids it. Just follow the model: handlers mutate, the framework renders.

## Widgets

Any widget by name via `FL.el(type, props, children)`; plus sugar:

```
FL.app FL.scaffold FL.appBar FL.text FL.column FL.row FL.stack FL.center
FL.padding FL.container FL.sizedBox FL.expanded FL.listView FL.image FL.icon
FL.filledButton FL.textButton FL.iconButton FL.textField FL.switchTile FL.slider
FL.align FL.positioned FL.wrap FL.flexible FL.aspectRatio FL.opacity FL.clip
FL.card FL.listTile FL.chip FL.checkbox FL.radio FL.dropdown FL.scroll
FL.gridView FL.pageView FL.tabs FL.circularProgress FL.linearProgress
FL.divider FL.circleAvatar FL.tooltip FL.hero FL.animatedContainer
```

`FL.el("AnyFlutterWidget", { propName: value, child: FL.text("x") }, [children])`
reaches **any** widget the host interpreter knows. Widget coverage is
enumerated in `flutter_host/lib/main.dart` (a large hand-written catalog) plus a
generator (`flutter_host/tool/gen_registry.dart`) that closes it to the full
public API. Handlers can appear on any prop in any position (a prop, an element
of a prop array, a nested map) — the guest reifier handles all of them.

## Events (the full surface)

Every gesture/pointer/keyboard/drag/scroll/value callback is a function-valued
prop. Sugar wrappers:

```js
FL.gestures(child, {                      // GestureDetector — the full callback set
  onTap, onDoubleTap, onLongPress, onPanUpdate, onScaleUpdate, onForcePressUpdate,
  onVerticalDragEnd, onSecondaryTap, /* ...~35 callbacks... */ });
FL.inkWell(child, { onTap, onHover, onFocusChange, ... });
FL.listener(child, { onPointerDown, onPointerMove, onPointerSignal, ... });
FL.mouseRegion(child, { onEnter, onExit, onHover });
FL.keyboard(child, onKeyEvent);
FL.focus(child, { onFocusChange, onKeyEvent });
FL.notificationListener(child, onNotification);   // scroll notifications
FL.draggable(child, feedback, { onDragStarted, onDragEnd, ... });
FL.dragTarget(child, { onWillAccept, onAccept, onLeave, onMove });
FL.dismissible(key, child, { onDismissed, confirmDismiss });
FL.refreshIndicator(child, onRefresh);
FL.popScope(child, onPopInvoked, canPop);
```

Each handler receives a JSON details object (tap → `{globalX,globalY,localX,
localY}`, drag → `{dx,dy,...}`, scale → `{scale,rotation,...}`, key → `{logicalKey,
character,isDown,...}`, etc.).

## Canvas (`CustomPaint`)

The full `dart:ui` drawing surface as a display list. Record with `FL.customPaint`
+ an `FLCanvas`; the host replays it onto the real Flutter `Canvas`.

```js
FL.customPaint([300, 200], (cv) => {
  let p = FL.paint({ color:[1,0,0,1], style:"stroke", strokeWidth:4 });
  cv.drawCircle(150, 100, 60, p);
  let path = FL.path().moveTo(0,0).lineTo(300,200).close();
  cv.drawPath(path, FL.paint({ shader: FL.linearGradient([0,0],[300,200],[[1,0,0,1],[0,0,1,1]],[0,1]) }));
})
```

- `FLCanvas` methods: `save saveLayer restore translate scale rotate skew
  transform clipRect clipRRect clipPath drawColor drawPaint drawLine drawRect
  drawRRect drawDRRect drawOval drawCircle drawArc drawPath drawImage
  drawImageRect drawImageNine drawParagraph drawPoints drawShadow drawVertices
  drawAtlas`.
- `FLPath` methods: `moveTo lineTo relativeMoveTo relativeLineTo
  quadraticBezierTo cubicTo conicTo arcTo arcToPoint addRect addRRect addOval
  addArc addPolygon addPath close reset fillType`.
- Helpers: `FL.paint FL.path FL.linearGradient FL.radialGradient FL.sweepGradient
  FL.rrect FL.ltwh FL.paragraph`.
- Geometry: `Offset = [x,y]`, `Rect = [left,top,right,bottom]` (use `FL.ltwh(l,t,
  w,h)` if you think in width/height), `Color = [r,g,b,a]` (0..1) or `0xAARRGGBB`.

**The same painter works on VUI** (`VUI.canvas`) because `VuiCanvas` mirrors the
`FLCanvas` surface — write your painter once and use it on either path.

## Degradation contract (write portable UIs)

Because the engine may be absent, structure a demo/app to work either way:

1. Try `FL.mount(...)`; if it returns `null`, build the same UI with VUI.
2. Share the canvas painter (`drawGauge(cv)`) between `FL.customPaint(...)` and
   `VUI.canvas({ paint: drawGauge })`.
3. Share the event handlers (they only mutate state).

The shipped `flutter_3d_demo.js` does exactly this. On desktop-with-engine it
shows real Flutter; on Android/web it shows the identical UI via VUI.

## Building with the real engine

See `10-building-and-ci.md` and `victor/bridge/FLUTTER.md`. Short version:
`ELPIAN_WITH_FLUTTER=ON` + a `FLUTTER_ENGINE_DIR` with `flutter_embedder.h` +
`libflutter_engine.so`, plus the AOT snapshot of `flutter_host` staged at
`res://flutter/{app.so,flutter_assets,icudtl.dat}`. Not available on web; on
Android the engine must be built from source.
