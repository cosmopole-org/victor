// tools/build.mjs — the Victor bundler.
//
// It turns this ordinary-looking Next.js + React project into the single-file
// guest program the Victor engine runs (Elpian VM compiles it with js2elpian,
// Godot renders it via the VUI widget kit). There is no browser and no DOM —
// the compiled program calls into the VReact runtime (`elpian/godot/prelude/
// react.js`), whose host config maps React elements onto retained Godot nodes.
//
// Pipeline, per source module:
//   1. Babel transforms JSX with the AUTOMATIC runtime → `_jsx(...)` calls, and
//      strips TypeScript types (.ts/.tsx). The automatic runtime is essential:
//      it puts children inside `props` so there are no variadic `createElement`
//      arguments (which the Elpian bytecode subset cannot express).
//   2. A second Babel pass FLATTENS the module: it removes every `import`
//      (there is no module system on the VM — the preludes ARE the imports) and
//      unwraps every `export`, because the whole app collapses into one flat
//      global scope. A page/layout `export default` is renamed to a stable,
//      route-derived symbol so the generated router can reference it.
//
// The modules are concatenated in dependency order (lib → components → pages),
// a file-based routing manifest + a mount entry are generated from the app/
// folder, and the `import 'godot.js'; import 'ui.js'; import 'react.js';`
// markers are prepended so the C++ composer pulls the runtime in ahead of the
// program.
//
// The authored dialect is ordinary React — function components, JSX, and the
// full hook surface — with the documented subset caveats in the project README
// (no spread/rest/destructuring/template-literals; names are globally unique).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import babel from "@babel/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SOURCE_EXTS = [".jsx", ".tsx", ".js", ".ts"];

// ---------------------------------------------------------------------------
// module flattening: strip imports, unwrap exports, rename default exports
// ---------------------------------------------------------------------------

function stripAndRenamePlugin({ types: t }) {
  return {
    visitor: {
      ImportDeclaration(path) {
        // Every import resolves to a runtime global (React / VUI / a sibling
        // module concatenated into the same scope), so drop the statement.
        path.remove();
      },
      ExportAllDeclaration(path) {
        path.remove();
      },
      ExportDefaultDeclaration(path) {
        const sym = this.opts.moduleSym;
        const decl = path.node.declaration;
        if (t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) {
          decl.id = t.identifier(sym);
          path.replaceWith(decl);
        } else {
          path.replaceWith(
            t.variableDeclaration("var", [
              t.variableDeclarator(t.identifier(sym), decl),
            ])
          );
        }
      },
      ExportNamedDeclaration(path) {
        if (path.node.declaration) {
          // `export function Foo` / `export var X` → keep the plain declaration
          // (its name lives in the shared global scope).
          path.replaceWith(path.node.declaration);
        } else {
          // `export { a, b }` — the names are already global; drop the re-export.
          path.remove();
        }
      },
    },
  };
}

function transformModule(source, filename, moduleSym) {
  const isTs = filename.endsWith(".ts") || filename.endsWith(".tsx");
  // Pass 1 — JSX (automatic runtime) + TypeScript type stripping.
  const pass1 = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: isTs ? [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]] : [],
    plugins: [["@babel/plugin-transform-react-jsx", { runtime: "automatic", development: false }]],
  }).code;

  // Pass 2 — flatten module structure (deterministic, after JSX injected its
  // own runtime import in pass 1).
  const pass2 = babel.transformSync(pass1, {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [[stripAndRenamePlugin, { moduleSym }]],
  }).code;

  return pass2;
}

