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

Common props: `gap`, `pad`, `grow`, `bg`, `color` (theme token name like
`"primary"`/`"accent"`/`"muted"`, a `"#rrggbb"` string, or a Color), `align`,
`wrap`, and events `onPress`/`onClick`, `onChange`, `onSubmit`.

## Hooks

All of them are implemented and behave as in React:

`useState` · `useReducer` · `useEffect` (+ cleanup) · `useLayoutEffect` ·
`useInsertionEffect` · `useRef` · `useMemo` · `useCallback` · `useContext` +
`createContext` · `useImperativeHandle` · `useId` · `useSyncExternalStore` ·
`useTransition` · `useDeferredValue` · `useDebugValue`. Plus `memo`,
`forwardRef`, `Fragment`, and `StrictMode`.

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
