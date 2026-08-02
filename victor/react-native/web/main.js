// src/vm/backend.ts
var WasmBackend = class _WasmBackend {
  ex;
  rt = 0;
  enc = new TextEncoder();
  dec = new TextDecoder();
  constructor(ex) {
    this.ex = ex;
  }
  /**
   * Instantiate `elpian_rn.wasm`. `host` is bound now because the wasm module
   * imports it; it is the dispatcher's `handle`. Works with a raw byte buffer
   * (web/Expo) — native JSI transports implement `VmBackend` directly instead.
   */
  static async instantiate(wasmBytes, host) {
    let ex = null;
    const readStr = (ptr, len) => this_dec(ex).decode(new Uint8Array(ex.memory.buffer, ptr, len));
    const importObject = {
      env: {
        host_call: (namePtr, nameLen, argsPtr, argsLen) => {
          const name = readStr(namePtr, nameLen);
          const argsJson = readStr(argsPtr, argsLen);
          const reply = host(name, argsJson);
          if (reply === null || reply === void 0) return 0;
          return writePrefixed(ex, reply);
        }
      }
    };
    const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
    ex = instance.exports;
    return new _WasmBackend(ex);
  }
  /**
   * Instantiate from an already-**compiled** `WebAssembly.Module`, synchronously.
   * Compiling once (`WebAssembly.compile`) and instantiating per call shares the
   * compiled code across instances while giving each its own linear memory / VM
   * state — the isolation the mini-app manager relies on (a mini app cannot see
   * another's globals; the js2elpian front-end's process-global compile state is
   * per-instance, so independently-compiled programs never collide). See
   * `../miniapps/engine.ts`.
   */
  static fromModule(module, host) {
    let ex = null;
    const readStr = (ptr, len) => SHARED_DECODER.decode(new Uint8Array(ex.memory.buffer, ptr, len));
    const importObject = {
      env: {
        host_call: (namePtr, nameLen, argsPtr, argsLen) => {
          const name = readStr(namePtr, nameLen);
          const argsJson = readStr(argsPtr, argsLen);
          const reply = host(name, argsJson);
          if (reply === null || reply === void 0) return 0;
          return writePrefixed(ex, reply);
        }
      }
    };
    const instance = new WebAssembly.Instance(module, importObject);
    ex = instance.exports;
    return new _WasmBackend(ex);
  }
  create(source, lang, prepend, _host) {
    const src = this.write(source);
    const lg = this.write(lang);
    this.rt = this.ex.elpian_rn_new(src.ptr, src.len, lg.ptr, lg.len, prepend ? 1 : 0);
    this.ex.elpian_rn_free_buf(src.ptr, src.len);
    this.ex.elpian_rn_free_buf(lg.ptr, lg.len);
    if (this.rt === 0) throw new Error(`elpian_rn_new failed: ${this.lastError()}`);
  }
  run() {
    this.ex.elpian_rn_run(this.rt);
  }
  pump(deltaMs) {
    this.ex.elpian_rn_pump(this.rt, BigInt(Math.max(0, Math.round(deltaMs))));
  }
  invoke(fnName, argJson) {
    const fn = this.write(fnName);
    const arg = this.write(argJson);
    this.ex.elpian_rn_invoke(this.rt, fn.ptr, fn.len, arg.ptr, arg.len);
    this.ex.elpian_rn_free_buf(fn.ptr, fn.len);
    this.ex.elpian_rn_free_buf(arg.ptr, arg.len);
  }
  takeLog() {
    const ptr = this.ex.elpian_rn_take_log(this.rt);
    if (ptr === 0) return [];
    const json = this.readPrefixed(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return [];
    }
  }
  stats() {
    const ptr = this.ex.elpian_rn_stats(this.rt);
    if (ptr === 0) return null;
    try {
      return JSON.parse(this.readPrefixed(ptr));
    } catch {
      return null;
    }
  }
  lastError() {
    return this.readPrefixed(this.ex.elpian_rn_last_error());
  }
  free() {
    if (this.rt) {
      this.ex.elpian_rn_free(this.rt);
      this.rt = 0;
    }
  }
  // --- memory helpers ----------------------------------------------------
  write(s) {
    const bytes = this.enc.encode(s);
    const ptr = this.ex.elpian_rn_alloc(bytes.length || 1);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }
  readPrefixed(ptr) {
    if (ptr === 0) return "";
    const view = new DataView(this.ex.memory.buffer);
    const len = view.getUint32(ptr, true);
    const s = this.dec.decode(new Uint8Array(this.ex.memory.buffer, ptr + 4, len));
    this.ex.elpian_rn_free_buf(ptr, 4 + len);
    return s;
  }
};
function this_dec(_ex) {
  return SHARED_DECODER;
}
var SHARED_DECODER = new TextDecoder();
var SHARED_ENCODER = new TextEncoder();
function writePrefixed(ex, s) {
  const bytes = SHARED_ENCODER.encode(s);
  const total = 4 + bytes.length;
  const ptr = ex.elpian_rn_alloc(total);
  const view = new DataView(ex.memory.buffer);
  view.setUint32(ptr, bytes.length, true);
  new Uint8Array(ex.memory.buffer, ptr + 4, bytes.length).set(bytes);
  return ptr;
}

// src/core/protocol.ts
function isRef(v) {
  return !!v && typeof v === "object" && typeof v.ref === "number";
}
function isCb(v) {
  return !!v && typeof v === "object" && typeof v.cb === "number";
}
function wireError(message) {
  return { __dart_error__: message };
}