// ---------------------------------------------------------------------------
// project scan
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (SOURCE_EXTS.includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function isPageFile(file) {
  const base = file.replace(/\.(jsx|tsx|js|ts)$/, "");
  return base.endsWith("/page") || base.endsWith("\\page");
}

function isLayoutFile(file) {
  const base = file.replace(/\.(jsx|tsx|js|ts)$/, "");
  return base.endsWith("/layout") || base.endsWith("\\layout");
}

// app/counter/page.jsx → { route: "/counter", sym: "__page__counter" }
function routeForPage(file) {
  const rel = relative(join(ROOT, "app"), file).replace(/\\/g, "/");
  const segments = rel.replace(/\/page\.(jsx|tsx|js|ts)$/, "");
  if (segments === "" || segments === "page.jsx" || segments === "page.tsx" || segments === "page.js" || segments === "page.ts") {
    return { route: "/", sym: "__page__index" };
  }
  const clean = segments.replace(/[^a-zA-Z0-9]+/g, "_");
  return { route: "/" + segments, sym: "__page__" + clean };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function loadConfig() {
  const cfgPath = join(ROOT, "victor.config.mjs");
  if (!existsSync(cfgPath)) {
    return { app: { design: [720, 1280], portrait: true, theme: "dark" }, initialRoute: "/", outFile: "build/guest.js" };
  }
  const mod = await import(pathToFileURL(cfgPath).href);
  return mod.default;
}

async function build() {
  const config = await loadConfig();
  const libFiles = walk(join(ROOT, "lib"));
  const componentFiles = walk(join(ROOT, "components"));
  const appFiles = walk(join(ROOT, "app"));

  const pages = [];
  let layoutSym = null;

  const chunks = [];
  chunks.push("// ===========================================================================");
  chunks.push("// GENERATED by tools/build.mjs — do not edit. Source: this Next.js project.");
  chunks.push("// A single Elpian-JS guest program: godot.js + ui.js + react.js are composed");
  chunks.push("// ahead of it by the engine; every module below is flattened into one scope.");
  chunks.push("// ===========================================================================");
  chunks.push("import 'godot.js';");
  if (config.net) {
    // Victor networking (HTTP + WebSocket + Socket.IO) — composed when the
    // app opts in via `net: true` in victor.config.mjs.
    chunks.push("import 'net.js';");
  }
  chunks.push("import 'ui.js';");
  chunks.push("import 'react.js';");
  chunks.push("");

  const emit = (file, sym) => {
    const src = readFileSync(file, "utf8");
    const code = transformModule(src, file, sym);
    chunks.push("// ---- " + relative(ROOT, file).replace(/\\/g, "/") + " ----");
    chunks.push(code);
    chunks.push("");
  };

  // 1) library modules (router + shared runtime helpers)
  for (const f of libFiles) emit(f, "__default__lib_" + pages.length);

  // 2) components
  for (const f of componentFiles) emit(f, "__default__cmp");

  // 3) app: layout + pages (default exports renamed to stable symbols)
  for (const f of appFiles) {
    if (isLayoutFile(f)) {
      layoutSym = "__layout__root";
      emit(f, layoutSym);
    } else if (isPageFile(f)) {
      const r = routeForPage(f);
      pages.push(r);
      emit(f, r.sym);
    } else {
      emit(f, "__default__app");
    }
  }

  // 4) generated routing manifest + mount entry
  const routeLines = pages
    .map((p) => "  { path: " + JSON.stringify(p.route) + ", component: " + p.sym + " },")
    .join("\n");
  const app = config.app || {};
  const design = app.design || [720, 1280];
  const mountOpts =
    "{ design: [" + design[0] + ", " + design[1] + "], portrait: " + (app.portrait ? "true" : "false") + ", theme: " + JSON.stringify(app.theme || "dark") + " }";

  chunks.push("// ---- generated: file-based routing manifest + mount entry ----");
  chunks.push("var __VICTOR_ROUTES = [");
  chunks.push(routeLines);
  chunks.push("];");
  const layoutRef = layoutSym ? layoutSym : "__victorPassthroughLayout";
  if (!layoutSym) {
    chunks.push("function __victorPassthroughLayout(props) { return props.children; }");
  }
  chunks.push(
    "VictorClient.mountApp(_jsx(VictorApp, { routes: __VICTOR_ROUTES, layout: " +
      layoutRef +
      ", initial: " +
      JSON.stringify(config.initialRoute || "/") +
      " }), " +
      mountOpts +
      ");"
  );
  chunks.push("");

  const outFile = join(ROOT, config.outFile || "build/guest.js");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, chunks.join("\n"), "utf8");

  console.log("victor build ✓");
  console.log("  routes : " + pages.map((p) => p.route).join(", "));
  console.log("  output : " + relative(ROOT, outFile));
  console.log("  bytes  : " + Buffer.byteLength(chunks.join("\n")));
  console.log("");
  console.log("Load it on the engine like any guest program, e.g. copy to");
  console.log("elpian/godot/project/scripts/ and point an ElpianVM node's script at it.");
}

build().catch((e) => {
  console.error("victor build ✗");
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
