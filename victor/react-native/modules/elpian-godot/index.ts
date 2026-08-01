// Local Expo module that installs the embedded-Godot JSI binding
// (global.__ElpianGodot) and registers the ElpianGodotView. installGodot()
// nudges the native side to install the binding and returns a status string.
import { requireNativeModule } from "expo";

interface ElpianGodotNativeModule {
  install(): string;
}

let nativeModule: ElpianGodotNativeModule | null = null;
let requireError: string | null = null;
try {
  nativeModule = requireNativeModule("ElpianGodot") as ElpianGodotNativeModule;
} catch (e) {
  requireError = String(e);
  nativeModule = null;
}

/** Install global.__ElpianGodot if absent; returns a diagnostic status. */
export function installGodot(): string {
  const g = globalThis as { __ElpianGodot?: unknown };
  if (g.__ElpianGodot) return "ok";
  if (!nativeModule) return `module-not-found: ${requireError ?? "unavailable"}`;
  try {
    return nativeModule.install();
  } catch (e) {
    return `install-threw: ${String(e)}`;
  }
}

export default nativeModule;
