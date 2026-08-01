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

  private external fun nativePollOps(): String

  companion object {
    init {
      System.loadLibrary("elpiangodot_jsi")
    }
  }
}
