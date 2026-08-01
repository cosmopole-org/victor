// The wasm module imports a single function, `host_call`, from the JavaScript
// host (see `src/lib.rs`). Recent `wasm-ld` errors on undefined symbols by
// default instead of emitting them as imports, so tell it — for this crate's
// wasm artifact only — to generate imports for undefined symbols. This is
// crate-scoped (rustc-link-arg applies to this package's linked output), so it
// does not affect the native rlib build or any other crate.
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.starts_with("wasm32") {
        println!("cargo:rustc-link-arg=--import-undefined");
    }
    // Android: give the cdylib a SONAME so anything linking against it (the
    // elpianrn_jsi JSI glue) records a plain `libelpian_rn.so` DT_NEEDED rather
    // than the on-disk path CMake hands the linker. Without a SONAME the APK's
    // flat lib dir can't satisfy the dependency and dlopen fails at runtime.
    if target.contains("android") {
        println!("cargo:rustc-link-arg=-Wl,-soname,libelpian_rn.so");
    }
}
