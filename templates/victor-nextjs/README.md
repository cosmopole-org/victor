# Victor × Next.js — a React app that runs on the Victor engine

This is a **project template**. You write an ordinary Next.js + React app —
function components, JSX, hooks, `app/`-directory routing — and it runs on the
**Victor engine** instead of a browser: compiled by `js2elpian`, executed by the
**Elpian VM** (a no-JIT pausing bytecode interpreter), and rendered by **Godot**
with native **Victor (VUI) widgets** instead of HTML elements.

There is no DOM. `<column>`, `<card>`, `<button>`, `<input>` are retained Godot
`Control` nodes. `useState`, `useEffect`, `useReducer`, `useContext`, keys and
refs are the genuine React programming model, driven by a keyed reconciler that
mutates those nodes.

```
  app/page.jsx  ──►  Babel (JSX→_jsx, strip TS)  ──►  flatten modules  ──►  build/guest.js
                                                                                  │
                          godot.js + ui.js + react.js  ── composed ahead ─────────┘
                                                                                  │
                                          Elpian VM (js2elpian)  ──►  Godot (VUI widgets)
```

## Quick start

```sh
npm install
npm run build        # → build/guest.js  (the single-file guest program)
```

Then load `build/guest.js` on the engine like any Victor guest program: copy it
into `elpian/godot/prelude`-adjacent `elpian/godot/project/scripts/` and point an
`ElpianVM` node's script at it — exactly how `ui_demo.js` is loaded. The engine
composes `godot.js` + `ui.js` + `react.js` ahead of it automatically (it sees the
`import 'react.js';` marker at the top of the output).

## Project layout

```
app/
  layout.jsx          root layout (wraps every page) — like Next's app/layout
  page.jsx            "/"        route
  counter/page.jsx    "/counter" route
  todos/page.jsx      "/todos"   route
components/           reusable components (Counter, TodoList, …)
lib/router.jsx        the client router: <VictorApp>, useRouter(), <Link>
victor.config.mjs     app config (design size, portrait, theme) — like next.config
tools/build.mjs       the Victor bundler
types/                editor-only ambient types for `react` / `@victor/react`
```

File-based routing is real: `tools/build.mjs` scans `app/**/page.jsx`, derives a
route from the folder, and generates the routing manifest the router renders.

## The component model

You have two interchangeable ways to describe UI, and you can mix them:

**Lowercase host tags** (Victor widgets, feels like HTML):

```jsx
<column gap={16}>
  <heading>Hello</heading>
  <card gap={12}>
    <text wrap={true} color="muted">A retained Godot panel.</text>
    <button kind="tonal" onPress={() => doThing()}>Tap me</button>
  </card>
</column>
```

**Capitalised components** (React-Native style, from `@victor/react`):

```jsx
import { Column, Heading, Card, Text, Button } from "@victor/react";
```

Host tags and their web aliases:

| category   | tags |
|------------|------|
| layout     | `view`/`div`, `column`, `row`, `stack`, `scroll`, `center`, `panel`, `card`, `grid`, `section`/`header`/`footer`/`nav` |
| text       | `text`/`span`/`p`, `heading`/`h1`/`h2`/`h3`, `title`, `caption`/`small`, `icon` |
| controls   | `button`, `input`/`field`, `slider`, `switch`/`toggle`, `checkbox`, `progress` |
| media/misc | `image`/`img`, `divider`/`hr`, `spacer` |
| **3D**     | `scene3d` (the 2D↔3D bridge), `node3d`, `mesh`/`box`/`sphere`/`cylinder`/`capsule`/`plane3d`/`torus`/`prism`, `camera3d`, `directionallight`/`omnilight`/`spotlight`, `environment`, `staticbody3d`/`rigidbody3d`/`area3d`, `collisionshape3d`, and `node type="AnyGodotClass"` (reflective escape hatch) |

## Mixed 2D + 3D

Victor is a Godot app, so 3D is first-class. Put a `<scene3d>` anywhere in your
2D tree — it is the bridge (a `SubViewportContainer` + `SubViewport`) that hosts
a real 3D world. Inside it, `Node3D`-family elements describe the scene; outside
it, ordinary 2D React drives the scene through state. See `app/scene/page.jsx`.

