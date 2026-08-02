import UIKit

// Maps the VM's rn.op stream to a real UIView tree — no React. One controller per
// VictorSurfaceView (so widget ids are per-surface, matching Android). Flex
// containers use UIStackView (UIKit's native flex analogue of Android's
// FlexboxLayout); the 15 widget KINDs each map to a native UIView. Events set
// native targets that enqueue back to the VM via the host. iOS twin of
// WidgetController.kt — same op vocabulary, same kind→widget mapping.
final class WidgetController {
  private final class Entry {
    let view: UIView
    let content: UIView   // where children attach (== view unless a scroller)
    let kind: String
    var props: [String: Any] = [:]
    var events: [String: Int] = [:]
    init(view: UIView, content: UIView, kind: String) {
      self.view = view; self.content = content; self.kind = kind
    }
  }

  private let root: UIStackView
  private weak var host: VictorSurfaceView?
  private var entries: [Int: Entry] = [:]
  // UIControl/gesture targets keyed by widget id so `press`/value events carry it.
  private var actionProxies: [Int: WidgetActionProxy] = [:]

  init(root: UIStackView, host: VictorSurfaceView) {
    self.root = root
    self.host = host
  }

  // Apply one op message (see NativeWidgetRenderer.send).
  func apply(_ op: [String: Any]) {
    switch op["t"] as? String {
    case "create": create(int(op["id"]), op["cls"] as? String ?? "", op["k"] as? String ?? "view")
    case "set": setProp(int(op["id"]), op["k"] as? String ?? "", op["v"])
    case "connect": connect(int(op["id"]), op["e"] as? String ?? "", int(op["cb"]))
    case "disconnect": entries[int(op["id"])]?.events.removeValue(forKey: op["e"] as? String ?? "")
    case "add": addChild(int(op["p"]), int(op["c"]), op["i"] as? Int ?? -1)
    case "remove": removeChild(int(op["p"]), int(op["c"]))
    case "clear": clearChildren(int(op["p"]))
    case "free": entries.removeValue(forKey: int(op["id"])); actionProxies.removeValue(forKey: int(op["id"]))
    case "root": setRoot(int(op["id"]))
    case "toast": toast(op["m"] as? String ?? "")
    default: break
    }
  }

  private func create(_ id: Int, _ cls: String, _ kind: String) {
    let (view, content) = build(kind)
    entries[id] = Entry(view: view, content: content, kind: kind)
  }

