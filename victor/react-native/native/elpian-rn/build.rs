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
}
