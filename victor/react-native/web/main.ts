// Web entry for the Victor showcase — the zero-React DOM path. Boots the Elpian
// VM (elpian_rn.wasm), runs the showcase guest program, and renders its widget
// tree as real DOM through mountDom (no React). This is the browser twin of the
// on-device native-widget host: one Elpian VM driving the platform's own widgets.
import { mountDom } from "../src/render/mountDom.ts";
import { SHOWCASE_GUEST_SOURCE } from "../src/example/showcaseSource.ts";

async function boot(): Promise<void> {
  const status = document.getElementById("status");
  try {
    const res = await fetch("./elpian_rn.wasm");
    if (!res.ok) throw new Error(`fetch elpian_rn.wasm: ${res.status}`);
    const wasmBytes = await res.arrayBuffer();
    const container = document.getElementById("root")!;
    const rt = await mountDom({
      wasmBytes,
      source: SHOWCASE_GUEST_SOURCE,
      container,
      onLog: (line) => {
        // Surface guest logs for the Playwright end-to-end test to read.
        (window as unknown as { __victorLog: string[] }).__victorLog ??= [];
        (window as unknown as { __victorLog: string[] }).__victorLog.push(line);
        // eslint-disable-next-line no-console
        console.log("[guest]", line);
      },
    });
    (window as unknown as { __victor: unknown }).__victor = rt;
    (window as unknown as { __victorReady: boolean }).__victorReady = true;
    if (status) status.remove();
  } catch (e) {
    (window as unknown as { __victorError: string }).__victorError = String(e);
    if (status) {
      status.textContent = `Boot failed: ${String(e)}`;
      status.style.color = "#f87171";
    }
    // eslint-disable-next-line no-console
    console.error(e);
  }
}

boot();
