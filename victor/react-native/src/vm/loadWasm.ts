// Default (native) wasm loader. React Native's Hermes engine has no built-in
// WebAssembly runtime, so the production native path is the JSI backend: build
// `native/elpian-rn` as a static lib and expose it as an Expo module that
// implements `VmBackend` directly (no wasm at all). Until that module is
// installed, this throws a clear message; Expo **web** uses `loadWasm.web.ts`,
// which runs the real `.wasm`. Metro picks the right file by platform extension.

export async function loadWasmBytes(): Promise<BufferSource> {
  throw new Error(
    "No WebAssembly runtime on this platform. Use the native JSI VmBackend " +
      "(build native/elpian-rn as an Expo module) or run on Expo web, which " +
      "loads elpian_rn.wasm directly.",
  );
}
