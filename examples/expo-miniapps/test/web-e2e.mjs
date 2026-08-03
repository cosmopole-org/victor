// End-to-end web test for the sample Expo app: serve the `expo export` output
// (dist/), boot it in real headless Chromium via Playwright, and verify the two
// Victor mini apps render (react-native-web), run their own isolated VMs, are
// interactive, and respond to the object-oriented controller's lifecycle
// controls — no device, no guessing.
//
// Run: npm run export:web && node test/web-e2e.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

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
  ".map": "application/json",
};

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      let file = path.join(dir, p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // SPA fallback so client routes resolve to the app shell.
        file = path.join(dir, "index.html");
      }
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

async function main() {
  const server = await serve(DIST);
  const port = server.address().port;
  const url = `http://localhost:${port}/`;
  const browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 1100 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  try {
    await page.goto(url, { waitUntil: "load" });

    // The app shell renders immediately; the mini apps appear once the VM
    // (wasm) boots and each mounts its widget tree.
    await page.waitForFunction(() => document.body.innerText.includes("Victor mini apps"), null, {
      timeout: 30000,
    });
    check("app shell rendered (title present)", true);

    // Both isolated mini apps mount their own trees.
    await page.waitForFunction(
      () => {
        const t = document.body.innerText;
        return t.includes("Count: 0") && t.includes("Hello there!");
      },
      null,
      { timeout: 30000 },
    );
    check("counter mini app mounted (Count: 0)", true);
    check("greeter mini app mounted (Hello there!)", true);

    // Interact with the counter: tap +1 twice → VM updates its own label only.
    const plus = page.getByText("+1", { exact: true }).first();
    await plus.click();
    await plus.click();
    await page.waitForFunction(() => document.body.innerText.includes("Count: 2"), null, {
      timeout: 5000,
    });
    check("counter increments to 2 (event → VM → DOM)", true);
    // The greeter is untouched by the counter's events.
    check(
      "greeter unaffected by counter events (isolation)",
      (await page.evaluate(() => document.body.innerText)).includes("Hello there!"),
    );

    // Interact with the greeter input: type → its VM echoes a greeting.
    const input = page.locator("input").first();
    await input.fill("Ada");
    await page.waitForFunction(() => document.body.innerText.includes("Hello, Ada!"), null, {
      timeout: 5000,
    });
    check("greeter echoes typed name (changeText → VM → DOM)", true);

    // Controller lifecycle: Restart counter → fresh VM, counter resets to 0.
    await page.locator('[data-testid="restart-counter"]').click();
    await page.waitForFunction(
      () => {
        const t = document.body.innerText;
        return t.includes("Count: 0") && !t.includes("Count: 2");
      },
      null,
      { timeout: 5000 },
    );
    check("controller.restart('counter') reboots it (Count back to 0)", true);

    // Controller lifecycle: Stop greeter → its VM is freed, cell empties, and
    // the app's live status reflects it.
    await page.locator('[data-testid="stop-greeter"]').click();
    await page.waitForFunction(() => document.body.innerText.includes("greeter=stopped"), null, {
      timeout: 5000,
    });
    const afterStop = await page.evaluate(() => document.body.innerText);
    check("controller.stop('greeter') frees it (status=stopped)", afterStop.includes("greeter=stopped"));
    check("stopped greeter's tree is gone (no 'Hello')", !afterStop.includes("Hello,") && !afterStop.includes("Hello there!"));

    // Controller lifecycle: Start greeter → boots a fresh VM again.
    await page.locator('[data-testid="start-greeter"]').click();
    await page.waitForFunction(() => document.body.innerText.includes("Hello there!"), null, {
      timeout: 5000,
    });
    check("controller.start('greeter') reboots it (Hello there! back)", true);

    check("no console/page errors", errors.length === 0, errors.slice(0, 4).join(" | "));

    await page.screenshot({ path: path.join(DIST, "..", "e2e-screenshot.png"), fullPage: true });
    console.log("  screenshot: e2e-screenshot.png");
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures === 0 ? "\nEXPO_MINIAPPS_E2E: PASS" : `\nEXPO_MINIAPPS_E2E: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  console.log("\nEXPO_MINIAPPS_E2E: FAIL (exception)");
  process.exit(1);
});
