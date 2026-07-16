//! Scratch diagnostics for the TritonLand boot gate: (1) the connect()
//! URL-normalization logic runs correctly in the VM, and (2) the full
//! production guest.js (import markers stripped, as the composer does)
//! compiles through js2elpian without dialect errors.

use elpian_vm::api;

fn run_js_and_call(id: &str, js: &str, func: &str) -> String {
    assert!(js2elpian::create_vm_from_js(id.to_string(), js.to_string()), "JS should compile");
    let _ = api::execute_vm(id.to_string());
    api::execute_vm_func(id.to_string(), func.to_string(), 1).result_value
}

#[test]
fn connect_url_normalization_runs_in_vm() {
    let js = r#"
function f() {
  var serverUrl = "  https://tritonland.onrender.com/  ";
  var origin = serverUrl.trim();
  while (origin != "" && origin.substring(origin.length - 1, origin.length) == "/") {
    origin = origin.substring(0, origin.length - 1);
  }
  if (!(origin.startsWith("http://") || origin.startsWith("https://"))) {
    return "REJECTED";
  }
  return origin;
}
"#;
    assert_eq!(
        run_js_and_call("tl-url", js, "f"),
        "\"https://tritonland.onrender.com\""
    );
}

#[test]
fn production_guest_compiles() {
    let raw = std::fs::read_to_string("/home/user/TritonLand/victor-client/build/guest.js")
        .expect("guest.js must be built first (node tools/build.mjs)");
    // The C++ composer consumes the import markers and prepends the preludes;
    // for a compile-only check we just strip them.
    let body: String = raw
        .lines()
        .filter(|l| !l.trim_start().starts_with("import "))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        js2elpian::create_vm_from_js("tl-guest".to_string(), body),
        "the production guest failed to compile in js2elpian"
    );
}
