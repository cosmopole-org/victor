import ExpoModulesCore
import UIKit

// The React Native view that hosts the embedded Godot viewport on iOS. RN
// sizes/places it where a <Scene3D/> renders. It drains the 3D op queue each
// frame (ElpianGodotBridge.pollOps) exactly as the Android GodotFragment's OpSink
// does — so the RN→Godot pipeline is wired identically — and hands the ops to the
// Godot iOS runtime once linked.
//
// GRACEFUL DEGRADATION (matches Android): hosting Godot's Metal rendering layer
// needs libgodot.ios + the elpian_godot GDExtension built for iOS — a binary
// build artifact (see ios/README.md). Until it is linked, this view shows a
// labeled placeholder and simply drops drained ops, so a partial install renders
// a blank 3D box instead of crashing — the same behavior as a build without the
// Godot library on Android. The 2D app is fully live regardless.
final class ElpianGodotView: ExpoView {
  private let placeholder = UILabel()
  private var displayLink: CADisplayLink?

  // Set once a Godot iOS runtime is linked; receives each drained op batch.
  static var opSink: ((String) -> Void)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = UIColor(red: 0.043, green: 0.071, blue: 0.125, alpha: 1) // #0b1220
    layer.cornerRadius = 8
    clipsToBounds = true
    placeholder.text = "3D Scene (Godot iOS runtime not linked)"
    placeholder.textColor = UIColor(white: 0.4, alpha: 1)
    placeholder.font = .systemFont(ofSize: 12)
    placeholder.textAlignment = .center
    placeholder.numberOfLines = 0
    placeholder.translatesAutoresizingMaskIntoConstraints = false
    addSubview(placeholder)
    NSLayoutConstraint.activate([
      placeholder.centerXAnchor.constraint(equalTo: centerXAnchor),
      placeholder.centerYAnchor.constraint(equalTo: centerYAnchor),
      placeholder.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 8),
    ])
    placeholder.isHidden = ElpianGodotView.opSink != nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { start() } else { stop() }
  }

  private func start() {
    guard displayLink == nil else { return }
    let link = CADisplayLink(target: self, selector: #selector(drain))
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  private func stop() {
    displayLink?.invalidate()
    displayLink = nil
  }

  @objc private func drain() {
    let json = ElpianGodotBridge.pollOps()
    guard !json.isEmpty else { return }
    // With a linked runtime, feed the OpSink; otherwise the ops are dropped (the
    // JS engine already echoed the guest's handles synchronously).
    ElpianGodotView.opSink?(json)
  }

  deinit { stop() }
}
