// Local Expo module that installs the native widget JSI binding
// (global.__ElpianWidgets) and registers VictorSurfaceView. installWidgets()
// installs the binding and returns a diagnostic status string.
import { requireNativeModule } from "expo";

interface ElpianWidgetsNativeModule {
  install(): string;
}

let nativeModule: ElpianWidgetsNativeModule | null = null;
let requireError: string | null = null;
try {
  nativeModule = requireNativeModule("ElpianWidgets") as ElpianWidgetsNativeModule;
} catch (e) {
  requireError = String(e);
  nativeModule = null;
}

export function installWidgets(): string {
  const g = globalThis as { __ElpianWidgets?: unknown };
  if (g.__ElpianWidgets) return "ok";
  if (!nativeModule) return `module-not-found: ${requireError ?? "unavailable"}`;
  try {
    return nativeModule.install();
  } catch (e) {
    return `install-threw: ${String(e)}`;
  }
}

export default nativeModule;
