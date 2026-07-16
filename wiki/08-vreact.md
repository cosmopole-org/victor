# 08 — VReact (React on the VM)

VReact (`react.js`) is a faithful, from-scratch reimplementation of **React's
programming model** whose "DOM" is the retained Godot scene graph. A component
written against VReact *is* ordinary React — the rules of hooks, deps arrays, and
reconciliation guarantees all hold. It relates to React as **Preact** does: same
API, independent tiny core.

Deep doc: **`victor/bridge/prelude/REACT.md`**. A compiled Next.js-on-Victor app
runs on this (see `victor/templates/victor-nextjs/`).

```js
import 'godot.js';
import 'ui.js';
import 'react.js';   // implies ui.js
```

## Rendering model

Every intrinsic element is a **host driver** that creates/mutates a retained
Godot `Control` (2D) or `Node3D` (3D). VUI 2D tags: `"column" "row" "text"
"button" "input" "slider" ...` plus web aliases (`"div" "span" "img" ...`). 3D
tags via the `G3` layer: `"node3d" "box" "sphere" "camera3d"
"directionallight" "omnilight" "spotlight" "plane3d" "environment"` and
`"scene3d"` (the SubViewport 2D↔3D bridge). A tree can mix 2D and 3D freely.

Mount with:

```js
VictorClient.mountApp(_jsx(App, {}), { portrait: true, design: [720, 1280] });
```

`_jsx` / `_jsxs` / `Fragment` are the element factory (the form the JSX toolchain
emits). You can also call `React.createElement(type, props, ...children)`.

## The hook surface (complete)

VReact implements the full hook set (from `react.js`):

```
useState  useReducer  useContext  useRef  useMemo  useCallback  useEffect
useLayoutEffect  useInsertionEffect  useImperativeHandle  useId  useTransition
useDeferredValue  useDebugValue  useSyncExternalStore
useFrame(delta => …)     // Victor extra: runs every engine frame
useViewport()            // Victor extra: current viewport metrics
```

`useFrame` is how you animate imperatively (drive a `ref.current.set(...)` each
frame). `useState`/`useReducer` drive re-render; effects and refs behave as in
React.

## Example — mixed 2D + 3D

```jsx
function Spinner({ speed, count }) {
  const ref = useRef(null);
  const angle = useRef(0);
  useFrame((d) => {
    if (ref.current) { angle.current += d * speed; ref.current.set("rotation_degrees", new Vector3(0, angle.current, 0)); }
  });
  const cubes = [];
  for (let i = 0; i < count; i++) cubes.push(_jsx("box", { size: [0.8,0.8,0.8], position: [i*1.2 - count*0.6, 0.6, 0] }, "c"+i));
  return _jsx("node3d", { ref, children: cubes });
}

function App() {
  const [speed, setSpeed] = useState(40);
  const [count, setCount] = useState(6);
  return _jsx("column", { children: [
    _jsx("scene3d", { children: [
      _jsx("environment", {}), _jsx("directionallight", { rotation: [-50,-30,0] }),
      _jsx("camera3d", { position: [0,3,8], rotation: [-18,0,0] }),
      _jsx(Spinner, { speed, count }),
    ]}),
    _jsx("slider", { value: speed, min: 0, max: 120, onChanged: setSpeed }),
    _jsx("button", { text: "+ cube", onClick: () => setCount(count + 1) }),
  ]});
}

VictorClient.mountApp(_jsx(App, {}), { portrait: true });
```

The shipped `victor/bridge/project/scripts/react_3d_demo.js` is the compiled
(`_jsx`) form of exactly this — read it as a working example, and the JSX source
under `victor/templates/victor-nextjs/`.

## When to use VReact vs VUI vs FL

- **VReact** — you want the React programming model (components, hooks, JSX),
  mixed 2D/3D, and a Next.js-style app. Native, ships everywhere.
- **VUI** (`06`) — you want imperative widgets/canvas/gestures without the React
  runtime. Native, ships everywhere, lightest.
- **FL** (`07`) — you need the *real* Flutter framework and control the build.

## Gotchas

- VReact components are subject to all the JS-front-end rules (`03`) — including
  `__isType`, `GInt`/`GFloat` marshaling for engine props, and deferred signal
  dispatch.
- `useFrame` runs on the engine frame via the VM pump; keep it cheap.
- The stale "no spread/destructuring/try" note in older docs no longer applies —
  `js2elpian` now supports the full tower (see `03-javascript.md`); VReact
  itself was written to run in the subset and works regardless.
