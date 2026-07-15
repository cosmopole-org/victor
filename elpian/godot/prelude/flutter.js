// =============================================================================
// flutter.js — FL: drive an embedded, real Flutter engine from an Elpian VM
// =============================================================================
//
// This is the guest half of the **Flutter UI bridge** — the twin of
// `godot.js`/`godot.dart`, but targeting a real `libflutter` engine embedded in
// the GDExtension (see `extension/src/flutter_controller.*` and
// `godot/FLUTTER.md`) instead of ClassDB. Where `GD` reaches every Godot class
// reflectively, `FL` speaks a small **declarative widget-tree op protocol**: the
// guest describes a widget tree as plain data, ships it over the `flutter.op`
// seam, and a fixed AOT-compiled Flutter "interpreter app" running inside the
// embedded engine reconciles that data into real Flutter widgets and paints
// them. No JIT, no codegen on the guest side — App-Store-legal, exactly like the
// rest of this repo.
//
//     import 'flutter.js';
//
//     var count = 0;
//     function App() {
//       return FL.scaffold({
//         appBar: FL.appBar(FL.text('Counter')),
//         body: FL.center(FL.column([
//           FL.text('Taps: ' + count, { size: 32 }),
//           FL.filledButton('Tap me', function () { count = count + 1; }),
//         ])),
//       });
//     }
//     var view = FL.mount(GD.host(), App, { design: [720, 1280] });
//
// The framework owns the render loop: `mount` takes a *builder* (a function
// returning the current widget tree), calls it for the first paint, and calls
// it again after every widget event — so a handler just mutates the state the
// builder reads (here `count`) and returns. State changed from outside an event
// (a timer, a network reply) calls `view.update()` (or `view.setState(fn)`).
//
// Composition: this prelude is layered *after* `godot.js` (an `import
// 'flutter.js';` line pulls it in), so it reuses that prelude's callback
// registry (`__gdRegisterCb` / `__gdCallbacks`) and marshaling. Widget event
// handlers therefore route back through the very same namespaced-callable path
// the Godot bridge uses: a handler becomes a `{"callable": cbId}` wire tag, the
// Rust VmManager rewrites the id into the owning VM's namespace, the C++
// FlutterController queues `(cb, args)` on an engine event, and the node flushes
// it as `__godotDispatch([cb, [args…]])` — which reaches the right VM even deep
// in a spawned subtree. One dispatch path, one sandbox model, for both UIs.
//
// ---------------------------------------------------------------------------
// The op protocol (mirrors godot.op — one seam, `flutter.op`/`flutter.batch`)
// ---------------------------------------------------------------------------
//   {"newview": true, "def": id, "parent": {"ref": nodeHandle}, "opts": {…}}
//                                     spin up an engine + a surface node under
//                                     `parent` (a Godot node in the VM sandbox)
//   {"render": viewId, "tree": <serialized widget tree>}
//                                     reconcile the view to this widget tree
//                                     (emitted by the framework's flush, not by
//                                     the app directly)
//   {"call": viewId, "channel": s, "msg": v}
//                                     send a raw platform message to the app
//   {"resize": viewId, "size": [w,h], "dpr": r}  drive metrics explicitly
//   {"disposeview": viewId}           tear the engine + surface down
//
// A serialized widget node is `{"t": type, "p": props, "c": [children…]}` (plus
// optional `"k": key for keyed reconciliation). Event handlers inside `p` are
// replaced with `{"callable": cbId}` tags at render time (see __flReify).

// The set of engine views this VM owns.
var __flViews = {};
var __flNextView = 1;

// ---------------------------------------------------------------------------
// Widget construction — every widget is just `{t, p, c}` data
// ---------------------------------------------------------------------------