// src/core/widgetStore.ts
var WidgetStore = class {
  nodes = /* @__PURE__ */ new Map();
  rootId = 0;
  toastMessage = null;
  // App-level observation (root/toast).
  ver = 0;
  listeners = /* @__PURE__ */ new Set();
  appDirty = false;
  // Per-node observation (targeted patching).
  revs = /* @__PURE__ */ new Map();
  nodeListeners = /* @__PURE__ */ new Map();
  dirty = /* @__PURE__ */ new Set();
  // ---- app-level observation -------------------------------------------
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Monotonic app-level version — bumps only on root/toast changes. */
  version() {
    return this.ver;
  }
  // ---- per-node observation --------------------------------------------
  /** Subscribe to changes of a single node (used by its `<WidgetView/>`). */
  subscribeNode(id, fn) {
    let set = this.nodeListeners.get(id);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.nodeListeners.set(id, set);
    }
    set.add(fn);
    return () => {
      const s = this.nodeListeners.get(id);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this.nodeListeners.delete(id);
      }
    };
  }
  /** A node's revision — a cheap identity for React's `useSyncExternalStore`. */
  nodeVersion(id) {
    return this.revs.get(id) ?? 0;
  }
  /** Mark a node as needing a re-render on the next flush. */
  markDirty(id) {
    if (id) this.dirty.add(id);
  }
  /**
   * Coalesced notify: the dispatcher applies a burst of ops then calls `flush()`
   * once per frame. We bump the revision of each touched node and notify only
   * its subscribers; the app-level listeners fire only when root/toast changed.
   */
  flush() {
    if (this.dirty.size) {
      const touched = [...this.dirty];
      this.dirty.clear();
      for (const id of touched) {
        this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
        const set = this.nodeListeners.get(id);
        if (set) for (const fn of set) fn();
      }
    }
    if (this.appDirty) {
      this.appDirty = false;
      this.ver++;
      for (const fn of this.listeners) fn();
    }
  }
  // ---- reads (renderer side) -------------------------------------------
  root() {
    return this.rootId ? this.nodes.get(this.rootId) ?? null : null;
  }
  get(id) {
    return this.nodes.get(id) ?? null;
  }
  /** WidgetSink: read one prop (the guest's `get` op). */
  getProp(id, key) {
    return this.nodes.get(id)?.props[key] ?? null;
  }
  takeToast() {
    const t = this.toastMessage;
    this.toastMessage = null;
    return t;
  }
  // ---- writes (dispatcher side) ----------------------------------------
  create(id, className, owner) {
    const node = {
      id,
      className,
      props: {},
      children: [],
      parent: 0,
      events: {},
      owners: owner ? [owner] : []
    };
    this.nodes.set(id, node);
    return node;
  }
  has(id) {
    return this.nodes.has(id);
  }
  setProp(id, key, value) {
    const n = this.nodes.get(id);
    if (n) {
      n.props[key] = value;
      this.markDirty(id);
    }
  }
  setProps(id, map) {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const k of Object.keys(map)) n.props[k] = map[k];
    this.markDirty(id);
  }
  addChild(parentId, childId2, index) {
    const p = this.nodes.get(parentId);
    const c = this.nodes.get(childId2);
    if (!p || !c) return;
    if (c.parent && c.parent !== parentId) this.removeChild(c.parent, childId2);
    const existing = p.children.indexOf(childId2);
    if (existing >= 0) p.children.splice(existing, 1);
    if (index === void 0 || index < 0 || index >= p.children.length) {
      p.children.push(childId2);
    } else {
      p.children.splice(index, 0, childId2);
    }
    c.parent = parentId;
    this.markDirty(parentId);
  }
  removeChild(parentId, childId2) {
    const p = this.nodes.get(parentId);
    if (!p) return;
    const i = p.children.indexOf(childId2);
    if (i >= 0) p.children.splice(i, 1);
    const c = this.nodes.get(childId2);
    if (c && c.parent === parentId) c.parent = 0;
    this.markDirty(parentId);
  }
  clearChildren(parentId) {
    const p = this.nodes.get(parentId);
    if (!p) return;
    for (const cid of p.children) {
      const c = this.nodes.get(cid);
      if (c) c.parent = 0;
    }
    p.children = [];
    this.markDirty(parentId);
  }
  connect(id, event, cb) {
    const n = this.nodes.get(id);
    if (n) {
      n.events[event] = cb;
      this.markDirty(id);
    }
  }
  disconnect(id, event) {
    const n = this.nodes.get(id);
    if (n) {
      delete n.events[event];
      this.markDirty(id);
    }
  }
  /** Look up the callback bound to (widget, event), or 0 if none. */
  callbackFor(id, event) {
    return this.nodes.get(id)?.events[event] ?? 0;
  }
  free(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.parent) this.removeChild(n.parent, id);
    for (const cid of [...n.children]) this.free(cid);
    this.nodes.delete(id);
    this.revs.delete(id);
    if (this.rootId === id) {
      this.rootId = 0;
      this.appDirty = true;
    }
  }
  setRoot(id) {
    if (this.rootId === id) return;
    this.rootId = id;
    this.appDirty = true;
  }
  toast(message) {
    this.toastMessage = message;
    this.appDirty = true;
  }
  /** Is `id` a live widget contained in the subtree rooted at `sandbox`? */
  containedIn(id, sandbox) {
    if (!this.nodes.has(id)) return false;
    if (sandbox === 0) return true;
    let cur = id;
    while (cur) {
      if (cur === sandbox) return true;
      cur = this.nodes.get(cur)?.parent;
    }
    return false;
  }
  addOwner(id, sandbox) {
    const n = this.nodes.get(id);
    if (!n) return false;
    if (!n.owners.includes(sandbox)) n.owners.push(sandbox);
    return true;
  }
};

