#!/usr/bin/env node
// Patch a Godot 4.3 web (dlink) export's index.js so GDExtension side modules
// built with Emscripten-style exception/setjmp handling can actually run.
//
// Root cause of the crash this fixes: Rust's prebuilt wasm32-unknown-emscripten
// std is compiled with emscripten-style panic unwinding, so the extension
// .wasm side module imports invoke_* thunks (and __cxa_find_matching_catch_2/4)
// from the main module. Godot's official web templates are built with
// exception catching disabled, so their JS glue neither defines those symbols
// nor synthesizes invoke_* wrappers in resolveGlobalSymbol (upstream emscripten
// only links createInvokeFunction into MAIN_MODULE builds that keep exception
// catching enabled). The export therefore loads, and the extension's first
// landing-pad call aborts with:
//   Aborted(Assertion failed: undefined symbol 'invoke_viii'. ...)
//
// The patch teaches resolveGlobalSymbol to synthesize the missing symbols,
// mirroring emscripten 3.1.64's own createInvokeFunction semantics
// (stackSave/try/dynCall/catch/stackRestore/setThrew). Note an actual throw
// still aborts — the official template's __cxa_throw is an abort stub — which
// makes Rust panics behave like panic=abort in the browser. Full unwinding
// would require custom-built Godot templates with exceptions enabled.
//
// Usage: node patch-web-export.mjs path/to/index.js
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node patch-web-export.mjs <exported index.js>");
  process.exit(2);
}

// Exact minified body of resolveGlobalSymbol in Godot 4.3-stable's official
// web dlink templates (emscripten 3.1.64).
const ANCHOR =
  "var resolveGlobalSymbol=(symName,direct=false)=>{var sym;" +
  "if(isSymbolDefined(symName)){sym=wasmImports[symName]}" +
  "return{sym:sym,name:symName}};";

const REPLACEMENT =
  "var createDylinkInvokeFunction=sig=>function(ptr,...args){var sp=stackSave();" +
  'try{return getWasmTableEntry(ptr)(...args)}catch(e){stackRestore(sp);if(e!==e+0)throw e;_setThrew(1,0);if(sig[0]=="j")return 0n}};' +
  "var resolveGlobalSymbol=(symName,direct=false)=>{var sym;" +
  "if(isSymbolDefined(symName)){sym=wasmImports[symName]}" +
  'else if(symName.startsWith("invoke_")){sym=wasmImports[symName]=createDylinkInvokeFunction(symName.split("_")[1])}' +
  'else if(symName.startsWith("__cxa_find_matching_catch_")){sym=wasmImports[symName]=wasmImports["__cxa_find_matching_catch"]||function(){abort("missing __cxa_find_matching_catch")}}' +
  "return{sym:sym,name:symName}};";

const src = readFileSync(path, "utf8");
if (src.includes("createDylinkInvokeFunction")) {
  console.log(`${path}: already patched`);
  process.exit(0);
}
if (!src.includes(ANCHOR)) {
  console.error(
    `${path}: patch anchor not found — the Godot web template's ` +
      "resolveGlobalSymbol changed (different Godot/emscripten version?); " +
      "re-derive the patch against the new template.",
  );
  process.exit(1);
}
writeFileSync(path, src.replace(ANCHOR, REPLACEMENT));
console.log(`${path}: patched (invoke_* + __cxa_find_matching_catch_* synthesis)`);
