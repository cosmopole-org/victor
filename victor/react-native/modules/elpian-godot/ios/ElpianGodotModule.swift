import ExpoModulesCore

// Installs the JSI binding global.__ElpianGodot (shared cpp/ElpianGodotJsi.cpp),
// which GodotScene3dEngineCore drives, and registers ElpianGodotView that hosts
// the embedded engine's viewport. install() returns a status string. iOS twin of
// ElpianGodotModule.kt.
public class ElpianGodotModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ElpianGodot")

    OnCreate { _ = self.tryInstall() }

    Function("install") { return self.tryInstall() }

    View(ElpianGodotView.self) {
      // No props: RN drives the 3D world through the VM's op stream, not view props.
    }
  }

  private func tryInstall() -> String {
    // See ElpianRnModule.swift: `appContext?.runtime?.pointer` is the Expo SDK 52
    // accessor for the jsi::Runtime; verify this one line on a Mac build.
    guard let runtime = appContext?.runtime else { return "no-runtime-pointer" }
    return ElpianGodotBridge.install(withRuntimePointer: UInt(bitPattern: runtime.pointer))
  }
}
