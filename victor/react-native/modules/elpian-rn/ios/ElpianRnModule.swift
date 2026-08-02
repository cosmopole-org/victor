import ExpoModulesCore

// Installs the synchronous JSI binding global.__ElpianRN (see
// cpp/ElpianRnJsi.cpp, shared with Android) that NativeVmBackend drives. The
// binding calls straight into the Rust VM (libelpian_rn) and calls back into JS
// in-line for each host call — the synchronous seam Hermes needs since it has no
// WebAssembly. iOS twin of ElpianRnModule.kt.
public class ElpianRnModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ElpianRn")

    // Best-effort early install; JS calls install() again once the runtime is
    // definitely up. Ignore the result here.
    OnCreate {
      _ = self.tryInstall()
    }

    // JS-callable install: returns a status string so the app can surface exactly
    // what happened. "ok" = installed; anything else is the reason it did not.
    Function("install") {
      return self.tryInstall()
    }
  }

  private func tryInstall() -> String {
    // Resolve the jsi::Runtime pointer from the Expo app context. Expo exposes
    // the runtime the module runs on; its raw pointer is what the shared C++
    // installer needs. Absent (rare startup races) → report it.
    //
    // NOTE (verify on a Mac build): `appContext?.runtime?.pointer` is the
    // Expo SDK 52 accessor; the exact property may shift across Expo versions —
    // this is the one line to confirm against the installed expo-modules-core.
    guard let runtime = appContext?.runtime else {
      return "no-runtime-pointer"
    }
    return ElpianRnInstaller.install(withRuntimePointer: UInt(bitPattern: runtime.pointer))
  }
}