// The universal element factory: __flEl('Padding', {all: 8}, [child]). The AOT
// interpreter app owns the `type -> real Flutter widget` mapping, so new widget
// types need no change here — only in the app.
function __flEl(type, props, children) {
  let node = { t: type, p: props == null ? {} : props };
  if (children != null) {
    if (typeof children == "string" || children.length == null) {
      node.c = [children];
    } else {
      node.c = children;
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Reify a tree for the wire: turn function-valued props into callable tags,
// reusing this view's callback slots across renders so re-rendering a tree does
// not leak an unbounded number of cb ids (the retained-reconciliation trick —
// the same idea react.js uses for its host callbacks).
// ---------------------------------------------------------------------------

function __flReify(view, node) {
  if (node == null) {
    return null;
  }
  let t = typeof node;
  if (t == "string" || t == "number" || t == "boolean") {
    return node;
  }
  let out = { t: node.t };
  if (node.k != null) {
    out.k = node.k;
  }
  if (node.p != null) {
    let p = {};
    for (let key in node.p) {
      let v = node.p[key];
      if (typeof v == "function") {
        p[key] = { callable: __flSlot(view, v) };
      } else if (v != null && typeof v == "object" && v.t != null) {
        // A widget passed as a prop value (AppBar title, Scaffold body, …).
        p[key] = __flReify(view, v);
      } else {
        p[key] = v;
      }
    }
    out.p = p;
  }
  if (node.c != null) {
    let kids = [];
    for (let i = 0; i < node.c.length; i++) {
      kids.push(__flReify(view, node.c[i]));
    }
    out.c = kids;
  }
  return out;
}

// Hand back a stable cb id for a handler in this render pass, reusing a slot
// allocated on a previous render when possible (so cb ids stay bounded by the
// tree's peak handler count instead of growing every frame).
//
// The durable closure registered here is the framework's event driver: it runs
// the widget's current handler (which only MUTATES app state) and then asks the
// framework to re-render (`__flSchedule`). This "handler mutates, framework
// renders" split is exactly VReact's setState → drain model, and it is load
// bearing: the durable closure is created once at top level, so the re-render's
// `view`-method call is never lexically inside a dispatch-time closure — the one
// shape that trips the front-end's closure capture on a resumed turn.
function __flSlot(view, fn) {
  let idx = view._hidx;
  view._hidx = idx + 1;
  if (idx < view._handlers.length) {
    view._handlers[idx] = fn;
    return view._cbids[idx];
  }
  view._handlers.push(fn);
  let cbid = __gdRegisterCb(function (a) {
    let handler = view._handlers[idx];
    if (handler != null) {
      handler(a);
    }
    __flSchedule(view);
  });
  view._cbids.push(cbid);
  return cbid;
}

// Coalesce a re-render: mark the view dirty and, if no flush is already queued,
// schedule ONE on the VM event loop. Many events in a turn collapse to a single
// reify + `flutter.op` crossing at the next microtask.
function __flSchedule(view) {
  if (view._scheduled) {
    return;
  }
  view._scheduled = true;
  __later(function () {
    view._scheduled = false;
    __flFlush(view);
  });
}

// The framework render step: build the tree from the app's builder, reify it,
// and ship it. A top-level function (never a method reached from a dispatch-time
// closure) so the reify's engine crossing runs on solid ground.
function __flFlush(view) {
  if (view.builder == null) {
    return;
  }
  view._hidx = 0;
  let reified = __flReify(view, view.builder());
  askHost("flutter.op", [{ render: view.id, tree: reified }]);
}

// ---------------------------------------------------------------------------
// FLView — one embedded Flutter engine + one surface node in the scene
// ---------------------------------------------------------------------------

class FLView {
  constructor(id, builder) {
    this.id = id;
    this.builder = builder; // () -> root widget tree, called by the framework
    this._handlers = [];
    this._cbids = [];
    this._hidx = 0;
    this._scheduled = false;
  }

  // Request a re-render. Handlers normally never call this — mutating app state
  // and returning is enough, since the framework re-renders after every event —
  // but a state change from OUTSIDE an event (a `GTimer` tick, a network reply)
  // calls `update()` to schedule a coalesced flush.
  update() {
    __flSchedule(this);
  }

  // Flutter-style convenience: run `fn` (mutate state), then re-render.
  setState(fn) {
    if (fn != null) {
      fn();
    }
    __flSchedule(this);
  }

  // Swap the root builder and re-render (e.g. navigate to another screen).
  setBuilder(builder) {
    this.builder = builder;
    __flSchedule(this);
  }

  // Send a raw platform-channel message to the app (escape hatch for custom
  // channels the interpreter app understands).
  call(channel, msg) {
    return __gdUnmarshal(askHost("flutter.op", [{ call: this.id, channel: channel, msg: msg }]));
  }

  // Explicitly drive window metrics (normally the surface node reports these
  // from its own resize/DPI automatically).
  resize(w, h, dpr) {
    return __gdUnmarshal(askHost("flutter.op", [{ resize: this.id, size: [w, h], dpr: dpr }]));
  }

  // Tear down the engine and remove the surface node.
  dispose() {
    delete __flViews["v" + this.id];
    return __gdUnmarshal(askHost("flutter.op", [{ disposeview: this.id }]));
  }
}

// ---------------------------------------------------------------------------
// FL — the facade
// ---------------------------------------------------------------------------

class FL {
  // Mount a Flutter UI under a Godot node `parent` (any GObj in this VM's
  // sandbox). `builder` is a function returning the root widget tree; the
  // framework calls it now and after every event, so a handler need only mutate
  // the state the builder reads. `opts`: { design: [w,h], transparent: bool,
  // gpu: bool }. Returns an FLView. The C++ controller creates the engine and a
  // surface node child of `parent`, so the UI composites over whatever 2D/3D
  // world lives there.
  //
  //     var count = 0;
  //     function App() {
  //       return FL.scaffold({ body: FL.center(FL.column([
  //         FL.text('Taps: ' + count, { size: 32 }),
  //         FL.filledButton('Tap me', function () { count = count + 1; }),
  //       ])) });
  //     }
  //     var view = FL.mount(GD.host(), App, { design: [720, 1280] });
  static mount(parent, builder, opts) {
    let id = __flNextView;
    __flNextView = __flNextView + 1;
    let ref = parent == null ? null : { ref: parent.id };
    askHost("flutter.op", [{ newview: true, def: id, parent: ref, opts: opts == null ? {} : opts }]);
    let view = new FLView(id, builder);
    __flViews["v" + id] = view;
    __flFlush(view); // initial paint
    return view;
  }

  // Raw op escape hatch, symmetrical with GD.op.
  static op(m) {
    return __gdUnmarshal(askHost("flutter.op", [m]));
  }

  // ---- widget sugar (thin: every one is __flEl(type, props, children)) -----
  static el(t, p, c) {
    return __flEl(t, p, c);
  }
  static app(p) {
    return __flEl("MaterialApp", p);
  }
  static scaffold(p) {
    return __flEl("Scaffold", p);
  }
  static appBar(title) {
    return __flEl("AppBar", { title: title });
  }
  static text(s, p) {
    return __flEl("Text", { data: s, style: p == null ? {} : p });
  }
  static column(children) {
    return __flEl("Column", {}, children);
  }
  static row(children) {
    return __flEl("Row", {}, children);
  }
  static stack(children) {
    return __flEl("Stack", {}, children);
  }
  static center(child) {
    return __flEl("Center", {}, [child]);
  }
  static padding(all, child) {
    return __flEl("Padding", { all: all }, [child]);
  }
  static container(p, child) {
    return __flEl("Container", p, child == null ? null : [child]);
  }
  static sizedBox(w, h, child) {
    return __flEl("SizedBox", { width: w, height: h }, child == null ? null : [child]);
  }
  static expanded(child) {
    return __flEl("Expanded", {}, [child]);
  }
  static listView(children) {
    return __flEl("ListView", {}, children);
  }
  static image(src, p) {
    return __flEl("Image", { src: src, opts: p == null ? {} : p });
  }
  static icon(name, p) {
    return __flEl("Icon", { name: name, opts: p == null ? {} : p });
  }
  static filledButton(label, onTap) {
    return __flEl("FilledButton", { label: label, onTap: onTap });
  }
  static textButton(label, onTap) {
    return __flEl("TextButton", { label: label, onTap: onTap });
  }
  static iconButton(name, onTap) {
    return __flEl("IconButton", { name: name, onTap: onTap });
  }
  static textField(p) {
    return __flEl("TextField", p == null ? {} : p);
  }
  static switchTile(value, onChanged) {
    return __flEl("Switch", { value: value, onChanged: onChanged });
  }
  static slider(value, onChanged, p) {
    let props = p == null ? {} : p;
    props.value = value;
    props.onChanged = onChanged;
    return __flEl("Slider", props);
  }
}
