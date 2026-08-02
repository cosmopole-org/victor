// Web Godot integration: install the __ElpianGodotWeb binding the RN VM's
// WebGodotEngine posts 3D ops to, and boot the embedded Godot HTML5 export into
// the Scene3D widget's <canvas>. The Godot OpSink (in the export) drains the
// queue over JavaScriptBridge (window.__elpianGodotDrain) and renders the scene.
//
// Sequence (see main.ts): installGodotWeb() first so WebGodotEngine.isAvailable()
// is true → mountDom builds the DOM incl. the Scene3D canvas and queues 3D ops →
// bootGodot(canvas) starts Godot into that canvas and it drains the queued ops.

declare global {
  // eslint-disable-next-line no-var
  var Engine: (new (config: Record<string, unknown>) => GodotEngineInstance) | undefined;
  // eslint-disable-next-line no-var
  var __elpianGodotQueue: string[] | undefined;
  // eslint-disable-next-line no-var
  var __elpianGodotDrain: (() => string) | undefined;
}

interface GodotEngineInstance {
  startGame(override?: Record<string, unknown>): Promise<void>;
}

/** Install the op queue + the __ElpianGodotWeb binding WebGodotEngine drives. */
export function installGodotWeb(): void {
  const g = globalThis as typeof globalThis & {
    __elpianGodotQueue?: string[];
    __elpianGodotDrain?: () => string;
    __ElpianGodotWeb?: unknown;
  };
  g.__elpianGodotQueue = [];
  // WebGodotEngine.op posts one op JSON; wrap it as the {op:…} / {mount:…}
  // messages the OpSink._apply expects (the twin of the Android op queue).
  g.__ElpianGodotWeb = {
    op(opJson: string) {
      g.__elpianGodotQueue!.push(`{"op":${opJson}}`);
    },
    mountSurface(_surfaceId: number, _canvas: unknown, mountNode: number) {
      g.__elpianGodotQueue!.push(`{"mount":${mountNode}}`);
    },
    releaseSurface() {},
    stats() {
      return JSON.stringify({ queued: g.__elpianGodotQueue!.length });
    },
  };
  // Drained by the Godot OpSink each frame via JavaScriptBridge.
  g.__elpianGodotDrain = () => {
    const q = g.__elpianGodotQueue!;
    if (q.length === 0) return "";
    const out = `[${q.join(",")}]`;
    q.length = 0;
    return out;
  };
}

/**
 * Boot the Godot HTML5 export into `canvas`. Loads the engine glue script
 * (elpian_godot.js) if not already present, then starts the game rendering into
 * the given canvas. Resolves once startGame has been kicked off.
 *
 * The export's files are served flat alongside index.html (the layout Godot's
 * own web export assumes), so every path here is a page-relative basename.
 * This matters most for the GDExtension side module: Godot's web dlopen loads
 * libraries by basename (OS_Web uses get_file() of the res://bin/… path), and
 * Emscripten registers each `gdextensionLibs` entry under the *exact* string
 * given — so the entry MUST be the bare basename `libelpian_godot.web.wasm32.wasm`
 * for the dlopen to resolve. A subdir-prefixed entry registers under the wrong
 * key and dlopen falls back to a synchronous fetch that browsers can't do,
 * failing with "file not found, synchronous loading … not available".
 */
export async function bootGodot(canvas: HTMLCanvasElement): Promise<void> {
  await loadScript("./elpian_godot.js");
  const EngineCtor = (globalThis as { Engine?: new (c: Record<string, unknown>) => GodotEngineInstance }).Engine;
  if (!EngineCtor) throw new Error("Godot Engine glue did not define window.Engine");
  // Emscripten derives an event-target selector from the canvas id, so it must
  // have one (an id-less canvas resolves to querySelector('#') and throws).
  if (!canvas.id) canvas.id = "victor-godot-canvas";
  const engine = new EngineCtor({
    canvas,
    executable: "elpian_godot",
    mainPack: "elpian_godot.pck",
    // Bare basename: matches Godot web's basename dlopen AND is fetchable
    // page-relative (both are the same string; see the note above).
    gdextensionLibs: ["libelpian_godot.web.wasm32.wasm"],
    // nothreads build → no SharedArrayBuffer/COOP/COEP requirement, so don't
    // block on cross-origin-isolation headers (plain static hosting works).
    ensureCrossOriginIsolationHeaders: false,
    canvasResizePolicy: 1, // fit the project to the Scene3D canvas's size
    focusCanvas: false,
  });
  await engine.startGame();
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-godot="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.godot = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}