// src/core/hostDispatcher.ts
var HostDispatcher = class {
  store = new WidgetStore();
  log = [];
  engine;
  invokeSink = () => {
  };
  /**
   * Where widget ops go. A native/DOM renderer (`opts.widgets`) drives the
   * platform's own widgets directly; otherwise the retained WidgetStore backs
   * the React `<VictorHost/>`. Sandbox governance stays on the store (only
   * exercised by mini-app spawning, which uses the store path).
   */
  sink;
  widgets;
  /**
   * Event callbacks by `${widgetId}:${event}` → cb id. Tracked here (not only in
   * the store) so events fire back into the VM on the native/DOM sink path too,
   * where `connect` goes to the platform renderer and never touches the store.
   */
  eventCbs = /* @__PURE__ */ new Map();
  /** Overridable commit strategy — the runtime debounces to one flush/frame. */
  commit;
  /** Diagnostics (on-device overlay): rn.ops handled, fireEvent calls, invokes. */
  rnOpCount = 0;
  fireCount = 0;
  invokeCount = 0;
  godotOpCount = 0;
  lastFireMiss = null;
  constructor(engine, widgets) {
    this.engine = engine;
    this.widgets = widgets;
    this.sink = widgets ?? this.store;
    this.commit = widgets ? () => widgets.flush() : () => this.store.flush();
  }
  setInvokeSink(fn) {
    this.invokeSink = fn;
  }
  /** Diagnostics: how many event callbacks are registered + a few sample keys. */
  cbDebug() {
    return `${this.eventCbs.size}[${Array.from(this.eventCbs.keys()).slice(0, 3).join(",")}]`;
  }
  // --- the wasm host_call contract: (name, argsJson) -> replyJson | null ---
  handle(name, argsJson) {
    let args;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return null;
    }
    switch (name) {
      case "log": {
        this.log.push(String(args[0] ?? ""));
        return null;
      }
      case "rn.op": {
        this.rnOpCount++;
        const r = this.execRn(args[0]);
        this.commit();
        return r === null || r === void 0 ? null : JSON.stringify(r);
      }
      case "rn.batch": {
        const ops = args[0] ?? [];
        this.rnOpCount += ops.length;
        const results = ops.map((o) => this.execRn(o));
        this.commit();
        return JSON.stringify(results);
      }
      case "godot.op": {
        this.godotOpCount++;
        const r = this.execGodot(args[0]);
        return r === null || r === void 0 ? null : JSON.stringify(r);
      }
      case "godot.batch": {
        const ops = args[0] ?? [];
        this.godotOpCount += ops.length;
        const results = ops.map((o) => this.execGodot(o));
        return JSON.stringify(results);
      }
      default:
        return null;
    }
  }
  // --- widget-tree op interpreter ---------------------------------------
  execRn(op) {
    if (!op || typeof op !== "object") return null;
    const sbx = op.__sbx ?? 0;
    if (op.chk !== void 0) return this.store.containedIn(op.chk, sbx);
    if (op.grant !== void 0) return this.store.addOwner(op.grant, op.sbx ?? 0);
    if (op.new !== void 0 && op.def !== void 0) {
      this.sink.create(op.def, op.new, sbx);
      return op.def;
    }
    if (op.self === true) {
      return sbx ? { ref: sbx } : null;
    }
    if (op.root !== void 0) {
      const rid = op.ref !== void 0 ? op.ref : typeof op.root === "number" ? op.root : 0;
      if (rid) this.sink.setRoot(rid);
      return null;
    }
    if (op.toast !== void 0) {
      this.sink.toast(op.toast);
      return null;
    }
    if (op.ref !== void 0) {
      const ref = op.ref;
      if (!this.reachable(ref, sbx)) {
        return wireError(`rn.op: widget ${ref} is outside this VM's sandbox`);
      }
      if (op.set !== void 0) {
        this.sink.setProp(ref, op.set, this.unwrap(op.value));
        return null;
      }
      if (op.props !== void 0) {
        this.applyProps(ref, op.props);
        return null;
      }
      if (op.get !== void 0) {
        return this.sink.getProp(ref, op.get);
      }
      if (op.connect !== void 0 && op.cb !== void 0) {
        this.sink.connect(ref, op.connect, op.cb);
        this.eventCbs.set(cbKey(ref, op.connect), op.cb);
        return null;
      }
      if (op.disconnect !== void 0) {
        this.sink.disconnect(ref, op.disconnect);
        this.eventCbs.delete(cbKey(ref, op.disconnect));
        return null;
      }
      if (op.free !== void 0) {
        this.sink.free(ref);
        this.forgetCallbacks(ref);
        return null;
      }
      if (op.method !== void 0) {
        return this.execMethod(ref, op.method, op.args ?? []);
      }
    }
    return null;
  }
  execMethod(ref, method, args) {
    switch (method) {
      case "add_child": {
        const child = childId(args[0]);
        if (child) this.sink.addChild(ref, child);
        return null;
      }
      case "insert_child": {
        const child = childId(args[0]);
        const index = typeof args[1] === "number" ? args[1] : void 0;
        if (child) this.sink.addChild(ref, child, index);
        return null;
      }
      case "remove_child": {
        const child = childId(args[0]);
        if (child) this.sink.removeChild(ref, child);
        return null;
      }
      case "clear_children": {
        this.sink.clearChildren(ref);
        return null;
      }
      case "scene3d_mount": {
        const mountNode = childId(args[0]);
        this.engine.mountSurface(ref, mountNode);
        return null;
      }
      default:
        return null;
    }
  }
  // Props that are event callbacks (`onPress: {cb}`) register as events; the
  // rest are stored verbatim for the renderer.
  applyProps(ref, props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (key.length > 2 && key.startsWith("on") && isCb(value)) {
        const ev = eventName(key);
        this.sink.connect(ref, ev, value.cb);
        this.eventCbs.set(cbKey(ref, ev), value.cb);
      } else {
        this.sink.setProp(ref, key, this.unwrap(value));
      }
    }
  }
  unwrap(v) {
    return v === void 0 ? null : v;
  }
  /** Drop every event callback bound to a freed widget. */
  forgetCallbacks(ref) {
    const prefix = `${ref}:`;
    for (const key of this.eventCbs.keys()) {
      if (key.startsWith(prefix)) this.eventCbs.delete(key);
    }
  }
  reachable(ref, sbx) {
    if (sbx === 0) return true;
    if (this.store.containedIn(ref, sbx)) return true;
    return this.store.get(ref)?.owners.includes(sbx) ?? false;
  }
  // --- 3D op interpreter (forward to the embedded Godot engine) ----------
  execGodot(op) {
    if (!op || typeof op !== "object") return null;
    const sbx = op.__sbx ?? 0;
    if (op.chk !== void 0) {
      if (this.store.has(op.chk)) return this.store.containedIn(op.chk, sbx);
      return this.engine.op(op);
    }
    if (op.grant !== void 0) {
      if (this.store.has(op.grant)) return this.store.addOwner(op.grant, op.sbx ?? 0);
      return this.engine.op(op);
    }
    return this.engine.op(op);
  }
  // --- event delivery (renderer -> VM) -----------------------------------
  /** Fire a widget event: route it to the owning VM's guest closure. */
  fireEvent(widgetId, event, arg) {
    this.fireCount++;
    const cb = this.eventCbs.get(cbKey(widgetId, event)) || this.store.callbackFor(widgetId, event);
    if (!cb) {
      this.lastFireMiss = `${widgetId}:${event}`;
      return;
    }
    this.invokeCount++;
    this.invokeSink("__godotDispatch", JSON.stringify([cb, arg ?? null]));
  }
};
function childId(v) {
  return isRef(v) ? v.ref : typeof v === "number" ? v : 0;
}
function cbKey(ref, event) {
  return `${ref}:${event}`;
}
function eventName(onName) {
  const rest = onName.slice(2);
  return rest.slice(0, 1).toLowerCase() + rest.slice(1);
}

