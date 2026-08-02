import ExpoModulesCore

// Installs the JSI binding global.__ElpianWidgets (shared cpp/ElpianWidgetsJsi.cpp),
// which NativeWidgetRenderer drives, and registers VictorSurfaceView that hosts
// the VM-driven native UIView tree. install() returns a status string. iOS twin
// of ElpianWidgetsModule.kt.
public class ElpianWidgetsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ElpianWidgets")

    OnCreate { _ = self.tryInstall() }

    Function("install") { return self.tryInstall() }

    View(VictorSurfaceView.self) {
      // The only prop: which mini-app scope this surface hosts. The VM drives the
      // tree through the op stream; appId just routes that stream to this surface.
      Prop("appId") { (view: VictorSurfaceView, appId: String) in
        view.appId = appId
      }
    }
  }

  private func tryInstall() -> String {
    // See ElpianRnModule.swift: `appContext?.runtime?.pointer` is the Expo SDK 52
    // accessor for the jsi::Runtime; verify this one line on a Mac build.
    guard let runtime = appContext?.runtime else { return "no-runtime-pointer" }
    return ElpianWidgetsBridge.install(withRuntimePointer: UInt(bitPattern: runtime.pointer))
  }
}
