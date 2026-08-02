package expo.modules.elpianwidgets

import android.content.Context
import android.graphics.Color
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.core.widget.NestedScrollView
import com.google.android.flexbox.AlignItems
import com.google.android.flexbox.FlexDirection
import com.google.android.flexbox.FlexWrap
import com.google.android.flexbox.FlexboxLayout
import com.google.android.flexbox.JustifyContent
import org.json.JSONArray
import org.json.JSONObject

// Maps the VM's rn.op stream to a real android.view.View tree — no React. One
// controller per VictorSurfaceView. Flex containers use FlexboxLayout so the
// guest's flexbox styling lays out natively; the 15 widget KINDs (resolved on
// the JS side and sent as `k`) each map to a native widget. Events set native
// listeners that enqueue back to the VM via the host.
class WidgetController(
  private val context: Context,
  private val root: FlexboxLayout,
  private val host: VictorSurfaceView,
) {
  private class Entry(
    val view: View,
    val content: ViewGroup, // where children attach (== view unless a scroller)
    val kind: String,
    val props: MutableMap<String, Any?> = HashMap(),
    val events: MutableMap<String, Long> = HashMap(),
  )

  // Widget ids are 64-bit handles: the VM manager packs the owning VM id into the
  // high 32 bits (encode_handle => 2^32*vm + local), so ids routinely exceed
  // Int range. Parsing them as Int would truncate (2^32+9 -> 9) and desync the
  // native id from the JS side, so every id is a Long end to end.
  private val entries = HashMap<Long, Entry>()
  private val density = context.resources.displayMetrics.density

  private fun dp(v: Double): Int = (v * density).toInt()

  // Apply one op message (see NativeWidgetRenderer.send).
  fun apply(op: JSONObject) {
    when (op.optString("t")) {
      "create" -> create(op.getLong("id"), op.optString("cls"), op.optString("k", "view"))
      "set" -> setProp(op.getLong("id"), op.optString("k"), op.opt("v"))
      "connect" -> connect(op.getLong("id"), op.optString("e"), op.optLong("cb"))
      "disconnect" -> entries[op.getLong("id")]?.events?.remove(op.optString("e"))
      "add" -> addChild(op.getLong("p"), op.getLong("c"), op.optInt("i", -1))
      "remove" -> removeChild(op.getLong("p"), op.getLong("c"))
      "clear" -> entries[op.getLong("p")]?.content?.removeAllViews()
      "free" -> entries.remove(op.getLong("id"))
      "root" -> setRoot(op.getLong("id"))
      "toast" -> android.widget.Toast.makeText(context, op.optString("m"), android.widget.Toast.LENGTH_SHORT).show()
    }
  }

  private fun create(id: Long, cls: String, kind: String) {
    val (view, content) = build(kind)
    entries[id] = Entry(view, content, kind)
  }

  private fun build(kind: String): Pair<View, ViewGroup> {
    return when (kind) {
      "text" -> {
        val t = TextView(context)
        Pair(t, root) // text is a leaf; children (nested Text) are rare — flatten
      }
      "input" -> {
        val e = EditText(context)
        Pair(e, root)
      }
      "switch" -> Pair(SwitchCompat(context), root)
      "slider" -> Pair(SeekBar(context), root)
      "button", "victorButton" -> Pair(Button(context), root)
      "activity" -> Pair(ProgressBar(context), root)
      "image" -> Pair(ImageView(context), root)
      "scene3d" -> Pair(View(context), root) // GodotView is attached by the Godot module
      "scroll" -> {
        val sv = NestedScrollView(context)
        val inner = FlexboxLayout(context).apply { flexDirection = FlexDirection.COLUMN }
        sv.addView(inner, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        Pair(sv, inner)
      }
      else -> { // view, list, imageBackground, status, refresh
        val f = FlexboxLayout(context).apply { flexDirection = FlexDirection.COLUMN }
        Pair(f, f)
      }
    }
  }

  private fun setProp(id: Long, key: String, value: Any?) {
    val e = entries[id] ?: return
    e.props[key] = value
    val v = e.view
    when (key) {
      "text", "title" -> if (v is TextView) v.text = value?.toString() ?: ""
      "value" -> when (v) {
        is EditText -> if (v.text.toString() != value?.toString()) v.setText(value?.toString() ?: "")
        is SwitchCompat -> v.isChecked = value == true
        is SeekBar -> v.progress = ((value as? Number)?.toInt() ?: 0)
      }
      "placeholder" -> if (v is EditText) v.hint = value?.toString()
      "secure" -> if (v is EditText && value == true) v.inputType = android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD or android.text.InputType.TYPE_CLASS_TEXT
      "min" -> if (v is SeekBar) v.min = ((value as? Number)?.toInt() ?: 0)
      "max" -> if (v is SeekBar) v.max = ((value as? Number)?.toInt() ?: 100)
      "src", "source" -> {} // image loading TBD (URI/asset)
      else -> applyStyle(e, key, value)
    }
  }

  // Layout + visual style. Numbers are dp; flex props go on FlexboxLayout params.
  private fun applyStyle(e: Entry, key: String, value: Any?) {
    val v = e.view
    val num = (value as? Number)?.toDouble()
    when (key) {
      "bg", "backgroundColor" -> parseColor(value)?.let { v.setBackgroundColor(it) }
      "color" -> if (v is TextView) parseColor(value)?.let { v.setTextColor(it) }
      "padding" -> num?.let { val p = dp(it); v.setPadding(p, p, p, p) }
      "paddingH" -> num?.let { val p = dp(it); v.setPadding(p, v.paddingTop, p, v.paddingBottom) }
      "paddingV" -> num?.let { val p = dp(it); v.setPadding(v.paddingLeft, p, v.paddingRight, p) }
      "fontSize" -> if (v is TextView) num?.let { v.setTextSize(TypedValue.COMPLEX_UNIT_SP, it.toFloat()) }
      "fontWeight" -> if (v is TextView && (value == "700" || value == "bold" || value == "600")) v.setTypeface(v.typeface, android.graphics.Typeface.BOLD)
      "radius", "borderRadius" -> {} // needs a GradientDrawable background; TBD
      "direction" -> if (v is FlexboxLayout) v.flexDirection = if (value == "row") FlexDirection.ROW else FlexDirection.COLUMN
      "align" -> if (v is FlexboxLayout) v.alignItems = alignItems(value?.toString())
      "justify" -> if (v is FlexboxLayout) v.justifyContent = justify(value?.toString())
      "flexWrap" -> if (v is FlexboxLayout) v.flexWrap = if (value == "wrap") FlexWrap.WRAP else FlexWrap.NOWRAP
      "width" -> setSize(v, num, null)
      "height" -> setSize(v, null, num)
      // flex/gap/margin applied when the child is attached (needs parent params)
    }
  }

  private fun setSize(v: View, w: Double?, h: Double?) {
    val lp = v.layoutParams ?: ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    if (w != null) lp.width = dp(w)
    if (h != null) lp.height = dp(h)
    v.layoutParams = lp
  }

  private fun connect(id: Long, event: String, cb: Long) {
    val e = entries[id] ?: return
    e.events[event] = cb
    val v = e.view
    when (event) {
      "press" -> v.setOnClickListener { host.pushEvent(id, "press", null) }
      "changeText" -> if (v is EditText) v.addTextChangedListener(object : TextWatcher {
        override fun afterTextChanged(s: Editable?) { host.pushEvent(id, "changeText", JSONObject.quote(s?.toString() ?: "")) }
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
      })
      "valueChange" -> when (v) {
        is CompoundButton -> v.setOnCheckedChangeListener { _, checked -> host.pushEvent(id, "valueChange", checked.toString()) }
        is SeekBar -> v.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
          override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) { host.pushEvent(id, "valueChange", p.toString()) }
          override fun onStartTrackingTouch(sb: SeekBar?) {}
          override fun onStopTrackingTouch(sb: SeekBar?) {}
        })
      }
    }
  }

  private fun addChild(parentId: Long, childId: Long, index: Int) {
    val p = entries[parentId] ?: return
    val c = entries[childId] ?: return
    (c.view.parent as? ViewGroup)?.removeView(c.view)
    val childLp = flexParams(c)
    if (index in 0 until p.content.childCount) p.content.addView(c.view, index, childLp)
    else p.content.addView(c.view, childLp)
  }

  // Build FlexboxLayout params for a child from its flex-ish props.
  private fun flexParams(c: Entry): ViewGroup.LayoutParams {
    val base = FlexboxLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    (c.props["flex"] as? Number)?.let { base.flexGrow = it.toFloat() }
    (c.props["flexGrow"] as? Number)?.let { base.flexGrow = it.toFloat() }
    (c.props["width"] as? Number)?.let { base.width = dp(it.toDouble()) }
    (c.props["height"] as? Number)?.let { base.height = dp(it.toDouble()) }
    (c.props["margin"] as? Number)?.let { val m = dp(it.toDouble()); base.setMargins(m, m, m, m) }
    return base
  }

  private fun removeChild(parentId: Long, childId: Long) {
    val p = entries[parentId] ?: return
    val c = entries[childId] ?: return
    p.content.removeView(c.view)
  }

  private fun setRoot(id: Long) {
    val e = entries[id] ?: return
    root.removeAllViews()
    (e.view.parent as? ViewGroup)?.removeView(e.view)
    root.addView(
      e.view,
      FlexboxLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  private fun parseColor(value: Any?): Int? =
    (value as? String)?.let { try { Color.parseColor(it) } catch (t: Throwable) { null } }

  private fun alignItems(v: String?): Int = when (v) {
    "center" -> AlignItems.CENTER
    "flex-end", "end" -> AlignItems.FLEX_END
    "stretch" -> AlignItems.STRETCH
    else -> AlignItems.FLEX_START
  }

  private fun justify(v: String?): Int = when (v) {
    "center" -> JustifyContent.CENTER
    "flex-end", "end" -> JustifyContent.FLEX_END
    "space-between" -> JustifyContent.SPACE_BETWEEN
    "space-around" -> JustifyContent.SPACE_AROUND
    else -> JustifyContent.FLEX_START
  }
}