// src/core/scene3dEngine.ts
var MockScene3dEngine = class {
  ops = [];
  nextNode = 1e6;
  // 3D node handles when the guest doesn't supply one
  /** surfaceId -> bound Godot mount-node handle. */
  surfaces = /* @__PURE__ */ new Map();
  op(op) {
    this.ops.push(op);
    if (op.new !== void 0 || op.self === true || op.tree === true) {
      return op.def && op.def !== 0 ? op.def : this.nextNode++;
    }
    return null;
  }
  batch(ops) {
    return ops.map((o) => this.op(o));
  }
  mountSurface(surfaceId, mountNode) {
    this.surfaces.set(surfaceId, mountNode || this.nextNode++);
  }
  releaseSurface(surfaceId) {
    this.surfaces.delete(surfaceId);
  }
};

// src/vm/runtime.ts
var ElpianRuntime = class {
  dispatcher;
  backend;
  onLog;
  running = false;
  dirty = false;
  lastTs = 0;
  rafId = null;
  timer = null;
  widgets;
  /** Diagnostics: frames pumped and the last frame error (surfaced on-device). */
  frameCount = 0;
  lastFrameError = null;
  constructor(backend, opts = {}) {
    this.backend = backend;
    this.onLog = opts.onLog;
    this.widgets = opts.widgets;
    this.dispatcher = new HostDispatcher(
      opts.scene3d ?? new MockScene3dEngine(),
      opts.widgets
    );
    this.dispatcher.commit = () => {
      if (this.running) this.dirty = true;
      else this.commitNow();
    };
    this.dispatcher.setInvokeSink((fn, arg) => this.backend.invoke(fn, arg));
  }
  /** Boot the guest program and start pumping. */
  start(source, opts = {}) {
    const lang = opts.lang ?? "js";
    const prepend = opts.prepend ?? true;
    this.backend.create(source, lang, prepend, (n, a) => this.dispatcher.handle(n, a));
    this.backend.run();
    this.drainLog();
    this.dispatcher.store.flush();
    this.startLoop();
  }
  /** Fire a widget event from the renderer (e.g. a Pressable onPress). */
  fireEvent(widgetId, event, arg = null) {
    this.dispatcher.fireEvent(widgetId, event, arg);
    this.drainLog();
    this.dirty = true;
    if (!this.running) this.dispatcher.store.flush();
  }
  stats() {
    return this.backend.stats();
  }
  stop() {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.rafId = null;
    this.timer = null;
    this.backend.free();
  }
  // --- internals ---------------------------------------------------------
  startLoop() {
    this.running = true;
    this.lastTs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
    if (raf) {
      const step = (ts) => {
        if (!this.running) return;
        this.safeFrame(ts);
        this.rafId = raf(step);
      };
      this.rafId = raf(step);
    } else {
      this.timer = setInterval(() => {
        if (!this.running) return;
        this.safeFrame(Date.now());
      }, 16);
    }
  }
  safeFrame(ts) {
    try {
      this.frame(ts);
    } catch (e) {
      this.lastFrameError = String(e);
      this.onLog?.(`[frame error] ${String(e)}`);
    }
  }
  commitNow() {
    if (this.widgets) this.widgets.flush();
    else this.dispatcher.store.flush();
  }
  frame(ts) {
    this.frameCount++;
    const dt = Math.max(0, ts - this.lastTs);
    this.lastTs = ts;
    this.backend.pump(dt);
    this.drainLog();
    if (this.widgets) {
      this.widgets.flush();
      this.dirty = false;
    } else if (this.dirty) {
      this.dirty = false;
      this.dispatcher.store.flush();
    }
  }
  drainLog() {
    const lines = this.backend.takeLog();
    if (this.onLog) for (const l of lines) this.onLog(l);
  }
};

// src/scene3d/webGodotBinding.ts
function getElpianGodotWeb() {
  const g = globalThis;
  return g.__ElpianGodotWeb ?? null;
}

// src/scene3d/webGodotEngine.ts
var WebGodotEngine = class {
  native;
  resolveSurface;
  constructor(resolveSurface, native = requireWeb()) {
    this.resolveSurface = resolveSurface;
    this.native = native;
  }
  /** True when a Godot HTML5 export is loaded and has installed its binding. */
  static isAvailable() {
    return getElpianGodotWeb() !== null;
  }
  op(op) {
    this.native.op(JSON.stringify(op));
    return typeof op.def === "number" && op.def !== 0 ? op.def : null;
  }
  batch(ops) {
    return ops.map((o) => this.op(o));
  }
  mountSurface(surfaceId, mountNode) {
    const canvas = this.resolveSurface(surfaceId) ?? null;
    this.native.mountSurface(surfaceId, canvas, mountNode);
  }
  releaseSurface(surfaceId) {
    this.native.releaseSurface(surfaceId);
  }
};
function requireWeb() {
  const native = getElpianGodotWeb();
  if (!native) {
    throw new Error(
      "The web embedded-Godot export (__ElpianGodotWeb) is not loaded on this page. Load web/godot/elpian_godot.js, or Scene3D surfaces stay blank."
    );
  }
  return native;
}