  private func build(_ kind: String) -> (UIView, UIView) {
    switch kind {
    case "text":
      let l = UILabel(); l.numberOfLines = 0; return (l, l)
    case "input":
      let t = UITextField(); t.borderStyle = .roundedRect; return (t, t)
    case "switch": return single(UISwitch())
    case "slider": return single(UISlider())
    case "button", "victorButton":
      let b = UIButton(type: .system); return (b, b)
    case "activity":
      let a = UIActivityIndicatorView(style: .medium); a.startAnimating(); return (a, a)
    case "image":
      let i = UIImageView(); i.contentMode = .scaleAspectFit; return (i, i)
    case "scene3d":
      return single(UIView()) // Godot view is attached by the Godot module
    case "scroll":
      let sv = UIScrollView()
      let inner = column()
      sv.addSubview(inner)
      inner.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        inner.leadingAnchor.constraint(equalTo: sv.contentLayoutGuide.leadingAnchor),
        inner.trailingAnchor.constraint(equalTo: sv.contentLayoutGuide.trailingAnchor),
        inner.topAnchor.constraint(equalTo: sv.contentLayoutGuide.topAnchor),
        inner.bottomAnchor.constraint(equalTo: sv.contentLayoutGuide.bottomAnchor),
        inner.widthAnchor.constraint(equalTo: sv.frameLayoutGuide.widthAnchor),
      ])
      return (sv, inner)
    default: // view, list, imageBackground, status, refresh
      let f = column(); return (f, f)
    }
  }

  private func single(_ v: UIView) -> (UIView, UIView) { (v, v) }
  private func column() -> UIStackView {
    let s = UIStackView(); s.axis = .vertical; s.alignment = .fill; s.distribution = .fill
    return s
  }

  private func setProp(_ id: Int, _ key: String, _ value: Any?) {
    guard let e = entries[id] else { return }
    e.props[key] = value
    let v = e.view
    switch key {
    case "text", "title":
      if let l = v as? UILabel { l.text = str(value) }
      else if let b = v as? UIButton { b.setTitle(str(value), for: .normal) }
    case "value":
      if let t = v as? UITextField { if t.text != str(value) { t.text = str(value) } }
      else if let s = v as? UISwitch { s.isOn = (value as? Bool) ?? false }
      else if let s = v as? UISlider { s.value = num(value).map(Float.init) ?? 0 }
    case "placeholder": if let t = v as? UITextField { t.placeholder = str(value) }
    case "secure": if let t = v as? UITextField, (value as? Bool) == true { t.isSecureTextEntry = true }
    case "min": if let s = v as? UISlider, let n = num(value) { s.minimumValue = Float(n) }
    case "max": if let s = v as? UISlider, let n = num(value) { s.maximumValue = Float(n) }
    case "src", "source": break // image loading TBD (URL/asset)
    default: applyStyle(e, key, value)
    }
  }

  // Layout + visual style. Numbers are points; flex props go on the stack view.
  private func applyStyle(_ e: Entry, _ key: String, _ value: Any?) {
    let v = e.view
    switch key {
    case "bg", "backgroundColor": color(value).map { v.backgroundColor = $0 }
    case "color": if let l = v as? UILabel { color(value).map { l.textColor = $0 } }
    case "padding": if let s = v as? UIStackView, let n = num(value) {
      s.isLayoutMarginsRelativeArrangement = true
      s.layoutMargins = UIEdgeInsets(top: CGFloat(n), left: CGFloat(n), bottom: CGFloat(n), right: CGFloat(n))
    }
    case "fontSize": if let l = v as? UILabel, let n = num(value) { l.font = l.font.withSize(CGFloat(n)) }
    case "fontWeight":
      if let l = v as? UILabel, value as? String == "700" || value as? String == "bold" || value as? String == "600" {
        l.font = UIFont.boldSystemFont(ofSize: l.font.pointSize)
      }
    case "radius", "borderRadius": if let n = num(value) { v.layer.cornerRadius = CGFloat(n); v.clipsToBounds = true }
    case "direction": if let s = v as? UIStackView { s.axis = (value as? String == "row") ? .horizontal : .vertical }
    case "align": if let s = v as? UIStackView { s.alignment = alignment(value as? String) }
    case "justify": if let s = v as? UIStackView { s.distribution = distribution(value as? String) }
    case "width": if let n = num(value) { fix(v, .width, CGFloat(n)) }
    case "height": if let n = num(value) { fix(v, .height, CGFloat(n)) }
    default: break
    }
  }

  private func fix(_ v: UIView, _ attr: NSLayoutConstraint.Attribute, _ c: CGFloat) {
    v.translatesAutoresizingMaskIntoConstraints = false
    let anchor = attr == .width ? v.widthAnchor : v.heightAnchor
    anchor.constraint(equalToConstant: c).isActive = true
  }

  private func connect(_ id: Int, _ event: String, _ cb: Int) {
    guard let e = entries[id] else { return }
    e.events[event] = cb
    let proxy = actionProxies[id] ?? WidgetActionProxy(id: id, controller: self)
    actionProxies[id] = proxy
    let v = e.view
    switch event {
    case "press":
      if let b = v as? UIButton {
        b.addTarget(proxy, action: #selector(WidgetActionProxy.onPress), for: .touchUpInside)
      } else {
        let tap = UITapGestureRecognizer(target: proxy, action: #selector(WidgetActionProxy.onPress))
        v.isUserInteractionEnabled = true
        v.addGestureRecognizer(tap)
      }
    case "changeText":
      if let t = v as? UITextField {
        t.addTarget(proxy, action: #selector(WidgetActionProxy.onChangeText(_:)), for: .editingChanged)
      }
    case "valueChange":
      if let c = v as? UIControl {
        c.addTarget(proxy, action: #selector(WidgetActionProxy.onValueChange(_:)), for: .valueChanged)
      }
    default: break
    }
  }

  // Called by the action proxies; forward to the surface's app-scoped event queue.
  func fire(_ id: Int, _ event: String, _ argJson: String?) {
    host?.pushEvent(id, event, argJson)
  }

  private func addChild(_ parentId: Int, _ childId: Int, _ index: Int) {
    guard let p = entries[parentId], let c = entries[childId] else { return }
    c.view.removeFromSuperview()
    if let stack = p.content as? UIStackView {
      if index >= 0 && index < stack.arrangedSubviews.count {
        stack.insertArrangedSubview(c.view, at: index)
      } else {
        stack.addArrangedSubview(c.view)
      }
    } else {
      p.content.addSubview(c.view)
    }
  }

  private func removeChild(_ parentId: Int, _ childId: Int) {
    guard let c = entries[childId] else { return }
    c.view.removeFromSuperview()
  }

  private func clearChildren(_ parentId: Int) {
    guard let p = entries[parentId] else { return }
    if let stack = p.content as? UIStackView {
      stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    } else {
      p.content.subviews.forEach { $0.removeFromSuperview() }
    }
  }

  private func setRoot(_ id: Int) {
    guard let e = entries[id] else { return }
    root.arrangedSubviews.forEach { $0.removeFromSuperview() }
    e.view.removeFromSuperview()
    root.addArrangedSubview(e.view)
  }

  private func toast(_ message: String) {
    host?.showToast(message)
  }

  // --- coercion helpers -------------------------------------------------------
  private func int(_ v: Any?) -> Int { (v as? Int) ?? Int((v as? Double) ?? 0) }
  private func num(_ v: Any?) -> Double? { (v as? Double) ?? (v as? Int).map(Double.init) }
  private func str(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let v = v { return "\(v)" }
    return ""
  }
  private func color(_ v: Any?) -> UIColor? {
    guard let hex = v as? String else { return nil }
    return WidgetController.parseHexColor(hex)
  }

  private func alignment(_ v: String?) -> UIStackView.Alignment {
    switch v {
    case "center": return .center
    case "flex-end", "end": return .trailing
    case "stretch": return .fill
    default: return .leading
    }
  }
  private func distribution(_ v: String?) -> UIStackView.Distribution {
    switch v {
    case "space-between": return .equalSpacing
    case "space-around": return .equalCentering
    default: return .fill
    }
  }

  static func parseHexColor(_ hex: String) -> UIColor? {
    var s = hex.trimmingCharacters(in: .whitespaces)
    guard s.hasPrefix("#") else { return nil }
    s.removeFirst()
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard let v = UInt64(s, radix: 16) else { return nil }
    let hasAlpha = s.count == 8
    let r = CGFloat((v >> (hasAlpha ? 24 : 16)) & 0xff) / 255
    let g = CGFloat((v >> (hasAlpha ? 16 : 8)) & 0xff) / 255
    let b = CGFloat((v >> (hasAlpha ? 8 : 0)) & 0xff) / 255
    let a = hasAlpha ? CGFloat(v & 0xff) / 255 : 1
    return UIColor(red: r, green: g, blue: b, alpha: a)
  }
}

// Bridges UIControl/gesture callbacks (which need an ObjC target) to the
// controller, tagging each with its widget id and the event's arg.
final class WidgetActionProxy: NSObject {
  private let id: Int
  private weak var controller: WidgetController?
  init(id: Int, controller: WidgetController) { self.id = id; self.controller = controller }

  @objc func onPress() { controller?.fire(id, "press", nil) }
  @objc func onChangeText(_ field: UITextField) {
    controller?.fire(id, "changeText", jsonString(field.text ?? ""))
  }
  @objc func onValueChange(_ control: UIControl) {
    if let s = control as? UISwitch { controller?.fire(id, "valueChange", s.isOn ? "true" : "false") }
    else if let s = control as? UISlider { controller?.fire(id, "valueChange", "\(s.value)") }
  }

  private func jsonString(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s])
    guard let data = data, let arr = String(data: data, encoding: .utf8) else { return "\"\"" }
    // arr is ["..."]; strip the array brackets to get the quoted string.
    return String(arr.dropFirst().dropLast())
  }
}
