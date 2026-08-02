package expo.modules.elpiangodot

import android.content.Context
import org.godotengine.godot.Godot
import org.godotengine.godot.GodotFragment
import org.godotengine.godot.plugin.GodotPlugin
import java.io.File

// The embedded Godot engine as an Android Fragment. It loads the op-sink project
// (embed.pck, shipped in assets) via --main-pack and registers the
// ElpianGodotBridge plugin so the OpSink scene can pull queued 3D ops.
class ElpianGodotFragment : GodotFragment() {

  override fun getCommandLine(): MutableList<String> {
    val ctx = context ?: return mutableListOf()
    val pck = extractPck(ctx)
    return mutableListOf("--main-pack", pck.absolutePath)
  }

  override fun getHostPlugins(engine: Godot): MutableSet<GodotPlugin> {
    return mutableSetOf(ElpianGodotBridge(engine))
  }

  companion object {
    // Godot reads --main-pack from the filesystem, not the APK assets, so copy
    // the packed op-sink project out to the app's files dir. ALWAYS overwrite:
    // app data (filesDir) survives an install-over, so any conditional copy risks
    // serving a stale pck from a previous build forever (which kept the old
    // landscape orientation and the pre-report OpSink alive on device). The pck is
    // a few KB, so copying it on every launch is negligible and removes all doubt.
    private fun extractPck(ctx: Context): File {
      val out = File(ctx.filesDir, "elpian-embed.pck")
      ctx.assets.open("godot/embed.pck").use { input ->
        out.outputStream().use { input.copyTo(it) }
      }
      return out
    }
  }
}