// src/render/rnComponents.ts
var RN_COMPONENTS = {
  // --- containers -----------------------------------------------------------
  View: { rn: "View", kind: "view" },
  SafeAreaView: { rn: "SafeAreaView", kind: "view" },
  KeyboardAvoidingView: { rn: "KeyboardAvoidingView", kind: "view" },
  Modal: { rn: "Modal", kind: "view" },
  Pressable: { rn: "Pressable", kind: "view" },
  TouchableOpacity: { rn: "TouchableOpacity", kind: "view" },
  TouchableHighlight: { rn: "TouchableHighlight", kind: "view" },
  TouchableWithoutFeedback: { rn: "TouchableWithoutFeedback", kind: "view" },
  TouchableNativeFeedback: { rn: "TouchableNativeFeedback", kind: "view", platform: "android" },
  InputAccessoryView: { rn: "InputAccessoryView", kind: "view", platform: "ios" },
  DrawerLayoutAndroid: { rn: "DrawerLayoutAndroid", kind: "view", platform: "android" },
  // --- scrollers & lists ----------------------------------------------------
  ScrollView: { rn: "ScrollView", kind: "scroll" },
  FlatList: { rn: "FlatList", kind: "list" },
  SectionList: { rn: "SectionList", kind: "list" },
  VirtualizedList: { rn: "VirtualizedList", kind: "list" },
  VirtualizedSectionList: { rn: "VirtualizedSectionList", kind: "list" },
  // --- leaves ---------------------------------------------------------------
  Text: { rn: "Text", kind: "text" },
  TextInput: { rn: "TextInput", kind: "input" },
  Image: { rn: "Image", kind: "image" },
  ImageBackground: { rn: "ImageBackground", kind: "imageBackground" },
  Switch: { rn: "Switch", kind: "switch" },
  Button: { rn: "Button", kind: "button" },
  ActivityIndicator: { rn: "ActivityIndicator", kind: "activity" },
  StatusBar: { rn: "StatusBar", kind: "status" },
  RefreshControl: { rn: "RefreshControl", kind: "refresh" },
  // --- the Animated.* family (same kinds, animatable host views) ------------
  "Animated.View": { rn: "Animated.View", kind: "view" },
  "Animated.Text": { rn: "Animated.Text", kind: "text" },
  "Animated.Image": { rn: "Animated.Image", kind: "image" },
  "Animated.ScrollView": { rn: "Animated.ScrollView", kind: "scroll" },
  "Animated.FlatList": { rn: "Animated.FlatList", kind: "list" },
  "Animated.SectionList": { rn: "Animated.SectionList", kind: "list" },
  // --- Victor-specific widgets ---------------------------------------------
  Scene3D: { rn: "@victor/scene3d", kind: "scene3d" },
  RNButton: { rn: "@victor/button", kind: "victorButton" },
  RNSlider: { rn: "@community/@react-native-community/slider", kind: "slider" }
};
var RN_ALIASES = {
  RNView: "View",
  RNSafeArea: "SafeAreaView",
  RNKeyboardAvoiding: "KeyboardAvoidingView",
  RNModal: "Modal",
  RNPressable: "Pressable",
  RNTouchable: "TouchableOpacity",
  RNTouchableHighlight: "TouchableHighlight",
  RNTouchableWithoutFeedback: "TouchableWithoutFeedback",
  RNTouchableNativeFeedback: "TouchableNativeFeedback",
  RNInputAccessory: "InputAccessoryView",
  RNDrawer: "DrawerLayoutAndroid",
  RNScroll: "ScrollView",
  RNFlatList: "FlatList",
  RNSectionList: "SectionList",
  RNVirtualizedList: "VirtualizedList",
  RNText: "Text",
  RNInput: "TextInput",
  RNImage: "Image",
  RNImageBackground: "ImageBackground",
  RNSwitch: "Switch",
  RNActivityIndicator: "ActivityIndicator",
  RNStatusBar: "StatusBar",
  RNRefreshControl: "RefreshControl",
  RNScene3D: "Scene3D",
  RNAnimatedView: "Animated.View",
  RNAnimatedText: "Animated.Text",
  RNAnimatedImage: "Animated.Image",
  RNAnimatedScroll: "Animated.ScrollView"
};
function specFor(className) {
  if (RN_COMPONENTS[className]) return RN_COMPONENTS[className];
  const canon = RN_ALIASES[className];
  if (canon && RN_COMPONENTS[canon]) return RN_COMPONENTS[canon];
  return null;
}

// src/render/style.ts
var DIRECT = {
  // color / background
  bg: "backgroundColor",
  backgroundColor: "backgroundColor",
  color: "color",
  tintColor: "tintColor",
  opacity: "opacity",
  // spacing
  padding: "padding",
  paddingH: "paddingHorizontal",
  paddingV: "paddingVertical",
  paddingTop: "paddingTop",
  paddingBottom: "paddingBottom",
  paddingLeft: "paddingLeft",
  paddingRight: "paddingRight",
  margin: "margin",
  marginH: "marginHorizontal",
  marginV: "marginVertical",
  marginTop: "marginTop",
  marginBottom: "marginBottom",
  marginLeft: "marginLeft",
  marginRight: "marginRight",
  gap: "gap",
  rowGap: "rowGap",
  columnGap: "columnGap",
  // size
  width: "width",
  height: "height",
  minWidth: "minWidth",
  maxWidth: "maxWidth",
  minHeight: "minHeight",
  maxHeight: "maxHeight",
  // flex
  flex: "flex",
  flexGrow: "flexGrow",
  flexShrink: "flexShrink",
  flexBasis: "flexBasis",
  flexWrap: "flexWrap",
  align: "alignItems",
  alignSelf: "alignSelf",
  justify: "justifyContent",
  // position
  position: "position",
  top: "top",
  left: "left",
  right: "right",
  bottom: "bottom",
  zIndex: "zIndex",
  overflow: "overflow",
  // border / radius / elevation
  radius: "borderRadius",
  borderRadius: "borderRadius",
  borderWidth: "borderWidth",
  borderColor: "borderColor",
  elevation: "elevation",
  // text
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  fontStyle: "fontStyle",
  fontFamily: "fontFamily",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  textAlign: "textAlign"
};
var STYLE_KEYS = /* @__PURE__ */ new Set([
  ...Object.keys(DIRECT),
  "direction",
  "style"
]);
function toStyle(props) {
  const style = {};
  if (props.direction === "row" || props.direction === "column") {
    style.flexDirection = props.direction;
  }
  for (const key of Object.keys(props)) {
    const target = DIRECT[key];
    if (target) style[target] = props[key];
  }
  const raw = props.style;
  if (raw && typeof raw === "object") Object.assign(style, raw);
  return style;
}

