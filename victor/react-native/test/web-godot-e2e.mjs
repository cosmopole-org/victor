// End-to-end web 3D test: serve web/, boot the real Elpian VM (wasm) AND the
// embedded Godot HTML5 export in a real headless browser, and verify the
// GDExtension loads, the RN→Godot op pipeline drains, and the Scene3D canvas
// renders actual (non-uniform) 3D pixels — no device, no guessing.
//
// Run: node test/web-godot-e2e.mjs
// Headless WebGL needs SwiftShader; we pass the ANGLE/SwiftShader flags below.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium/chrome-linux/chrome",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const CHROME = resolveChrome();
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json",
  ".pck": "application/octet-stream",
};

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = path.join(dir, p);
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
        res.writeHead(200);
        res.end(data);
      });
    });
    server.listen(0, () => resolve(server));
  });
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

// Decode a PNG's raw RGBA to measure pixel variance (proves the canvas isn't a
// flat single-color fill — i.e. the 3D scene actually rendered).
function pngVariance(buf) {
  // Minimal PNG IDAT reader: concat IDAT chunks, inflate, unfilter is complex —
  // instead sample distinct 4-byte words in the inflated stream as a cheap
  // "is there structure" proxy. Good enough to distinguish a solid fill from a
  // rendered scene.
  let off = 8; // skip signature
  const idat = [];
  let width = 0;
  let height = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const seen = new Set();
  for (let i = 0; i + 4 <= raw.length; i += 4) {
    seen.add(raw.readUInt32LE(i));
    if (seen.size > 64) break;
  }
  return { width, height, distinct: seen.size };
}

async function main() {
  const server = await serve(WEB_DIR);
  const port = server.address().port;
  const url = `http://localhost:${port}/`;
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  const errors = [];
  const logs = [];
  page.on("console", (m) => {
    logs.push(m.text());
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => window.__victorReady === true || window.__victorError, null, {
      timeout: 30000,
    });
    check("VM boots", await page.evaluate(() => window.__victorReady === true));

    // Godot boot: wait for either booted or error.
    await page.waitForFunction(() => window.__godotBooted === true || window.__godotError, null, {
      timeout: 90000,
    });
    const godotErr = await page.evaluate(() => window.__godotError || null);
    check("Godot engine boots (no boot error)", !godotErr, godotErr || "");
    check("Godot booted flag set", await page.evaluate(() => window.__godotBooted === true));

    // No GDExtension dynamic-library load failures in the console.
    const dlErrors = errors.filter(
      (e) => /dynamic library|dynamic lib|libelpian_godot|\.gdextension|synchronous loading/i.test(e),
    );
    check("no GDExtension dynamic-library errors", dlErrors.length === 0, dlErrors.slice(0, 3).join(" | "));

    // Give the scene a moment to build from the drained op queue and render a
    // few frames, then confirm the op queue was consumed by the OpSink.
    await page.waitForFunction(
      () => (window.__elpianGodotQueue ? window.__elpianGodotQueue.length === 0 : false),
      null,
      { timeout: 30000 },
    ).catch(() => {});
    const queueLen = await page.evaluate(() => window.__elpianGodotQueue?.length ?? -1);
    check("op queue drained by Godot OpSink", queueLen === 0, `remaining=${queueLen}`);

    // Let a handful of frames render.
    await page.waitForTimeout(3000);

    // Capture the Scene3D canvas and assert it rendered structured pixels (not a
    // uniform fill) — the real proof the embedded 3D world is on screen.
    const canvas = page.locator('canvas[data-victor="scene3d"]');
    check("Scene3D canvas present", (await canvas.count()) > 0);
    if ((await canvas.count()) > 0) {
      const shot = await canvas.screenshot({ path: path.join(WEB_DIR, "e2e-godot.png") });
      const v = pngVariance(shot);
      console.log(`    canvas ${v.width}x${v.height}, distinct pixel-words: ${v.distinct}`);
      check("Scene3D canvas rendered non-uniform pixels", v.distinct > 3, `distinct=${v.distinct}`);
    }

    console.log("  screenshot: web/e2e-godot.png");
  } finally {
    // Surface a compact log tail for diagnosis on failure.
    if (failures > 0) {
      console.log("\n--- console tail ---");
      for (const l of logs.slice(-40)) console.log("   ", l);
    }
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? "\nWEB_GODOT_E2E_RESULT: PASS" : `\nWEB_GODOT_E2E_RESULT: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  console.log("\nWEB_GODOT_E2E_RESULT: FAIL (exception)");
  process.exit(1);
});
