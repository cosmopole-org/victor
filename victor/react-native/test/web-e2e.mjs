// End-to-end web test: serve web/, boot the real Elpian VM (wasm) in a real
// browser (Chromium via Playwright), and verify the showcase renders as DOM and
// is interactive — no device, no guessing. Run: node test/web-e2e.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const CHROME =
  process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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
        // COOP/COEP for wasm threads/SharedArrayBuffer if ever needed; harmless.
        res.writeHead(200);
        res.end(data);
      });
    });
    server.listen(0, () => resolve(server));
  });
}

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    console.log(`  FAIL  ${name}`);
    failures++;
  }
}

async function main() {
  const server = await serve(WEB_DIR);
  const port = server.address().port;
  const url = `http://localhost:${port}/`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => window.__victorReady === true || window.__victorError,
      null,
      { timeout: 30000 },
    );
    const bootErr = await page.evaluate(() => window.__victorError || null);
    check("VM boots with no error", !bootErr);
    if (bootErr) console.log("    boot error:", bootErr);

    // The showcase header + counter should be real DOM text.
    const text = await page.evaluate(() => document.body.innerText);
    check("header rendered", text.includes("Victor"));
    check("counter starts at 0", text.includes("Count: 0"));
    check("text input echo rendered", text.includes("Hello there!"));

    // Interact: click the "+" button and confirm the VM updated the DOM.
    const plus = page.getByText("+", { exact: true }).first();
    await plus.click();
    await plus.click();
    await page.waitForFunction(
      () => document.body.innerText.includes("Count: 2"),
      null,
      { timeout: 5000 },
    );
    const after = await page.evaluate(() => document.body.innerText);
    check("counter increments to 2 after two taps", after.includes("Count: 2"));

    // Type into the input and confirm the echo updates (changeText -> VM -> DOM).
    const input = page.locator('input').first();
    await input.fill("Ada");
    await page.waitForFunction(
      () => document.body.innerText.includes("Hello, Ada!"),
      null,
      { timeout: 5000 },
    );
    const echoed = await page.evaluate(() => document.body.innerText);
    check("input echo updates via VM", echoed.includes("Hello, Ada!"));

    check("no console/page errors", errors.length === 0);
    if (errors.length) console.log("    errors:", errors.slice(0, 5));

    await page.screenshot({ path: path.join(WEB_DIR, "e2e-screenshot.png"), fullPage: true });
    console.log("  screenshot: web/e2e-screenshot.png");
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? "\nWEB_E2E_RESULT: PASS" : `\nWEB_E2E_RESULT: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  console.log("\nWEB_E2E_RESULT: FAIL (exception)");
  process.exit(1);
});