```jsx
import { useState, useRef, useFrame } from "react";

function Spinner({ speed }) {
  const ref = useRef(null);
  const a = useRef(0);
  useFrame((d) => {                       // runs every frame (react-three-fiber style)
    if (ref.current) {
      a.current += d * speed;
      ref.current.set("rotation_degrees", new Vector3(0, a.current, 0));
    }
  });
  return (
    <node3d ref={ref}>
      <box size={[1, 1, 1]} color="accent" />
    </node3d>
  );
}

<scene3d height={480}>
  <environment ambientEnergy={0.7} />
  <directionallight rotation={[-50, -30, 0]} energy={1.2} />
  <camera3d position={[0, 3, 8]} rotation={[-18, 0, 0]} fov={55} />
  <plane3d width={18} depth={18} />
  <Spinner speed={40} />
</scene3d>
```

Transforms are props: `position={[x,y,z]}`, `rotation={[x,y,z]}` (degrees),
`scale`, `visible`. Meshes take `color`/`emission`/`metallic`/`roughness` and
per-shape dims (`size`, `radius`, `height`, `width`/`depth`, …). Refs on 3D
elements give you the live Godot node (a `GObj`) to drive imperatively inside
`useFrame`. The whole reflective engine is reachable via `<node type="…">` or
`Victor.g3()` for anything the named tags don't cover. Colours use `new Color(r,g,b,a)`
or a theme token; vectors use `new Vector3(x,y,z)` (both from the `godot.js` prelude).

Common props: `gap`, `pad`, `grow`, `bg`, `color` (theme token name like
`"primary"`/`"accent"`/`"muted"`, a `"#rrggbb"` string, or a Color), `align`,
`wrap`, and events `onPress`/`onClick`, `onChange`, `onSubmit`.

## Hooks

All of them are implemented and behave as in React:

`useState` · `useReducer` · `useEffect` (+ cleanup) · `useLayoutEffect` ·
`useInsertionEffect` · `useRef` · `useMemo` · `useCallback` · `useContext` +
`createContext` · `useImperativeHandle` · `useId` · `useSyncExternalStore` ·
`useTransition` · `useDeferredValue` · `useDebugValue`. Plus `memo`,
`forwardRef`, `Fragment`, and `StrictMode` — and `useFrame(delta => …)` for
per-frame work (3D animation, simulation), the react-three-fiber idiom.

## The authored dialect — honest constraints

The Elpian VM runs a **subset** of JavaScript (no JIT, App-Store-legal). The
build tool lowers JSX and strips TypeScript, but it does **not** polyfill
language features the subset cannot model. Write components in this dialect:

- **No** object/array spread or rest (`{...props}`, `[...xs]`, `(...args)`),
  destructuring (`const { a } = props`), or template literals (`` `${x}` ``).
  Use `props.a`, string concatenation (`"x=" + n`), and index access.
- Prefer `function () { … }` and arrow functions — both work.
- Names are one flat global scope after flattening, so **component and
  top-level function names must be unique across the project**. (Page/layout
  `export default`s are auto-renamed by route, so those never collide.)
- A literal numeric `0` is not rendered as a text child (the VM has no distinct
  `null`); write `"" + n` or a string.
- Loops are C-style `for`; `list.map(fn)` works for building keyed children.

These are the same constraints the engine's own `ui.js` widget kit lives under —
see the "honest constraints" note at the top of `react.js`.

## How it fits the Victor engine

- **`elpian/godot/prelude/react.js`** — VReact: the React-compatible runtime
  (element factory, hooks, keyed reconciler, host drivers). Authored in the
  `js2elpian` subset; user-space code, no privileged access. See
  `../../elpian/godot/prelude/REACT.md`.
- **`elpian/godot/prelude/ui.js`** — VUI: the widget kit VReact's host config
  drives.
- **`elpian/godot/prelude/godot.js`** — the reflective Godot bridge.
- The composer (`compose_godot_program_js` in `elpian/godot/capi/src/lib.rs`)
  prepends these in order when it sees the `import` markers.

The runtime's end-to-end regression (mount, `setState` re-render over the
bridge, effect + cleanup) lives in
`elpian/godot/capi/tests/run_react_demo.rs`.