// src/render/domWidgetRenderer.ts
var LENGTH_KEYS = /* @__PURE__ */ new Set([
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "borderRadius",
  "borderWidth",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "top",
  "left",
  "right",
  "bottom",
  "gap",
  "rowGap",
  "columnGap",
  "flexBasis"
]);
var EXPAND = {
  paddingHorizontal: ["paddingLeft", "paddingRight"],
  paddingVertical: ["paddingTop", "paddingBottom"],
  marginHorizontal: ["marginLeft", "marginRight"],
  marginVertical: ["marginTop", "marginBottom"]
};
var DOM_EVENT = {
  press: "click",
  longPress: "contextmenu",
  changeText: "input",
  change: "change",
  valueChange: "change",
  submit: "submit",
  submitEditing: "change",
  focus: "focus",
  blur: "blur",
  scroll: "scroll"
};
var DomWidgetRenderer = class {
  host;
  entries = /* @__PURE__ */ new Map();
  rootId = 0;
  constructor(host) {
    this.host = host;
  }
  static isAvailable() {
    return typeof globalThis.document !== "undefined";
  }
  create(id, className) {
    const kind = specFor(className)?.kind ?? "view";
    const el = this.make(kind);
    this.entries.set(id, { el, kind, className, props: {}, listeners: /* @__PURE__ */ new Map() });
  }
  make(kind) {
    const d = this.host.document;
    switch (kind) {
      case "text":
        return d.createElement("span");
      case "image":
        return d.createElement("img");
      case "input": {
        const el = d.createElement("input");
        el.setAttribute("type", "text");
        return el;
      }
      case "switch": {
        const el = d.createElement("input");
        el.setAttribute("type", "checkbox");
        el.setAttribute("role", "switch");
        return el;
      }
      case "slider": {
        const el = d.createElement("input");
        el.setAttribute("type", "range");
        return el;
      }
      case "button":
      case "victorButton":
        return d.createElement("button");
      case "activity": {
        const el = d.createElement("div");
        el.setAttribute("role", "progressbar");
        return el;
      }
      case "scene3d": {
        const el = d.createElement("canvas");
        el.setAttribute("data-victor", "scene3d");
        return el;
      }
      case "scroll":
      case "list":
      case "imageBackground":
      case "view":
      case "status":
      case "refresh":
      default:
        return d.createElement("div");
    }
  }
  setProp(id, key, value) {
    const e = this.entries.get(id);
    if (!e) return;
    e.props[key] = value;
    this.apply(e);
  }
  getProp(id, key) {
    return this.entries.get(id)?.props[key] ?? null;
  }
  /** The DOM element backing a widget id (for hosting / tests); null if freed. */
  elementFor(id) {
    return this.entries.get(id)?.el ?? null;
  }
  // Re-derive the element's style + kind-specific attributes from its props.
  apply(e) {
    const { el, kind, props } = e;
    if (kind === "text" && props.text != null) el.textContent = String(props.text);
    if (kind === "button" || kind === "victorButton") {
      const label = props.title ?? props.text;
      if (label != null) el.textContent = String(label);
    }
    if (kind === "image" || kind === "imageBackground") {
      const src = props.src ?? props.source;
      if (src != null) {
        if (kind === "image") el.setAttribute("src", String(src));
        else el.style.backgroundImage = `url(${String(src)})`;
      }
    }
    if (kind === "input") {
      if (props.value != null) el.value = String(props.value);
      if (props.placeholder != null) el.setAttribute("placeholder", String(props.placeholder));
      if (props.secure === true) el.setAttribute("type", "password");
      if (props.multiline === true) el.setAttribute("type", "text");
    }
    if (kind === "switch") el.checked = props.value === true;
    if (kind === "slider") {
      if (props.min != null) el.setAttribute("min", String(props.min));
      if (props.max != null) el.setAttribute("max", String(props.max));
      if (props.step != null) el.setAttribute("step", String(props.step));
      if (props.value != null) el.value = String(props.value);
    }
    this.applyStyle(el, kind, props);
  }
  applyStyle(el, kind, props) {
    const rn = toStyle(props);
    const container = kind === "view" || kind === "scroll" || kind === "list" || kind === "imageBackground";
    if (container) {
      el.style.display = "flex";
      el.style.flexDirection = String(rn.flexDirection ?? "column");
    }
    if (kind === "scroll") el.style.overflow = String(rn.overflow ?? "auto");
    for (const key of Object.keys(rn)) {
      const edges = EXPAND[key];
      if (edges) {
        for (const edge of edges) el.style[edge] = cssLen(edge, rn[key]);
        continue;
      }
      if (key === "flexDirection" && container) continue;
      el.style[key] = cssLen(key, rn[key]);
    }
  }
  connect(id, event, cb) {
    const e = this.entries.get(id);
    if (!e) return;
    this.disconnect(id, event);
    const domType = DOM_EVENT[event] ?? event.toLowerCase();
    const listener = (_ev) => {
      this.host.fire(id, event, this.eventArg(e));
    };
    e.el.addEventListener(domType, listener);
    e.listeners.set(event, listener);
  }
  disconnect(id, event) {
    const e = this.entries.get(id);
    const listener = e?.listeners.get(event);
    if (e && listener) {
      const domType = DOM_EVENT[event] ?? event.toLowerCase();
      e.el.removeEventListener(domType, listener);
      e.listeners.delete(event);
    }
  }
  eventArg(e) {
    if (e.kind === "input") return e.el.value ?? "";
    if (e.kind === "switch") return e.el.checked === true;
    if (e.kind === "slider") return Number(e.el.value ?? 0);
    return null;
  }
  addChild(parentId, childId2, index) {
    const p = this.entries.get(parentId);
    const c = this.entries.get(childId2);
    if (!p || !c) return;
    if (index === void 0 || index >= p.el.childNodes.length) {
      p.el.appendChild(c.el);
    } else {
      p.el.insertBefore(c.el, p.el.childNodes[index] ?? null);
    }
  }
  removeChild(parentId, childId2) {
    const p = this.entries.get(parentId);
    const c = this.entries.get(childId2);
    if (p && c) {
      try {
        p.el.removeChild(c.el);
      } catch {
      }
    }
  }
  clearChildren(parentId) {
    const p = this.entries.get(parentId);
    if (!p) return;
    while (p.el.firstChild) p.el.removeChild(p.el.firstChild);
  }
  free(id) {
    this.entries.delete(id);
  }
  setRoot(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.rootId = id;
    while (this.host.container.firstChild) {
      this.host.container.removeChild(this.host.container.firstChild);
    }
    this.host.container.appendChild(e.el);
  }
  toast(message) {
    const d = this.host.document;
    const t = d.createElement("div");
    t.setAttribute("data-victor", "toast");
    t.textContent = message;
    t.style.position = "fixed";
    t.style.bottom = "24px";
    t.style.left = "50%";
    t.style.transform = "translateX(-50%)";
    t.style.background = "rgba(15,23,42,0.92)";
    t.style.color = "#e2e8f0";
    t.style.padding = "10px 16px";
    t.style.borderRadius = "8px";
    this.host.container.appendChild(t);
    const remove = () => {
      try {
        this.host.container.removeChild(t);
      } catch {
      }
    };
    const to = globalThis.setTimeout;
    if (to) to(remove, 2200);
  }
  // Single app on web (no mini-app sandboxing in the DOM path yet).
  containedIn() {
    return true;
  }
  addOwner() {
    return true;
  }
  flush() {
  }
};
function cssLen(key, value) {
  if (typeof value === "number" && LENGTH_KEYS.has(key)) return `${value}px`;
  return String(value);
}

