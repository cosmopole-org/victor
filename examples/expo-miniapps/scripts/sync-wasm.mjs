// Copy the Elpian VM module the installed `victor-react-native` ships into this
// app's `public/` folder, so the Expo web export serves it as a static asset the
// app fetches at runtime (public/ is copied verbatim into dist/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "node_modules", "victor-react-native", "web", "elpian_rn.wasm");
const dst = path.join(root, "public", "elpian_rn.wasm");

if (!fs.existsSync(src)) {
  console.error(
    `sync-wasm: ${src} not found.\n` +
      "Run `npm run pack:lib && npm install` first to install victor-react-native.",
  );
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log(`sync-wasm: ${path.relative(root, dst)} (${fs.statSync(dst).size} bytes)`);
