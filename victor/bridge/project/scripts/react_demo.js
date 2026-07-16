// react_demo.js — a Victor app written in React, shown here in the *compiled*
// form the toolchain emits: JSX has been lowered to `_jsx`/`_jsxs` automatic-
// runtime calls and the app's modules flattened into one guest program. The
// authored, human-facing source (JSX + hooks, exactly like an ordinary Next.js
// project) lives in `templates/victor-nextjs/`; `tools/build.mjs` turns that
// project into a file shaped like this one.
//
// It exercises the runtime end to end: useState, useEffect + cleanup, useRef,
// useMemo, useReducer, useContext (a provider + a consumer), keyed list
// reconciliation via `.map`, and event props routed onto retained Godot nodes.
import 'godot.js';
import 'ui.js';
import 'react.js';

// A shared context — the theme accent name, provided at the root.
var AccentContext = createContext("primary");

// ---- a single to-do row (keyed list item) ---------------------------------

function TodoRow(props) {
  let accent = useContext(AccentContext);
  return _jsxs("row", {
    gap: 12,
    children: [
      _jsx("text", { grow: true, color: props.done ? "muted" : "text", children: props.label }),
      _jsx("button", {
        kind: props.done ? "ghost" : "tonal",
        onPress: () => { props.onToggle(props.id); },
        children: props.done ? "Undo" : "Done",
      }),
    ],
  });
}

// ---- the to-do list, driven by useReducer ---------------------------------

function todoReducer(state, action) {
  if (action.type == "toggle") {
    let out = [];
    for (let i = 0; i < state.length; i++) {
      let it = state[i];
      if (it.id == action.id) {
        out.push({ id: it.id, label: it.label, done: !it.done });
      } else {
        out.push(it);
      }
    }
    return out;
  }
  if (action.type == "add") {
    let out = [];
    for (let i = 0; i < state.length; i++) {
      out.push(state[i]);
    }
    out.push({ id: action.id, label: action.label, done: false });
    return out;
  }
  return state;
}

function TodoList() {
  let r = useReducer(todoReducer, [
    { id: 1, label: "Wire the reconciler", done: true },
    { id: 2, label: "Cover every hook", done: false },
    { id: 3, label: "Ship the template", done: false },
  ]);
  let todos = r[0];
  let dispatch = r[1];

  let remaining = useMemo(() => {
    let n = 0;
    for (let i = 0; i < todos.length; i++) {
      if (!todos[i].done) { n = n + 1; }
    }
    return n;
  }, [todos]);

  // Build keyed rows with .map-style construction (each carries a key).
  let items = [];
  for (let i = 0; i < todos.length; i++) {
    let it = todos[i];
    items.push(
      _jsx(TodoRow, {
        id: it.id,
        label: it.label,
        done: it.done,
        onToggle: (id) => { dispatch({ type: "toggle", id: id }); },
      }, "todo-" + it.id)
    );
  }

  return _jsxs("card", {
    gap: 14,
    children: [
      _jsx("heading", { children: "To-do" }),
      _jsx("caption", { children: remaining + " remaining" }),
      _jsx("column", { gap: 10, children: items }),
    ],
  });
}

// ---- a counter: useState + useEffect + cleanup + useRef -------------------

function Counter() {
  let s = useState(0);
  let count = s[0];
  let setCount = s[1];

  // useRef survives renders without triggering them.
  let renders = useRef(0);
  renders.current = renders.current + 1;

  // useEffect runs after commit; the cleanup runs before the next effect and
  // on unmount. Here it logs to the Godot console.
  useEffect(() => {
    print("[react] count committed: " + count);
    return () => {
      print("[react] cleanup for count " + count);
    };
  }, [count]);

  return _jsxs("card", {
    gap: 14,
    children: [
      _jsx("heading", { children: "Counter" }),
      _jsx("title", { children: "Value: " + count }),
      _jsx("caption", { children: "renders: " + renders.current }),
      _jsxs("row", {
        gap: 12,
        children: [
          _jsx("button", { kind: "outline", onPress: () => { setCount(count - 1); }, children: "-" }),
          _jsx("button", { onPress: () => { setCount(count + 1); }, children: "+" }),
        ],
      }),
    ],
  });
}

// ---- the app root ---------------------------------------------------------

function App() {
  return _jsx(AccentContext.Provider, {
    value: "accent",
    children: _jsxs("scroll", {
      gap: 20,
      children: [
        _jsx("heading", { children: "Victor × React" }),
        _jsx("caption", { children: "hooks + a keyed reconciler on the Elpian VM" }),
        _jsx(Counter, {}),
        _jsx(TodoList, {}),
      ],
    }),
  });
}

VictorClient.mountApp(_jsx(App, {}), { design: [720, 1280], portrait: true, theme: "dark" });
