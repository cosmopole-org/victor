// =============================================================================
// react.js — VReact: a React-compatible runtime for the Victor engine.
// =============================================================================
//
// The third guest library in the stack. Composed AFTER `godot.js` (the engine
// bridge) and `ui.js` (the VUI widget kit), it turns the Elpian VM into a
// React renderer whose "DOM" is the retained Godot scene graph:
//
//     import 'godot.js';
//     import 'ui.js';
//     import 'react.js';
//
//     function Counter(props) {
//       let s = useState(0);
//       let n = s[0]; let set = s[1];
//       return _jsxs("column", { gap: 16, children: [
//         _jsx("heading", { children: "Count: " + n }),
//         _jsx("button", { onPress: () => { set(n + 1); }, children: "Increment" }),
//       ]});
//     }
//     VictorClient.mountApp(_jsx(Counter, {}), { portrait: true });
//
// A developer never writes those `_jsx(...)` calls by hand: they author an
// ordinary Next.js + React project (JSX, hooks, components) and the Victor
// toolchain (`templates/victor-nextjs/tools/build.mjs`) transpiles the JSX with
// Babel's automatic runtime and flattens the modules into the single-file guest
// program the composer expects. This file is the runtime those programs call
// into. It is authored entirely in the `js2elpian` subset — so, like `ui.js`,
// it is user-space code with no privileged access.
//
// ## What it is (and is not)
//
// VReact is a faithful, from-scratch reimplementation of React's *programming
// model* — element factory, function components, the full hook surface, and a
// keyed reconciler that mutates retained host nodes — NOT a port of Facebook's
// `react` + `react-reconciler` packages. Those packages cannot run here: they
// rely on `Object.assign`, spread, generators, `Map`/`Set`, prototypes and a
// dozen other constructs the no-JIT Elpian bytecode subset does not model (see
// the subset chapter in `js2elpian/src/lib.rs`). VReact stands to React exactly
// as Preact does: same public API and semantics, an independent, tiny core.
// A component written against VReact IS ordinary React — the hook rules, the
// deps arrays, the reconciliation guarantees all hold.
//
// ## The rendering model
//
// React's host config here targets Godot `Control` nodes instead of the DOM.
// Every intrinsic element (`"column"`, `"text"`, `"button"`, `"input"`, …, plus
// the web aliases `"div"`, `"span"`, `"img"`, …) is a *host driver* that
// creates a real retained Godot node, patches its properties on update, and
// routes its signals back into event props. The reconciler diffs the element
// tree on each render and applies the minimal set of node mutations — Godot
// paints the retained scene; the VM only reacts. Event handlers are bound once
// through a stable indirection (the baked signal closure reads the *current*
// prop off the persistent instance), so re-renders never re-wire signals.
//
// ## The honest constraints of the subset (documented, not hidden)
//
//   * There is no first-class null: an absent value reads as 0 and `x == null`
//     is also true for a numeric 0. A literal numeric `0` therefore cannot be
//     rendered as a text child (React would render "0") — use `"" + n` or a
//     string. Every other value renders normally.
//   * Deps arrays are compared with `==` (the VM lowers `===` to it), i.e.
//     value identity for scalars and reference identity for objects — the same
//     contract as `Object.is` for the cases apps rely on.
//   * A single `<Context.Provider>` per context is supported app-wide; nesting
//     two providers of the *same* context with different values is not (the
//     value lives on the context object). Distinct contexts nest freely.
//
// Everything else — the hooks, keys, fragments, refs, effects and their
// cleanup ordering — behaves as you expect from React.

// ---------------------------------------------------------------------------
// element model
// ---------------------------------------------------------------------------

// A VReact element. Tagged so the reconciler can tell an element apart from an
// arbitrary props map or a plain value child.
var __VR_ELEMENT = "__vreact_element__";
var __VR_FRAGMENT = "__vreact_fragment__";
var __VR_PORTAL = "__vreact_portal__";

function __vrIsElement(x) {
  if (__isType(x, "Map")) {
    return x[__VR_ELEMENT] == true;
  }
  return false;
}

// The JSX automatic-runtime entry points. Babel lowers `<tag .../>` to
// `_jsx(type, props, key)` and `<tag>{a}{b}</tag>` to `_jsxs(...)`; both land
// here. `children` already lives inside `props`, so there are no variadic
// arguments (which the subset could not express).
function jsx(type, props, key) {
  let p = props;
  if (p == null) {
    p = {};
  }
  return {
    __vreact_element__: true,
    type: type,
    props: p,
    key: key == null ? null : key,
    ref: p.ref == null ? null : p.ref,
  };
}

// `_jsxs` is `_jsx` with an array `children`; the reconciler flattens both, so
// they share one implementation.
function jsxs(type, props, key) {
  return jsx(type, props, key);
}

// Classic `React.createElement(type, props, childrenArray)` — provided for
// programmatic construction. The JSX transform uses the automatic runtime
// above; this variant takes children as a single array (no rest params).
function createElement(type, props, children) {
  let p = props;
  if (p == null) {
    p = {};
  }
  if (children != null) {
    p.children = children;
  }
  return jsx(type, p, p.key);
}

// Aliases Babel's automatic runtime references verbatim (it emits `_jsx`,
// `_jsxs`, `_jsxDEV`, `_Fragment`). Defining them as globals here means the
// stripped `import … from "react/jsx-runtime"` lines resolve to the runtime.
var _jsx = jsx;
var _jsxs = jsxs;
var _jsxDEV = jsx;
var Fragment = __VR_FRAGMENT;
var _Fragment = __VR_FRAGMENT;

// ---------------------------------------------------------------------------
// runtime state: current fiber, scheduler queues, effect queues
// ---------------------------------------------------------------------------

// The instance currently rendering (the hook dispatch target) and its hook
// cursor. React's "rules of hooks" hold because dispatch is index-based.
var __vrCur = null;
var __vrHookIndex = 0;

// Instances marked dirty by a setState/dispatch, drained on the next microtask.
var __vrDirty = [];
var __vrFlushScheduled = false;

// Effects whose deps changed this commit, run after the tree is mutated.
var __vrPendingEffects = [];
var __vrEffectsScheduled = false;

// Monotonic id source for useId().
var __vrIdSeq = 0;

// True while a commit is mutating the tree — setState during this phase is
// coalesced into the same flush rather than starting a nested one.
var __vrRendering = false;

// ---------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------

function __vrScheduleUpdate(inst) {
  // Mark and enqueue once; the flush dedupes and skips instances whose
  // ancestor is already scheduled.
  if (inst.dirty == true) {
    return;
  }
  inst.dirty = true;
  __vrDirty.push(inst);
  if (!__vrFlushScheduled) {
    __vrFlushScheduled = true;
    __later(__vrFlush);
  }
}

