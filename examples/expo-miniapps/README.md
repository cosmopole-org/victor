# Victor mini apps — sample Expo app

A minimal **Expo** app that consumes [`victor-react-native`](../../victor/react-native)
as a library and hosts two Victor **mini apps** — a counter and a greeter —
driven by the object-oriented `VictorMiniAppsController`.

Each mini app is an **isolated Elpian VM** (its own memory + widget tree)
rendered into a cell of `<VictorMiniApps/>`. One VM can neither see nor touch
another's state. On web the VM runs as WebAssembly; the same code runs on iOS /
Android through the native JSI backend.

```
App.tsx              — the Expo screen: builds a controller, adds 2 mini apps,
                       renders <VictorMiniApps controller={…}/> + lifecycle buttons
miniapps/sources.ts  — the two mini-app programs (js2elpian source strings)
test/web-e2e.mjs     — Playwright end-to-end proof (serves the web export, drives it)
scripts/sync-wasm.mjs — copies the VM module into public/ for the web export
```

## What it demonstrates

- Importing the package and its **object-oriented controller**:
  ```tsx
  import { VictorMiniApps, VictorMiniAppsController } from "victor-react-native";

  const controller = new VictorMiniAppsController({ wasm: loadWasm });
  controller.add({ id: "counter", source: COUNTER });
  controller.add({ id: "greeter", source: GREETER });
  // …restart / stop / start / replaceSource from anywhere:
  controller.restart("counter");
  controller.stop("greeter");

  <VictorMiniApps controller={controller} width="100%" height={520} />
  ```
- **Isolation:** tapping the counter never touches the greeter.
- **Lifecycle:** the on-screen buttons call `restart` / `stop` / `start` /
  `replaceSource` and the view + live status update accordingly.

## Run it

Because this lives inside the Victor monorepo, first pack the library locally
(this also cross-compiles the VM to wasm, so it needs Rust + the
`wasm32-unknown-unknown` target). In a published-package setup you would instead
just `npm install victor-react-native`.

```sh
cd examples/expo-miniapps
npm run pack:lib        # → victor-react-native-0.1.0.tgz (packs ../../victor/react-native)
npm install            # installs Expo + react-native-web + the packed library

# Dev server (opens the web app):
npm run web

# Static web export (writes dist/, syncing the VM module into public/ first):
npm run export:web
```

## Verify end-to-end (headless, no device)

```sh
npm run e2e            # export:web + Playwright test against the served dist/
```

The test serves the export in headless Chromium and asserts: both mini apps
mount their own trees, the counter increments on tap (event → VM → DOM), the
greeter echoes typed input, the counter is unaffected by the greeter (isolation),
and the controller's `restart` / `stop` / `start` all take effect — with no
console errors. It writes `e2e-screenshot.png` for a visual check.
