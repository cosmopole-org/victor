import ExpoModulesCore
import UIKit

// The React Native view that hosts the VM-driven native UIView tree. RN mounts
// ONE per mini app (no React below it); each frame it drains the widget ops the
// VM queued for its appId (ElpianWidgetsBridge.drainOps) and applies them to a
// real UIView tree via WidgetController. Widget events are pushed back
// (ElpianWidgetsBridge.pushEvent) for the JS side to poll into the VM. iOS twin
// of VictorSurfaceView.kt.
final class VictorSurfaceView: ExpoView {
  // The mini-app scope this surface hosts (matches NativeWidgetRenderer's appId).
  var appId: String = "main"

  private let root: UIStackView = {
    let s = UIStackView(); s.axis = .vertical; s.alignment = .fill; s.distribution = .fill
    return s
  }()
  private var controller: WidgetController!
  private var displayLink: CADisplayLink?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    controller = WidgetController(root: root, host: self)
    addSubview(root)
    root.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: leadingAnchor),
      root.trailingAnchor.constraint(equalTo: trailingAnchor),
      root.topAnchor.constraint(equalTo: topAnchor),
      root.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { startLoop() } else { stopLoop() }
  }

  private func startLoop() {
    guard displayLink == nil else { return }
    let link = CADisplayLink(target: self, selector: #selector(drainOps))
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  private func stopLoop() {
    displayLink?.invalidate()
    displayLink = nil
  }

  @objc private func drainOps() {
    let json = ElpianWidgetsBridge.drainOps(appId)
    guard !json.isEmpty, let data = json.data(using: .utf8) else { return }
    guard let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
    for op in arr { controller.apply(op) }
  }

  /// Called by WidgetController on a widget event; queued for this app's JS poll.
  func pushEvent(_ id: Int, _ event: String, _ argJson: String?) {
    ElpianWidgetsBridge.pushEvent(appId, id: id, event: event, arg: argJson)
  }

  /// A guest `toast` op → a lightweight bottom banner (UIKit has no native toast).
  func showToast(_ message: String) {
    guard let host = window?.rootViewController?.view else { return }
    let label = PaddedLabel()
    label.text = message
    label.textColor = .white
    label.backgroundColor = UIColor(white: 0, alpha: 0.8)
    label.layer.cornerRadius = 8
    label.clipsToBounds = true
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    host.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: host.centerXAnchor),
      label.bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -48),
    ])
    UIView.animate(withDuration: 0.25, delay: 1.8, options: [], animations: { label.alpha = 0 },
                   completion: { _ in label.removeFromSuperview() })
  }

  deinit { stopLoop() }
}

// A UILabel with inner padding for the toast banner.
private final class PaddedLabel: UILabel {
  private let inset = UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
  override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: inset)) }
  override var intrinsicContentSize: CGSize {
    let s = super.intrinsicContentSize
    return CGSize(width: s.width + inset.left + inset.right, height: s.height + inset.top + inset.bottom)
  }
}
