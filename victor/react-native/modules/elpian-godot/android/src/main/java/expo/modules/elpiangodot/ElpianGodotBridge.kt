package expo.modules.elpiangodot

import org.godotengine.godot.Godot
import org.godotengine.godot.plugin.GodotPlugin
import org.godotengine.godot.plugin.UsedByGodot

// A Godot plugin registered with the embedded engine so the OpSink scene can
// pull the 3D ops the React Native side queued. pollOps() drains the native
// queue (shared with the JSI __ElpianGodot.op push side, in libelpiangodot_jsi)
// and hands the OpSink a JSON array of messages to apply this frame.
class ElpianGodotBridge(godot: Godot) : GodotPlugin(godot) {
  override fun getPluginName(): String = "ElpianGodotBridge"

  @UsedByGodot
  fun pollOps(): String = nativePollOps()

  // Diagnostics: the OpSink reports its built-scene summary here (~1x/sec); the
  // RN overlay surfaces it via __ElpianGodot.stats() to diagnose a blank viewport.
  @UsedByGodot
  fun report(summary: String) = nativeReport(summary)

  private external fun nativePollOps(): String
  private external fun nativeReport(summary: String)

  companion object {
    init {
      System.loadLibrary("elpiangodot_jsi")
    }
  }
}
