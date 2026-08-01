package expo.modules.elpianwidgets

import android.util.Log
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Installs the JSI binding global.__ElpianWidgets (see cpp/ElpianWidgetsJsi.cpp),
// which NativeWidgetRenderer drives, and registers the VictorSurfaceView that
// hosts the VM-driven native widget tree. install() returns a status string.
class ElpianWidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ElpianWidgets")

    OnCreate { tryInstall() }

    Function("install") { tryInstall() }

    View(VictorSurfaceView::class) {
      // No props: the VM drives the tree through the op stream, not view props.
    }
  }

  private fun tryInstall(): String {
    try {
      System.loadLibrary("elpianwidgets_jsi")
    } catch (t: Throwable) {
      Log.e(TAG, "loadLibrary failed", t)
      return "loadLibrary: ${t.message}"
    }
    val reactContext = appContext.reactContext as? ReactContext ?: return "no-react-context"
    val jsiPtr = reactContext.javaScriptContextHolder?.get() ?: 0L
    if (jsiPtr == 0L) return "no-runtime-pointer(bridgeless=${reactContext.isBridgeless})"
    return try {
      nativeInstall(jsiPtr)
      "ok"
    } catch (t: Throwable) {
      Log.e(TAG, "nativeInstall failed", t)
      "nativeInstall: ${t.message}"
    }
  }

  private external fun nativeInstall(jsiPtr: Long)

  companion object {
    private const val TAG = "ElpianWidgetsModule"
  }
}
