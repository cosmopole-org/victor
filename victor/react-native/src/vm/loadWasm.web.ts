// Web wasm loader. Fetches the `elpian_rn.wasm` module built from
// `native/elpian-rn`. Place the file where the web build serves static assets
// (e.g. the Expo `web/` public dir or `public/`) and point `VICTOR_WASM_URL` at
// it if the default path differs.

const DEFAULT_URL = "./elpian_rn.wasm";

export async function loadWasmBytes(): Promise<BufferSource> {
  const url =
    (typeof process !== "undefined" &&
      process.env &&
      (process.env.VICTOR_WASM_URL as string)) ||
    DEFAULT_URL;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return await res.arrayBuffer();
}