// src/render/mountDom.ts
async function mountDom(opts) {
  const doc = opts.document ?? globalThis.document;
  let runtime;
  const renderer = new DomWidgetRenderer({
    document: doc,
    container: opts.container,
    fire: (id, event, arg) => runtime.fireEvent(id, event, arg)
  });
  const scene3d = opts.scene3d ?? (WebGodotEngine.isAvailable() ? new WebGodotEngine((id) => renderer.elementFor(id)) : void 0);
  let host = () => null;
  const backend = await WasmBackend.instantiate(opts.wasmBytes, (n, a) => host(n, a));
  runtime = new ElpianRuntime(backend, {
    widgets: renderer,
    scene3d,
    onLog: opts.onLog
  });
  host = (n, a) => runtime.dispatcher.handle(n, a);
  runtime.start(opts.source, { lang: opts.lang ?? "js" });
  return runtime;
}

// src/example/showcaseSource.ts
var SHOWCASE_GUEST_SOURCE = '// Victor showcase \u2014 a rich React Native (2D) + Godot (3D) app on one Elpian VM.\n// ===========================================================================\n//\n// Everything here runs entirely on the Elpian VM (no JIT). The 2D UI is a real\n// React Native widget tree built with `reactnative.js`; the 3D world is a real\n// Godot scene built with the ordinary `godot.js` / `G3` surface and embedded as\n// an `RN.Scene3D` widget. The 2D controls *drive* the 3D scene live \u2014 the whole\n// point of the integration: one program, two renderers, one VM in charge.\n//\n// It exercises a broad slice of the now-complete React Native element set:\n//   SafeAreaView \xB7 ScrollView \xB7 View (row/column) \xB7 Text \xB7 TextInput \xB7 Switch\n//   \xB7 Slider \xB7 Button \xB7 FlatList \xB7 Modal \xB7 ActivityIndicator \xB7 Scene3D (Godot).\n//\n// Compile with js2elpian, or ship the source and let <VictorHost/> compose the\n// `godot.js` + `reactnative.js` preludes ahead of it (what the Expo app does).\n\nimport "godot.js";\nimport "reactnative.js";\n\n// One retained-handle bag so event closures can reach the widgets/nodes they\n// mutate without a forest of globals.\nvar refs = {};\nvar count = 0;\nvar itemCount = 0;\nvar spheres = [];\n\n// --- helpers ---------------------------------------------------------------\n\nfunction greeting(name) {\n  if (name == null || name == "") {\n    return "Hello there!";\n  }\n  return "Hello, " + name + "!";\n}\n\nfunction bump(delta) {\n  count = count + delta;\n  refs.counter.set("text", "Count: " + count);\n  RN.toast("count = " + count);\n}\n\nfunction setLight(on) {\n  if (refs.light != null) {\n    refs.light.set("visible", on);\n  }\n}\n\n// The slider gives an absolute Y rotation (degrees) \u2014 drag it and the 3D group\n// spins. A single 2D event \u2192 one godot.op `set` on the live scene node.\nfunction setSpin(deg) {\n  if (refs.group != null) {\n    refs.group.set("rotation_degrees", new Vector3(0, deg, 0));\n  }\n}\n\nfunction addSphere() {\n  if (refs.group == null) {\n    return;\n  }\n  var n = spheres.length;\n  var x = (n % 5) - 2;\n  var z = 0 - (n / 5);\n  var s = G3.mesh("sphere", {\n    color: new Color(1.0, 0.5, 0.2, 1),\n    position: [x, 0.6, z],\n    radius: 0.35,\n  });\n  refs.group.call("add_child", [s]);\n  spheres.push(s);\n  RN.toast("spheres: " + spheres.length);\n}\n\nfunction clearSpheres() {\n  var i = 0;\n  while (i < spheres.length) {\n    spheres[i].queueFree();\n    i = i + 1;\n  }\n  spheres = [];\n}\n\nfunction addItem() {\n  itemCount = itemCount + 1;\n  var t = RN.text("List item " + itemCount, {\n    color: "#e2e8f0",\n    fontSize: 15,\n    padding: 12,\n    marginV: 4,\n    bg: "#1e293b",\n    radius: 8,\n  });\n  refs.list.add(t);\n}\n\n// --- the embedded Godot 3D scene -------------------------------------------\n\nfunction build3d(scene) {\n  if (scene.scene3d == null) {\n    return; // no Godot engine on this platform \u2014 2D still runs\n  }\n  var mount = scene.scene3d;\n  mount.call("add_child", [\n    G3.environment({ bg: new Color(0.02, 0.03, 0.09, 1), ambientEnergy: 0.6 }),\n  ]);\n  var light = G3.dirLight({ energy: 1.4, rotation: [-50, -30, 0], shadow: true });\n  refs.light = light;\n  mount.call("add_child", [light]);\n  mount.call("add_child", [\n    G3.camera({ position: [0, 3, 7], rotation: [-18, 0, 0], fov: 55 }),\n  ]);\n  mount.call("add_child", [\n    G3.mesh("plane", { color: new Color(0.12, 0.15, 0.2, 1), size: [16, 16] }),\n  ]);\n  var group = G3.node({ position: [0, 1, 0] });\n  refs.group = group;\n  mount.call("add_child", [group]);\n  group.call("add_child", [\n    G3.mesh("box", { color: new Color(0.3, 0.6, 1, 1), position: [0, 0, 0] }),\n  ]);\n}\n\n// --- the 2D React Native UI ------------------------------------------------\n\nfunction sectionLabel(scroll, s) {\n  scroll.add(RN.text(s, { color: "#cbd5e1", fontSize: 15, fontWeight: "600", marginTop: 8 }));\n}\n\nfunction main() {\n  RN.begin();\n\n  var root = RN.safe({ flex: 1, bg: "#0b1220" });\n  var scroll = RN.scroll({ flex: 1, padding: 20, gap: 14 });\n\n  // Header ------------------------------------------------------------------\n  scroll.add(\n    RN.text("Victor \xB7 React Native 2D + Godot 3D", {\n      color: "#e2e8f0",\n      fontSize: 22,\n      fontWeight: "700",\n    }),\n  );\n  scroll.add(\n    RN.text("One Elpian VM drives the widgets and the 3D scene. The controls below mutate the live Godot world.", {\n      color: "#94a3b8",\n      fontSize: 13,\n    }),\n  );\n\n  // The embedded Godot 3D scene --------------------------------------------\n  var scene = RN.scene3d({ height: 260, radius: 14, bg: "#020617" });\n  build3d(scene);\n  scroll.add(scene);\n\n  // Counter -----------------------------------------------------------------\n  var counter = RN.text("Count: 0", { color: "#38bdf8", fontSize: 18, fontWeight: "600" });\n  refs.counter = counter;\n  var crow = RN.row({ gap: 12, align: "center" });\n  crow.add(RN.button({ title: "\u2212", bg: "#334155", onPress: function (e) { bump(-1); } }));\n  crow.add(counter);\n  crow.add(RN.button({ title: "+", onPress: function (e) { bump(1); } }));\n  scroll.add(crow);\n\n  // Text input echo ---------------------------------------------------------\n  sectionLabel(scroll, "Your name");\n  var echo = RN.text("Hello there!", { color: "#e2e8f0", fontSize: 16 });\n  refs.echo = echo;\n  scroll.add(\n    RN.input({\n      placeholder: "Type your name\u2026",\n      onChangeText: function (t) { refs.echo.set("text", greeting(t)); },\n    }),\n  );\n  scroll.add(echo);\n\n  // Switch drives the 3D key light -----------------------------------------\n  var srow = RN.row({ gap: 12, align: "center", justify: "space-between" });\n  srow.add(RN.text("Key light", { color: "#cbd5e1", fontSize: 15 }));\n  srow.add(RN._switch({ value: true, onValueChange: function (v) { setLight(v); } }));\n  scroll.add(srow);\n\n  // Slider drives the 3D group rotation ------------------------------------\n  sectionLabel(scroll, "Cube rotation");\n  scroll.add(\n    RN.slider({ value: 30, min: 0, max: 180, onValueChange: function (v) { setSpin(v); } }),\n  );\n\n  // Buttons that add / clear 3D spheres ------------------------------------\n  var brow = RN.row({ gap: 12 });\n  brow.add(RN.button({ title: "Add sphere", onPress: function (e) { addSphere(); } }));\n  brow.add(RN.button({ title: "Clear", bg: "#b91c1c", onPress: function (e) { clearSpheres(); } }));\n  scroll.add(brow);\n\n  // A FlatList of items -----------------------------------------------------\n  sectionLabel(scroll, "Items (FlatList)");\n  var list = RN.flatList({ height: 160, bg: "#0f172a", radius: 10, padding: 8 });\n  refs.list = list;\n  scroll.add(list);\n  scroll.add(RN.button({ title: "Add item", bg: "#0ea5e9", onPress: function (e) { addItem(); } }));\n\n  // Busy indicator ----------------------------------------------------------\n  var busy = RN.row({ gap: 10, align: "center" });\n  busy.add(RN.spinner({}));\n  busy.add(RN.text("ActivityIndicator", { color: "#94a3b8", fontSize: 13 }));\n  scroll.add(busy);\n\n  // A modal dialog ----------------------------------------------------------\n  var modal = RN.modal({ visible: false, animationType: "slide", transparent: true });\n  refs.modal = modal;\n  var sheet = RN.column({ flex: 1, justify: "center", align: "center", bg: "#000000aa", padding: 24 });\n  var card = RN.column({ bg: "#111827", padding: 20, radius: 16, gap: 12, maxWidth: 320 });\n  card.add(RN.text("About Victor", { color: "#e2e8f0", fontSize: 18, fontWeight: "700" }));\n  card.add(\n    RN.text("2D via React Native, 3D via Godot \u2014 all app logic on the Elpian VM, no JIT, App-Store-legal, cross-platform.", {\n      color: "#94a3b8",\n      fontSize: 14,\n    }),\n  );\n  card.add(RN.button({ title: "Close", onPress: function (e) { refs.modal.set("visible", false); } }));\n  sheet.add(card);\n  modal.add(sheet);\n  scroll.add(RN.button({ title: "Show info", bg: "#7c3aed", onPress: function (e) { refs.modal.set("visible", true); } }));\n  scroll.add(modal);\n\n  root.add(scroll);\n\n  RN.commit();\n  RN.mount(root);\n\n  print("victor rn+godot showcase up");\n}\n\nmain();\n';

// web/main.ts
async function boot() {
  const status = document.getElementById("status");
  try {
    const res = await fetch("./elpian_rn.wasm");
    if (!res.ok) throw new Error(`fetch elpian_rn.wasm: ${res.status}`);
    const wasmBytes = await res.arrayBuffer();
    const container = document.getElementById("root");
    const rt = await mountDom({
      wasmBytes,
      source: SHOWCASE_GUEST_SOURCE,
      container,
      onLog: (line) => {
        window.__victorLog ??= [];
        window.__victorLog.push(line);
        console.log("[guest]", line);
      }
    });
    window.__victor = rt;
    window.__victorReady = true;
    if (status) status.remove();
  } catch (e) {
    window.__victorError = String(e);
    if (status) {
      status.textContent = `Boot failed: ${String(e)}`;
      status.style.color = "#f87171";
    }
    console.error(e);
  }
}
boot();