function __vrFlush() {
  __vrFlushScheduled = false;
  // Drain the dirty set. setState inside a render re-enqueues, so loop until
  // the queue is empty (bounded in practice by the app's convergence).
  let guard = 0;
  while (__vrDirty.length > 0 && guard < 10000) {
    guard = guard + 1;
    let work = __vrDirty;
    __vrDirty = [];
    for (let i = 0; i < work.length; i++) {
      let inst = work[i];
      if (inst.dirty == true && inst.alive == true) {
        inst.dirty = false;
        __vrRerender(inst);
      } else {
        inst.dirty = false;
      }
    }
  }
  __vrScheduleEffects();
}

function __vrRerender(inst) {
  __vrRendering = true;
  __vrRenderComponent(inst);
  // A re-rendered component may have changed how many host nodes it produces;
  // re-sync the nearest host container so ordering/insertion stays correct.
  __vrSyncFrom(inst.hostContainer);
  __vrRendering = false;
}

// ---------------------------------------------------------------------------
// deps comparison (shared by useEffect / useMemo / useCallback / …)
// ---------------------------------------------------------------------------

function __vrDepsEqual(a, b) {
  // A null deps array means "no deps given" → always stale (re-run).
  if (a == null) {
    return false;
  }
  if (b == null) {
    return false;
  }
  if (a.length != b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

function __vrHook(initialiser) {
  let inst = __vrCur;
  let idx = __vrHookIndex;
  __vrHookIndex = idx + 1;
  // Hooks are visited in a stable order, so a slot is new exactly when the
  // cursor reaches the end of the list. (An out-of-bounds array read does not
  // return null in the VM, so length — not a null check — is the reliable
  // "not yet created" test.)
  if (idx < inst.hooks.length) {
    return inst.hooks[idx];
  }
  let h = initialiser();
  inst.hooks.push(h);
  return h;
}

function useState(initial) {
  let inst = __vrCur;
  let make = () => {
    let v = initial;
    if (__isType(initial, "Function")) {
      v = initial();
    }
    let hook = { state: v, setState: null };
    hook.setState = (next) => {
      let value = next;
      if (__isType(next, "Function")) {
        value = next(hook.state);
      }
      if (hook.state != value) {
        hook.state = value;
        __vrScheduleUpdate(inst);
      }
    };
    return hook;
  };
  let h = __vrHook(make);
  let out = [];
  out.push(h.state);
  out.push(h.setState);
  return out;
}

function useReducer(reducer, initialArg, init) {
  let inst = __vrCur;
  let make = () => {
    let s = initialArg;
    if (init != null && __isType(init, "Function")) {
      s = init(initialArg);
    }
    let hook = { state: s, dispatch: null };
    hook.dispatch = (action) => {
      let value = reducer(hook.state, action);
      if (hook.state != value) {
        hook.state = value;
        __vrScheduleUpdate(inst);
      }
    };
    return hook;
  };
  let h = __vrHook(make);
  let out = [];
  out.push(h.state);
  out.push(h.dispatch);
  return out;
}

function useRef(initial) {
  let h = __vrHook(() => {
    return { current: initial };
  });
  return h;
}

function useMemo(factory, deps) {
  let h = __vrHook(() => {
    return { value: null, deps: null, primed: false };
  });
  if (!h.primed || !__vrDepsEqual(h.deps, deps)) {
    h.value = factory();
    h.deps = deps;
    h.primed = true;
  }
  return h.value;
}

function useCallback(fn, deps) {
  let h = __vrHook(() => {
    return { value: null, deps: null, primed: false };
  });
  if (!h.primed || !__vrDepsEqual(h.deps, deps)) {
    h.value = fn;
    h.deps = deps;
    h.primed = true;
  }
  return h.value;
}

// Effects (passive) and layout effects. Both register a job that the commit
// phase runs after the tree is mutated; layout effects run synchronously at the
// end of the commit, passive effects on the following microtask. Here they
// share the queue and the microtask drain (documented approximation — the
// cleanup/re-run ordering that apps depend on is preserved).
function __vrEffectImpl(create, deps, isLayout) {
  let h = __vrHook(() => {
    return { kind: "effect", create: null, cleanup: null, deps: null, pending: false, layout: isLayout };
  });
  h.create = create;
  if (!__vrDepsEqual(h.deps, deps)) {
    h.deps = deps;
    if (!h.pending) {
      h.pending = true;
      __vrPendingEffects.push(h);
    }
  }
}

function useEffect(create, deps) {
  __vrEffectImpl(create, deps, false);
}

function useLayoutEffect(create, deps) {
  __vrEffectImpl(create, deps, true);
}

function useInsertionEffect(create, deps) {
  __vrEffectImpl(create, deps, true);
}

function useImperativeHandle(ref, create, deps) {
  useEffect(() => {
    if (ref != null) {
      if (__isType(ref, "Function")) {
        ref(create());
      } else {
        ref.current = create();
      }
    }
    return () => {
      if (ref != null && !__isType(ref, "Function")) {
        ref.current = null;
      }
    };
  }, deps);
}

function useId() {
  let h = __vrHook(() => {
    __vrIdSeq = __vrIdSeq + 1;
    return { id: "vr-" + __vrIdSeq };
  });
  return h.id;
}

function useSyncExternalStore(subscribe, getSnapshot) {
  let s = useState(() => {
    return getSnapshot();
  });
  let value = s[0];
  let set = s[1];
  useEffect(() => {
    let check = () => {
      set(getSnapshot());
    };
    // Prime once in case the store changed between render and subscribe.
    check();
    let unsub = subscribe(check);
    return () => {
      if (unsub != null && __isType(unsub, "Function")) {
        unsub();
      }
    };
  }, [subscribe]);
  return value;
}

// Concurrent hooks: the Elpian VM renders synchronously, so transitions and
// deferred values resolve immediately — API-compatible, no tearing.
function useTransition() {
  let out = [];
  out.push(false);
  out.push((cb) => {
    if (__isType(cb, "Function")) {
      cb();
    }
  });
  return out;
}

function useDeferredValue(value) {
  return value;
}

function useDebugValue(v) {
  // no-op (devtools hook)
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

function createContext(defaultValue) {
  let ctx = {
    __vrcontext: true,
    _value: defaultValue,
    _default: defaultValue,
    _subs: [],
    Provider: null,
    Consumer: null,
  };
  ctx.Provider = (props) => {
    let v = props.value;
    if (ctx._value != v) {
      ctx._value = v;
      __vrNotifyContext(ctx);
    }
    return props.children;
  };
  ctx.Consumer = (props) => {
    // <Context.Consumer>{value => ...}</Context.Consumer>
    let render = props.children;
    if (__isType(render, "Function")) {
      return render(ctx._value);
    }
    return null;
  };
  return ctx;
}

function useContext(ctx) {
  let inst = __vrCur;
  // Subscribe this instance to future provider updates.
  let subs = ctx._subs;
  let found = false;
  for (let i = 0; i < subs.length; i++) {
    if (subs[i] == inst) {
      found = true;
    }
  }
  if (!found) {
    subs.push(inst);
  }
  return ctx._value;
}

function __vrNotifyContext(ctx) {
  let subs = ctx._subs;
  for (let i = 0; i < subs.length; i++) {
    let inst = subs[i];
    if (inst.alive == true) {
      __vrScheduleUpdate(inst);
    }
  }
}

// ---------------------------------------------------------------------------
// component helpers: memo / forwardRef / StrictMode
// ---------------------------------------------------------------------------

// forwardRef: the wrapped component receives (props, ref). React 19 keeps ref
// in props; we pass it explicitly for the classic two-arg signature.
function forwardRef(render) {
  let wrapper = (props) => {
    return render(props, props.ref);
  };
  return wrapper;
}

// memo: a shallow-props gate implemented purely with hooks (no reconciler
// special-case, no mutation of the function value). When the incoming props are
// shallow-equal to the previous render's, it returns the cached element so the
// subtree reconciles as a no-op.
function memo(component, areEqual) {
  let wrapped = (props) => {
    let last = useRef(null);
    let lastEl = useRef(null);
    if (last.current != null) {
      let same = false;
      if (areEqual != null && __isType(areEqual, "Function")) {
        same = areEqual(last.current, props);
      } else {
        same = __vrShallowEqualProps(last.current, props);
      }
      if (same == true) {
        return lastEl.current;
      }
    }
    last.current = props;
    let el = component(props);
    lastEl.current = el;
    return el;
  };
  return wrapped;
}

var StrictMode = __VR_FRAGMENT;

function __vrShallowEqualProps(a, b) {
  if (a == b) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  let ka = a.keys;
  let kb = b.keys;
  if (ka.length != kb.length) {
    return false;
  }
  for (let i = 0; i < ka.length; i++) {
    let k = ka[i];
    if (a[k] != b[k]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// children normalisation
// ---------------------------------------------------------------------------

// Flatten a children value into a linear array of renderables (elements and
// string text nodes), dropping null / boolean (and, per the subset caveat,
// numeric 0). Numbers become text; arrays flatten recursively.
function __vrNormalize(children) {
  let out = [];
  __vrNormalizeInto(out, children);
  return out;
}

function __vrNormalizeInto(out, ch) {
  if (ch == null) {
    return;
  }
  if (__isType(ch, "bool")) {
    return;
  }
  if (__isType(ch, "List")) {
    for (let i = 0; i < ch.length; i++) {
      __vrNormalizeInto(out, ch[i]);
    }
    return;
  }
  if (__isType(ch, "num")) {
    out.push("" + ch);
    return;
  }
  if (__isType(ch, "String")) {
    out.push(ch);
    return;
  }
  // an element (or any other map-shaped value we treat as one)
  out.push(ch);
}

// ---------------------------------------------------------------------------
// instances (the committed tree)
// ---------------------------------------------------------------------------
//
// kind:
//   "roothost" — the synthetic root wrapping the mount container
//   "host"     — an intrinsic element backed by a Godot node
//   "comp"     — a function component (owns hooks)
//   "frag"     — a fragment / provider / array of children
//   "text"     — a raw string, backed by a Label
//
// Shared fields: element, key, kind, childInstances, hostContainer, alive.
// A "host"/"roothost" also has: tag, driver, node, container, attached, props.
// A "comp" also has: fn, hooks, props.
// A "text" also has: node, value.

function __vrElementKey(child) {
  if (__vrIsElement(child)) {
    return child.key;
  }
  return null;
}

function __vrElementType(child) {
  if (__vrIsElement(child)) {
    return child.type;
  }
  return "__text__";
}

// Two children are "the same" (updatable in place) when their type and key
// match. Differing type or key means unmount-and-remount.
function __vrSameType(inst, child) {
  if (inst.kind == "text") {
    return !__vrIsElement(child);
  }
  if (!__vrIsElement(child)) {
    return false;
  }
  return inst.element != null && inst.element.type == child.type;
}

// ---------------------------------------------------------------------------
// mounting
// ---------------------------------------------------------------------------

function __vrMount(child, hostContainer) {
  if (!__vrIsElement(child)) {
    // a text node
    let node = __vrDriverText("" + child);
    return {
      kind: "text",
      value: "" + child,
      node: node,
      childInstances: [],
      hostContainer: hostContainer,
      alive: true,
      element: null,
      key: null,
    };
  }

  let type = child.type;

  if (__isType(type, "Function")) {
    let inst = {
      kind: "comp",
      fn: type,
      element: child,
      props: child.props,
      key: child.key,
      hooks: [],
      childInstances: [],
      hostContainer: hostContainer,
      alive: true,
      dirty: false,
    };
    __vrRenderComponent(inst);
    return inst;
  }

  if (type == __VR_FRAGMENT) {
    let inst = {
      kind: "frag",
      element: child,
      key: child.key,
      childInstances: [],
      hostContainer: hostContainer,
      alive: true,
    };
    __vrReconcileChildren(inst, __vrNormalize(child.props.children), hostContainer);
    return inst;
  }

  // an intrinsic host element
  let inst = {
    kind: "host",
    tag: type,
    element: child,
    props: child.props,
    key: child.key,
    node: null,
    container: null,
    attached: [],
    childInstances: [],
    hostContainer: hostContainer,
    alive: true,
  };
  __vrDriverCreate(inst);
  if (inst.ref == null) {
    inst.ref = child.ref;
  }
  __vrReconcileChildren(inst, __vrNormalize(child.props.children), inst);
  __vrSyncFrom(inst);
  __vrApplyHostRef(inst);
  return inst;
}

function __vrRenderComponent(inst) {
  let fn = inst.fn;
  __vrCur = inst;
  __vrHookIndex = 0;
  let out = fn(inst.props);
  __vrCur = null;
  __vrReconcileChildren(inst, __vrNormalize(out), inst.hostContainer);
}

// ---------------------------------------------------------------------------
// updating
// ---------------------------------------------------------------------------

function __vrUpdate(inst, child, hostContainer) {
  if (!__vrSameType(inst, child)) {
    // replace: unmount the old subtree, mount a fresh one
    __vrUnmount(inst);
    return __vrMount(child, hostContainer);
  }

  if (inst.kind == "text") {
    let v = "" + child;
    if (inst.value != v) {
      inst.value = v;
      inst.node.set("text", v);
    }
    return inst;
  }

  if (inst.kind == "comp") {
    inst.element = child;
    inst.props = child.props;
    __vrRenderComponent(inst);
    return inst;
  }

  if (inst.kind == "frag") {
    inst.element = child;
    __vrReconcileChildren(inst, __vrNormalize(child.props.children), hostContainer);
    return inst;
  }

  // host
  let oldProps = inst.props;
  inst.element = child;
  inst.props = child.props;
  __vrDriverUpdate(inst, oldProps, child.props);
  __vrReconcileChildren(inst, __vrNormalize(child.props.children), inst);
  __vrSyncFrom(inst);
  if (inst.ref != child.ref) {
    inst.ref = child.ref;
    __vrApplyHostRef(inst);
  }
  return inst;
}

// ---------------------------------------------------------------------------
// child reconciliation (keyed, with positional fallback)
// ---------------------------------------------------------------------------

function __vrReconcileChildren(parent, newChildren, hostContainer) {
  let old = parent.childInstances;
  let used = [];
  for (let i = 0; i < old.length; i++) {
    used.push(false);
  }
  let matched = [];
  for (let i = 0; i < newChildren.length; i++) {
    matched.push(-1);
  }

  // Pass 1 — keyed matches.
  for (let i = 0; i < newChildren.length; i++) {
    let key = __vrElementKey(newChildren[i]);
    if (key != null) {
      for (let j = 0; j < old.length; j++) {
        if (!used[j] && old[j].key == key && __vrSameType(old[j], newChildren[i])) {
          matched[i] = j;
          used[j] = true;
          j = old.length;
        }
      }
    }
  }

  // Pass 2 — positional matches for the still-unmatched, keyless children.
  let cursor = 0;
  for (let i = 0; i < newChildren.length; i++) {
    if (matched[i] < 0 && __vrElementKey(newChildren[i]) == null) {
      while (cursor < old.length && (used[cursor] || old[cursor].key != null)) {
        cursor = cursor + 1;
      }
      if (cursor < old.length && __vrSameType(old[cursor], newChildren[i])) {
        matched[i] = cursor;
        used[cursor] = true;
        cursor = cursor + 1;
      }
    }
  }

  // Build the next child-instance list.
  let next = [];
  for (let i = 0; i < newChildren.length; i++) {
    if (matched[i] >= 0) {
      let inst = old[matched[i]];
      next.push(__vrUpdate(inst, newChildren[i], hostContainer));
    } else {
      next.push(__vrMount(newChildren[i], hostContainer));
    }
  }

  // Unmount everything left over.
  for (let j = 0; j < old.length; j++) {
    if (!used[j]) {
      __vrUnmount(old[j]);
    }
  }

  parent.childInstances = next;
}

// ---------------------------------------------------------------------------
// unmounting
// ---------------------------------------------------------------------------

function __vrUnmount(inst) {
  inst.alive = false;

  // Run effect cleanups for a component's own hooks (deepest first would be
  // ideal; this order is adequate for the cleanup contract apps rely on).
  if (inst.kind == "comp") {
    let hooks = inst.hooks;
    for (let i = 0; i < hooks.length; i++) {
      let h = hooks[i];
      if (h != null && h.kind == "effect") {
        if (h.cleanup != null && __isType(h.cleanup, "Function")) {
          h.cleanup();
          h.cleanup = null;
        }
      }
    }
  }

  let cs = inst.childInstances;
  for (let i = 0; i < cs.length; i++) {
    __vrUnmount(cs[i]);
  }

  // Free the Godot node backing a host/text instance.
  if (inst.kind == "host" || inst.kind == "text") {
    if (inst.node != null) {
      inst.node.queueFree();
    }
  }
}

// ---------------------------------------------------------------------------
// host-node collection + container synchronisation
// ---------------------------------------------------------------------------

// Collect, in order, the top-level Godot nodes an instance contributes to its
// enclosing host container. Recursion stops at host/text nodes (a host manages
// its own children internally).
function __vrCollect(inst, out) {
  if (inst.kind == "host" || inst.kind == "text") {
    out.push(inst.node);
    return;
  }
  let cs = inst.childInstances;
  for (let i = 0; i < cs.length; i++) {
    __vrCollect(cs[i], out);
  }
}

function __vrSameNodes(a, b) {
  if (a.length != b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

// Reconcile a host instance's container to hold exactly its flattened child
// nodes, in order. Kept nodes are detached and re-appended (Godot preserves
// their state); unmounted nodes were already queue-freed. Skips work entirely
// when the ordered node set is unchanged.
function __vrSyncFrom(hostInst) {
  if (hostInst == null) {
    return;
  }
  let container = hostInst.container;
  if (container == null) {
    return;
  }
  let want = [];
  let cs = hostInst.childInstances;
  for (let i = 0; i < cs.length; i++) {
    __vrCollect(cs[i], want);
  }
  let prev = hostInst.attached;
  if (prev == null) {
    prev = [];
  }
  if (__vrSameNodes(prev, want)) {
    return;
  }
  for (let i = 0; i < prev.length; i++) {
    container.call("remove_child", [prev[i]]);
  }
  for (let i = 0; i < want.length; i++) {
    container.call("add_child", [want[i]]);
  }
  hostInst.attached = want;
}

// ---------------------------------------------------------------------------
// refs on host elements
// ---------------------------------------------------------------------------

function __vrApplyHostRef(inst) {
  let ref = inst.ref;
  if (ref == null) {
    return;
  }
  if (__isType(ref, "Function")) {
    ref(inst.node);
  } else {
    ref.current = inst.node;
  }
}

// ---------------------------------------------------------------------------
// effect commit
// ---------------------------------------------------------------------------

function __vrScheduleEffects() {
  if (__vrPendingEffects.length == 0) {
    return;
  }
  if (!__vrEffectsScheduled) {
    __vrEffectsScheduled = true;
    __later(__vrRunEffects);
  }
}

function __vrRunEffects() {
  __vrEffectsScheduled = false;
  let q = __vrPendingEffects;
  __vrPendingEffects = [];
  for (let i = 0; i < q.length; i++) {
    let h = q[i];
    if (h.pending == true) {
      h.pending = false;
      if (h.cleanup != null && __isType(h.cleanup, "Function")) {
        h.cleanup();
        h.cleanup = null;
      }
      let c = h.create();
      if (c != null && __isType(c, "Function")) {
        h.cleanup = c;
      } else {
        h.cleanup = null;
      }
    }
  }
}

// ===========================================================================
// HOST DRIVERS — the React "host config": intrinsic tags → Godot Control nodes
// ===========================================================================
//
// Each host instance gets a `node` (the outer node attached to its parent) and
// a `container` (the node its children attach into — often the same node; for
// padded/scroll wrappers it is an inner box). Leaves have `container == null`.
// Drivers reuse VUI's theme + style helpers so React output matches the kit.

// Resolve a colour: a Color passes through, a theme token name maps to the
// active theme, an "#rrggbb"/"#rrggbbaa" string parses via Godot's Color.html.
function __vrColor(v) {
  if (v == null) {
    return null;
  }
  if (__isType(v, "Color")) {
    return v;
  }
  let t = VUI.theme();
  if (__isType(v, "String")) {
    if (v == "primary") { return t.primary; }
    if (v == "accent") { return t.accent; }
    if (v == "danger") { return t.danger; }
    if (v == "success") { return t.success; }
    if (v == "warning") { return t.warning; }
    if (v == "info") { return t.info; }
    if (v == "text") { return t.text; }
    if (v == "textDim" || v == "muted") { return t.textDim; }
    if (v == "surface") { return t.surface; }
    if (v == "bg") { return t.bg; }
    return __vrColorHtml(v);
  }
  return null;
}

// Parse "#rrggbb" via the engine (the subset has no hex literals; Color.html
// does the work over the bridge).
function __vrColorHtml(hex) {
  let r = GD.eval("Color.html(h)", ["h"], [hex]);
  if (GD.isError(r)) {
    return VUI.theme().text;
  }
  return r;
}

// Call a possibly-absent event prop with an argument.
function __vrCall(fn, arg) {
  if (fn != null && __isType(fn, "Function")) {
    fn(arg);
  }
}

function __vrCall0(fn) {
  if (fn != null && __isType(fn, "Function")) {
    fn();
  }
}

// Read a numeric prop with a default (the subset's `??` also defaults 0).
function __vrNum(v, d) {
  if (__isType(v, "num")) {
    return v;
  }
  return d;
}

// The subset of style-object keys we understand (so `style={{...}}` from an
// ordinary React component maps onto Godot properties).
function __vrApplyStyle(inst, style) {
  if (style == null) {
    return;
  }
  let node = inst.node;
  if (style.width != null) {
    __vrSetMinSize(node, __vrNum(style.width, 0.0), -1.0);
  }
  if (style.height != null) {
    __vrSetMinSize(node, -1.0, __vrNum(style.height, 0.0));
  }
  if (style.flexGrow != null && style.flexGrow != 0) {
    node.set("size_flags_horizontal", GInt(3));
    node.set("size_flags_vertical", GInt(3));
  }
  if (style.opacity != null) {
    node.set("modulate", new Color(1.0, 1.0, 1.0, __vrNum(style.opacity, 1.0)));
  }
  if (style.backgroundColor != null && inst.container != null) {
    let c = __vrColor(style.backgroundColor);
    if (c != null) {
      __vrSetPanelBg(inst, c);
    }
  }
}

function __vrSetMinSize(node, w, h) {
  let cur = node.get("custom_minimum_size");
  let cw = 0.0;
  let chh = 0.0;
  if (__isType(cur, "Vector2")) {
    cw = cur.x;
    chh = cur.y;
  }
  if (w >= 0.0) {
    cw = w;
  }
  if (h >= 0.0) {
    chh = h;
  }
  node.set("custom_minimum_size", new Vector2(cw, chh));
}

function __vrSetPanelBg(inst, color) {
  // Only meaningful when the outer node is a Panel/PanelContainer.
  inst.node.set("theme_override_styles/panel", VUI.styleBox({ bg: color, radius: VUI.theme().radiusM }));
}

// ---- the text driver (raw string children + <text>/<span>/<p>) -------------

function __vrDriverText(str) {
  let t = VUI.theme();
  let l = GD.create("Label");
  l.set("text", "" + str);
  l.set("theme_override_font_sizes/font_size", GInt(t.fontM));
  l.set("theme_override_colors/font_color", t.text);
  return l;
}

// ---- collect a text value out of children (for <text>, <button>, …) --------

function __vrTextOf(props) {
  let kids = __vrNormalize(props.children);
  let s = "";
  for (let i = 0; i < kids.length; i++) {
    if (!__vrIsElement(kids[i])) {
      s = s + kids[i];
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// driver dispatch
// ---------------------------------------------------------------------------

// Container tags whose element children become real child instances. Everything
// else is a leaf whose text children collapse into a string.
function __vrIsContainerTag(tag) {
  if (tag == "view") { return true; }
  if (tag == "div") { return true; }
  if (tag == "column") { return true; }
  if (tag == "vstack") { return true; }
  if (tag == "row") { return true; }
  if (tag == "hstack") { return true; }
  if (tag == "stack") { return true; }
  if (tag == "scroll") { return true; }
  if (tag == "center") { return true; }
  if (tag == "panel") { return true; }
  if (tag == "card") { return true; }
  if (tag == "grid") { return true; }
  if (tag == "section") { return true; }
  if (tag == "main") { return true; }
  if (tag == "header") { return true; }
  if (tag == "footer") { return true; }
  if (tag == "nav") { return true; }
  if (tag == "ul") { return true; }
  if (tag == "ol") { return true; }
  if (tag == "li") { return true; }
  return false;
}

function __vrDriverCreate(inst) {
  let tag = inst.tag;
  let props = inst.props;
  let t = VUI.theme();

  if (__vrIsContainerTag(tag)) {
    __vrCreateContainer(inst, tag, props, t);
    return;
  }

  // ----- leaves -----
  if (tag == "text" || tag == "span" || tag == "p" || tag == "label" || tag == "paragraph") {
    let l = GD.create("Label");
    inst.node = l;
    inst.container = null;
    __vrApplyTextProps(inst, null, props, t.fontM, false);
    return;
  }
  if (tag == "heading" || tag == "h1" || tag == "h2" || tag == "h3" || tag == "title") {
    let size = t.fontXL;
    if (tag == "h2" || tag == "title") { size = t.fontL; }
    if (tag == "h3") { size = t.fontM; }
    let l = GD.create("Label");
    inst.node = l;
    inst.container = null;
    __vrApplyTextProps(inst, null, props, size, false);
    return;
  }
  if (tag == "caption" || tag == "small" || tag == "muted") {
    let l = GD.create("Label");
    inst.node = l;
    inst.container = null;
    __vrApplyTextProps(inst, null, props, t.fontXS, true);
    return;
  }
  if (tag == "icon") {
    let l = GD.create("Label");
    inst.node = l;
    inst.container = null;
    l.set("horizontal_alignment", GInt(1));
    __vrApplyTextProps(inst, null, props, __vrNum(props.size, t.fontL), false);
    return;
  }
  if (tag == "button") {
    __vrCreateButton(inst, props, t);
    return;
  }
  if (tag == "input" || tag == "field" || tag == "textinput") {
    __vrCreateField(inst, props, t);
    return;
  }
  if (tag == "image" || tag == "img") {
    __vrCreateImage(inst, props, t);
    return;
  }
  if (tag == "progress") {
    __vrCreateProgress(inst, props, t);
    return;
  }
  if (tag == "slider") {
    __vrCreateSlider(inst, props, t);
    return;
  }
  if (tag == "switch" || tag == "toggle") {
    __vrCreateSwitch(inst, props, t);
    return;
  }
  if (tag == "checkbox") {
    __vrCreateCheckbox(inst, props, t);
    return;
  }
  if (tag == "divider" || tag == "hr") {
    __vrCreateDivider(inst, props, t);
    return;
  }
  if (tag == "spacer") {
    let c = GD.create("Control");
    c.set("size_flags_horizontal", GInt(3));
    c.set("size_flags_vertical", GInt(3));
    inst.node = c;
    inst.container = null;
    return;
  }

  // Unknown tag → a plain transparent container so the tree still renders.
  __vrCreateContainer(inst, "view", props, t);
}

function __vrCreateContainer(inst, tag, props, t) {
  let box = null;
  let container = null;
  let outer = null;

  if (tag == "row" || tag == "hstack") {
    box = GD.create("HBoxContainer");
    box.set("theme_override_constants/separation", GInt(__vrNum(props.gap, 16)));
    container = box;
    outer = box;
  } else if (tag == "grid") {
    box = GD.create("GridContainer");
    box.set("columns", GInt(__vrNum(props.cols, 2)));
    let g = __vrNum(props.gap, 16);
    box.set("theme_override_constants/h_separation", GInt(g));
    box.set("theme_override_constants/v_separation", GInt(g));
    container = box;
    outer = box;
  } else if (tag == "scroll") {
    let sc = GD.create("ScrollContainer");
    sc.set("size_flags_horizontal", GInt(3));
    sc.set("size_flags_vertical", GInt(3));
    let inner = GD.create("VBoxContainer");
    inner.set("theme_override_constants/separation", GInt(__vrNum(props.gap, 16)));
    inner.set("size_flags_horizontal", GInt(3));
    sc.call("add_child", [inner]);
    container = inner;
    outer = sc;
  } else if (tag == "center") {
    let c = GD.create("CenterContainer");
    container = c;
    outer = c;
  } else if (tag == "stack") {
    let c = GD.create("Control");
    container = c;
    outer = c;
  } else if (tag == "panel" || tag == "card") {
    let pc = GD.create("PanelContainer");
    let bg = t.surface;
    if (tag == "card") {
      bg = t.surface2;
    }
    if (props.bg != null) {
      let c = __vrColor(props.bg);
      if (c != null) {
        bg = c;
      }
    }
    pc.set("theme_override_styles/panel", VUI.styleBox({ bg: bg, radius: t.radiusL }));
    let inner = GD.create("VBoxContainer");
    inner.set("theme_override_constants/separation", GInt(__vrNum(props.gap, 14)));
    let pad = __vrNum(props.pad, 24);
    let wrap = __vrPad(inner, pad);
    pc.call("add_child", [wrap]);
    container = inner;
    outer = pc;
  } else {
    // view / div / column / vstack / section / …  → a vertical box
    box = GD.create("VBoxContainer");
    box.set("theme_override_constants/separation", GInt(__vrNum(props.gap, 16)));
    container = box;
    outer = box;
  }

  // Optional padding wrapper for the simple box containers.
  if (props.pad != null && (tag != "panel" && tag != "card")) {
    let wrap = __vrPad(container, __vrNum(props.pad, 0));
    outer = wrap;
  }

  inst.node = outer;
  inst.container = container;

  if (props.grow == true || props.expand == true) {
    outer.set("size_flags_horizontal", GInt(3));
    outer.set("size_flags_vertical", GInt(3));
  }
  __vrApplyStyle(inst, props.style);
}

function __vrPad(inner, pad) {
  if (pad == null || pad == 0) {
    return inner;
  }
  let m = GD.create("MarginContainer");
  m.set("theme_override_constants/margin_left", GInt(pad));
  m.set("theme_override_constants/margin_top", GInt(pad));
  m.set("theme_override_constants/margin_right", GInt(pad));
  m.set("theme_override_constants/margin_bottom", GInt(pad));
  m.call("add_child", [inner]);
  return m;
}

// ---- text props (shared by text/heading/caption/icon) ----------------------

function __vrApplyTextProps(inst, oldProps, props, defaultSize, dim) {
  let t = VUI.theme();
  let l = inst.node;
  l.set("text", __vrTextOf(props));
  l.set("theme_override_font_sizes/font_size", GInt(__vrNum(props.size, defaultSize)));
  let color = __vrColor(props.color);
  if (color == null) {
    color = t.text;
    if (dim == true || props.dim == true) {
      color = t.textDim;
    }
  }
  l.set("theme_override_colors/font_color", color);
  if (props.align == "center") {
    l.set("horizontal_alignment", GInt(1));
  } else if (props.align == "right") {
    l.set("horizontal_alignment", GInt(2));
  } else if (props.align == "left") {
    l.set("horizontal_alignment", GInt(0));
  }
  if (props.wrap == true) {
    l.set("autowrap_mode", GInt(3));
    l.set("size_flags_horizontal", GInt(3));
  }
  if (props.grow == true || props.expand == true) {
    l.set("size_flags_horizontal", GInt(3));
  }
}

// ---- button ----------------------------------------------------------------

function __vrCreateButton(inst, props, t) {
  let b = GD.create("Button");
  inst.node = b;
  inst.container = null;
  b.set("focus_mode", GInt(0));
  __vrStyleButton(b, props, t);
  b.set("text", __vrTextOf(props));
  b.set("theme_override_font_sizes/font_size", GInt(__vrNum(props.fontSize, t.fontS)));
  __vrSetMinSize(b, __vrNum(props.minWidth, 0.0), __vrNum(props.height, t.controlHeight));
  if (props.wide == true || props.grow == true) {
    b.set("size_flags_horizontal", GInt(3));
  }
  // Stable signal binding: the closure reads the CURRENT prop off `inst`.
  b.connect("pressed", (a) => {
    let p = inst.props;
    __vrCall0(p.onPress);
    __vrCall0(p.onClick);
    __vrCall0(p.onTap);
  });
}

function __vrStyleButton(b, props, t) {
  let kind = props.kind;
  if (kind == null) {
    kind = "filled";
  }
  let radius = __vrNum(props.radius, t.radiusM);
  let padX = 36;
  if (kind == "filled") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.primary, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.primary.lighter(0.06), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.primary.darker(0.08), radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", t.onPrimary);
    b.set("theme_override_colors/font_hover_color", t.onPrimary);
    b.set("theme_override_colors/font_pressed_color", t.onPrimary);
  } else if (kind == "tonal") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.primaryDim, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.surface3, radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.surface2, radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", t.primary);
    b.set("theme_override_colors/font_hover_color", t.primary);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  } else if (kind == "danger") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.danger, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.danger.lighter(0.06), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.danger.darker(0.1), radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", new Color(1.0, 1.0, 1.0, 1.0));
    b.set("theme_override_colors/font_hover_color", new Color(1.0, 1.0, 1.0, 1.0));
    b.set("theme_override_colors/font_pressed_color", new Color(1.0, 1.0, 1.0, 1.0));
  } else if (kind == "outline") {
    b.set("theme_override_styles/normal", VUI.styleBox({ radius: radius, padX: padX, border: 2, borderColor: t.outline, bg: new Color(0.0, 0.0, 0.0, 0.0) }));
    b.set("theme_override_styles/hover", VUI.styleBox({ radius: radius, padX: padX, border: 2, borderColor: t.primary, bg: t.primaryDim }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ radius: radius, padX: padX, border: 2, borderColor: t.primary, bg: t.primaryDim }));
    b.set("theme_override_colors/font_color", t.text);
    b.set("theme_override_colors/font_hover_color", t.primary);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  } else {
    b.set("theme_override_styles/normal", VUI.styleEmpty());
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.surface2, radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.surface3, radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", t.primary);
    b.set("theme_override_colors/font_hover_color", t.primary);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  }
}

// ---- field (text input) ----------------------------------------------------

function __vrCreateField(inst, props, t) {
  let e = GD.create("LineEdit");
  inst.node = e;
  inst.container = null;
  inst.fieldValue = "" + (props.value ?? props.defaultValue ?? "");
  if (props.placeholder != null) {
    e.set("placeholder_text", props.placeholder);
  }
  if (inst.fieldValue != "") {
    e.set("text", inst.fieldValue);
  }
  if (props.obscure == true || props.type == "password") {
    e.set("secret", true);
  }
  e.set("theme_override_font_sizes/font_size", GInt(t.fontS));
  __vrSetMinSize(e, 0.0, t.controlHeight);
  e.set("size_flags_horizontal", GInt(3));
  e.set("theme_override_styles/normal", VUI.styleBox({ bg: t.surface2, radius: t.radiusM, padX: 28, border: 1, borderColor: t.outline }));
  e.set("theme_override_styles/focus", VUI.styleBox({ bg: t.surface2, radius: t.radiusM, padX: 28, border: 2, borderColor: t.primary }));
  e.set("theme_override_colors/font_color", t.text);
  e.set("theme_override_colors/font_placeholder_color", t.textFaint);
  e.set("theme_override_colors/caret_color", t.primary);
  e.connect("text_changed", (a) => {
    inst.fieldValue = a[0];
    __vrCall(inst.props.onChange, a[0]);
    __vrCall(inst.props.onChanged, a[0]);
  });
  e.connect("text_submitted", (a) => {
    inst.fieldValue = a[0];
    __vrCall(inst.props.onSubmit, a[0]);
  });
}

// ---- image -----------------------------------------------------------------

function __vrCreateImage(inst, props, t) {
  let r = GD.create("TextureRect");
  inst.node = r;
  inst.container = null;
  r.set("expand_mode", GInt(1));
  r.set("stretch_mode", GInt(5));
  let src = props.src ?? props.url;
  if (src != null) {
    let tex = GD.load(src);
    if (!GD.isError(tex)) {
      r.set("texture", tex);
    }
  }
  __vrSetMinSize(r, __vrNum(props.width, 0.0), __vrNum(props.height, 0.0));
}

// ---- progress --------------------------------------------------------------

function __vrCreateProgress(inst, props, t) {
  let p = GD.create("ProgressBar");
  inst.node = p;
  inst.container = null;
  p.set("min_value", GFloat(0.0));
  p.set("max_value", GFloat(__vrNum(props.max, 100.0)));
  p.set("value", GFloat(__vrNum(props.value, 0.0)));
  p.set("show_percentage", false);
  __vrSetMinSize(p, 0.0, 18.0);
  p.set("size_flags_horizontal", GInt(3));
}

// ---- slider ----------------------------------------------------------------

function __vrCreateSlider(inst, props, t) {
  let s = GD.create("HSlider");
  inst.node = s;
  inst.container = null;
  s.set("min_value", GFloat(__vrNum(props.min, 0.0)));
  s.set("max_value", GFloat(__vrNum(props.max, 100.0)));
  s.set("step", GFloat(__vrNum(props.step, 1.0)));
  s.set("value", GFloat(__vrNum(props.value, 0.0)));
  __vrSetMinSize(s, 0.0, t.controlHeight);
  s.set("size_flags_horizontal", GInt(3));
  s.connect("value_changed", (a) => {
    __vrCall(inst.props.onChange, a[0]);
    __vrCall(inst.props.onChanged, a[0]);
  });
}

// ---- switch / checkbox -----------------------------------------------------

function __vrCreateSwitch(inst, props, t) {
  let c = GD.create("CheckButton");
  inst.node = c;
  inst.container = null;
  c.set("focus_mode", GInt(0));
  c.set("button_pressed", props.checked == true || props.value == true);
  c.set("text", __vrTextOf(props));
  c.set("theme_override_font_sizes/font_size", GInt(t.fontS));
  c.connect("toggled", (a) => {
    __vrCall(inst.props.onChange, a[0]);
    __vrCall(inst.props.onChanged, a[0]);
  });
}

function __vrCreateCheckbox(inst, props, t) {
  let c = GD.create("CheckBox");
  inst.node = c;
  inst.container = null;
  c.set("focus_mode", GInt(0));
  c.set("button_pressed", props.checked == true || props.value == true);
  c.set("text", __vrTextOf(props));
  c.set("theme_override_font_sizes/font_size", GInt(t.fontS));
  c.connect("toggled", (a) => {
    __vrCall(inst.props.onChange, a[0]);
    __vrCall(inst.props.onChanged, a[0]);
  });
}

// ---- divider ---------------------------------------------------------------

function __vrCreateDivider(inst, props, t) {
  let d = GD.create("Panel");
  inst.node = d;
  inst.container = null;
  __vrSetMinSize(d, 0.0, __vrNum(props.thickness, 2.0));
  d.set("size_flags_horizontal", GInt(3));
  d.set("theme_override_styles/panel", VUI.styleBox({ bg: t.outline, radius: 2 }));
}

// ---------------------------------------------------------------------------
// driver update: patch a host node's props in place
// ---------------------------------------------------------------------------

function __vrDriverUpdate(inst, oldProps, props) {
  let tag = inst.tag;
  let t = VUI.theme();

  if (__vrIsContainerTag(tag)) {
    if (props.grow == true || props.expand == true) {
      inst.node.set("size_flags_horizontal", GInt(3));
      inst.node.set("size_flags_vertical", GInt(3));
    }
    if (tag == "grid" && props.cols != oldProps.cols) {
      inst.container.set("columns", GInt(__vrNum(props.cols, 2)));
    }
    __vrApplyStyle(inst, props.style);
    return;
  }

  if (tag == "text" || tag == "span" || tag == "p" || tag == "label" || tag == "paragraph") {
    __vrApplyTextProps(inst, oldProps, props, VUI.theme().fontM, false);
    return;
  }
  if (tag == "heading" || tag == "h1" || tag == "h2" || tag == "h3" || tag == "title") {
    __vrApplyTextProps(inst, oldProps, props, VUI.theme().fontXL, false);
    return;
  }
  if (tag == "caption" || tag == "small" || tag == "muted") {
    __vrApplyTextProps(inst, oldProps, props, VUI.theme().fontXS, true);
    return;
  }
  if (tag == "icon") {
    __vrApplyTextProps(inst, oldProps, props, __vrNum(props.size, t.fontL), false);
    return;
  }
  if (tag == "button") {
    inst.node.set("text", __vrTextOf(props));
    if (props.kind != oldProps.kind) {
      __vrStyleButton(inst.node, props, t);
    }
    if (props.disabled != oldProps.disabled) {
      inst.node.set("disabled", props.disabled == true);
    }
    return;
  }
  if (tag == "input" || tag == "field" || tag == "textinput") {
    // Controlled input: push value when the prop diverges from the widget.
    if (props.value != null && ("" + props.value) != inst.fieldValue) {
      inst.fieldValue = "" + props.value;
      inst.node.set("text", inst.fieldValue);
    }
    if (props.placeholder != oldProps.placeholder && props.placeholder != null) {
      inst.node.set("placeholder_text", props.placeholder);
    }
    return;
  }
  if (tag == "image" || tag == "img") {
    let src = props.src ?? props.url;
    let osrc = oldProps.src ?? oldProps.url;
    if (src != null && src != osrc) {
      let tex = GD.load(src);
      if (!GD.isError(tex)) {
        inst.node.set("texture", tex);
      }
    }
    return;
  }
  if (tag == "progress") {
    inst.node.set("max_value", GFloat(__vrNum(props.max, 100.0)));
    inst.node.set("value", GFloat(__vrNum(props.value, 0.0)));
    return;
  }
  if (tag == "slider") {
    inst.node.set("max_value", GFloat(__vrNum(props.max, 100.0)));
    inst.node.set("min_value", GFloat(__vrNum(props.min, 0.0)));
    if (props.value != oldProps.value) {
      inst.node.set("value", GFloat(__vrNum(props.value, 0.0)));
    }
    return;
  }
  if (tag == "switch" || tag == "toggle" || tag == "checkbox") {
    let on = props.checked == true || props.value == true;
    inst.node.set("button_pressed", on);
    inst.node.set("text", __vrTextOf(props));
    return;
  }
}

// ===========================================================================
// PUBLIC API — the React namespace + the VictorClient renderer entry points
// ===========================================================================

var React = {
  createElement: createElement,
  Fragment: __VR_FRAGMENT,
  StrictMode: __VR_FRAGMENT,
  useState: useState,
  useReducer: useReducer,
  useEffect: useEffect,
  useLayoutEffect: useLayoutEffect,
  useInsertionEffect: useInsertionEffect,
  useRef: useRef,
  useMemo: useMemo,
  useCallback: useCallback,
  useContext: useContext,
  createContext: createContext,
  useImperativeHandle: useImperativeHandle,
  useId: useId,
  useSyncExternalStore: useSyncExternalStore,
  useTransition: useTransition,
  useDeferredValue: useDeferredValue,
  useDebugValue: useDebugValue,
  memo: memo,
  forwardRef: forwardRef,
};

// Render an element tree into an existing Godot container node (a GObj that
// accepts add_child). Returns a root handle with update()/unmount().
function __vrRenderRoot(element, container) {
  let root = {
    kind: "roothost",
    node: container,
    container: container,
    attached: [],
    childInstances: [],
    hostContainer: null,
    alive: true,
    element: null,
  };
  root.hostContainer = root;
  __vrReconcileChildren(root, __vrNormalize(element), root);
  __vrSyncFrom(root);
  __vrScheduleEffects();
  return {
    root: root,
    render: (next) => {
      __vrReconcileChildren(root, __vrNormalize(next), root);
      __vrSyncFrom(root);
      __vrScheduleEffects();
    },
    unmount: () => {
      let cs = root.childInstances;
      for (let i = 0; i < cs.length; i++) {
        __vrUnmount(cs[i]);
      }
      root.childInstances = [];
      __vrSyncFrom(root);
    },
  };
}

// The ReactDOM-equivalent client surface.
var VictorClient = {
  // createRoot(container).render(<App/>)  — the React 18 root API.
  createRoot: (container) => {
    let node = __vuiNode(container);
    let handle = null;
    return {
      render: (element) => {
        if (handle == null) {
          handle = __vrRenderRoot(element, node);
        } else {
          handle.render(element);
        }
      },
      unmount: () => {
        if (handle != null) {
          handle.unmount();
        }
      },
    };
  },

  // Legacy render(<App/>, container).
  render: (element, container) => {
    return __vrRenderRoot(element, __vuiNode(container));
  },

  // The one-call bootstrap the Next.js template's entry uses: set the theme,
  // create the full-screen VUI app (CanvasLayer + page), and mount the React
  // tree into it. Returns { app, root } so callers can reach the VUI app.
  mountApp: (element, options) => {
    let o = options;
    if (o == null) {
      o = {};
    }
    if (o.theme == "light") {
      VUI.use(VUI.themeLight());
    } else {
      VUI.use(VUI.themeDark());
    }
    let app = VUI.app(o);
    // A vertical mount box fills the page so React children stack naturally.
    let mount = GD.create("VBoxContainer");
    mount.set("theme_override_constants/separation", GInt(0));
    app.push(mount);
    let handle = __vrRenderRoot(element, mount);
    return { app: app, root: handle, mount: mount };
  },
};

// A tiny convenience namespace for Victor-specific extras a React app may want
// (theme access, colour parsing, the raw engine + kit if it drops down a level).
var Victor = {
  theme: () => {
    return VUI.theme();
  },
  useTheme: () => {
    // dark by default; the theme object is a plain value
    return VUI.theme();
  },
  color: (v) => {
    return __vrColor(v);
  },
  toast: (msg, o) => {
    VUI.toast(msg, o);
  },
  dialog: (o) => {
    VUI.dialog(o);
  },
  onFrame: (cb) => {
    GD.onProcess(cb);
  },
  interval: (ms, cb) => {
    return GTimer.periodic(ms, cb);
  },
  timeout: (ms, cb) => {
    return GTimer.after(ms, cb);
  },
};

// ---------------------------------------------------------------------------
// primitive components — capitalised host wrappers so a component tree reads
// like React Native (`<View>`, `<Text>`, `<Button>` …) as well as web tags.
// ---------------------------------------------------------------------------

function View(props) { return jsx("view", props); }
function Row(props) { return jsx("row", props); }
function Column(props) { return jsx("column", props); }
function Stack(props) { return jsx("stack", props); }
function Scroll(props) { return jsx("scroll", props); }
function Center(props) { return jsx("center", props); }
function Panel(props) { return jsx("panel", props); }
function Card(props) { return jsx("card", props); }
function Grid(props) { return jsx("grid", props); }
function Text(props) { return jsx("text", props); }
function Heading(props) { return jsx("heading", props); }
function Caption(props) { return jsx("caption", props); }
function Icon(props) { return jsx("icon", props); }
function Button(props) { return jsx("button", props); }
function TextInput(props) { return jsx("input", props); }
function Image(props) { return jsx("image", props); }
function Progress(props) { return jsx("progress", props); }
function Slider(props) { return jsx("slider", props); }
function Switch(props) { return jsx("switch", props); }
function Checkbox(props) { return jsx("checkbox", props); }
function Divider(props) { return jsx("divider", props); }
function Spacer(props) { return jsx("spacer", props); }
