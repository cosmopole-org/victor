// End-to-end test of the Decillion tool-commands system, with every participant
// the platform actually uses joining in one pipeline:
//
//   • docker tool creature   — the REAL grok-build tool.py handlers (github,
//                              browser_automation) run with I/O stubbed, so the
//                              genuine response envelopes are produced.
//   • tools wasm creature    — the REAL decillionai-server tools/registerCommands
//     + fake caspar shim        and tools/listCommands creatures, compiled to
//                              wasm and driven through an in-memory Caspar
//                              signaling shim (getJson/putJson).
//   • decillion client bridge — the REAL new-decillion toolCommands.ts: parse the
//                              typed @tool command, look up its registered widget
//                              template, and normalise the tool reply into a view.
//   • Victor Elpian engine    — the REAL tool front-ends (dashboard.js/browser.js)
//                              run on the Elpian VM and render the widget; we
//                              assert what the user actually sees.
//
//   node --experimental-strip-types test/toolCommandsSystem.test.ts
//
// Skips (does not fail) when a required artifact is missing (elpian_rn.wasm, the
// creature wasm, or the sibling repos).
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VictorEngine } from "../src/miniapps/engine.ts";
import { ElpianRuntime } from "../src/vm/runtime.ts";
import type { WidgetNode } from "../src/core/widgetStore.ts";
import { makeCaspar, loadCreature, creaturesBuilt } from "./tools/casparShim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, "../../target/wasm32-unknown-unknown/release/elpian_rn.wasm");
const localWasm = path.resolve(here, "../web/elpian_rn.wasm");
const enginePath = fs.existsSync(wasmPath) ? wasmPath : localWasm;

const grokTools = path.resolve(here, "../../../../grok-build/caspar/tools");
const appBridgePath = path.resolve(here, "../../../../new-decillion/src/features/projects/toolCommands.ts");

function skip(msg: string): never {
  console.log(`  skip  ${msg}`);
  process.exit(0);
}

if (!fs.existsSync(enginePath)) skip(`elpian_rn.wasm not built (${enginePath})`);
if (!creaturesBuilt()) skip("tools creature wasm not built (run test/tools/build-creatures.sh)");
if (!fs.existsSync(grokTools)) skip(`grok-build tools not found (${grokTools})`);
if (!fs.existsSync(appBridgePath)) skip(`new-decillion bridge not found (${appBridgePath})`);

// The real client bridge (type-only imports are erased under strip-types).
const bridge = await import(appBridgePath);
const {
  toolCandidatesByHandle,
  parseToolCommandsInMessage,
  widgetFromToolResult,
  helpWidgetFromCommands,
  withHelpCommand,
} = bridge as typeof import("../../../../new-decillion/src/features/projects/toolCommands.ts");

// ── helpers over the Elpian widget tree ──────────────────────────────────────
function walk(rt: ElpianRuntime, visit: (n: WidgetNode) => void): void {
  const store = rt.dispatcher.store;
  const go = (id: number | undefined) => {
    if (!id) return;
    const n: WidgetNode | null = store.get(id);
    if (!n) return;
    visit(n);
    for (const c of n.children) go(c);
  };
  go(store.root()?.id);
}

function textsOf(rt: ElpianRuntime): string[] {
  const out: string[] = [];
  walk(rt, (n) => {
    if (n.className === "RNText" && typeof n.props.text === "string") out.push(n.props.text);
  });
  return out;
}

function imageSrcs(rt: ElpianRuntime): string[] {
  const out: string[] = [];
  walk(rt, (n) => {
    if (n.className === "RNImage") {
      const src = n.props.src ?? n.props.source ?? n.props.uri;
      if (typeof src === "string") out.push(src);
    }
  });
  return out;
}

// Read a tool's registered command set from its metadata, exactly as grok-build's
// register_tool_commands reduces point.metadata.json (name/description/args/widget)
// before registering it on-chain.
function commandsFromMetadata(tool: string): any[] {
  const meta = JSON.parse(fs.readFileSync(path.join(grokTools, tool, "point.metadata.json"), "utf8"));
  const out: any[] = [];
  for (const t of meta.tools ?? []) {
    if (!t || !t.name) continue;
    const cmd: any = { name: String(t.name) };
    const desc = t.desc || t.description;
    if (desc) cmd.description = String(desc);
    if (t.args && typeof t.args === "object") cmd.args = t.args;
    if (t.widget && typeof t.widget === "object") cmd.widget = t.widget;
    out.push(cmd);
  }
  return out;
}

// Run a REAL docker tool creature handler (stubbed I/O) → its response envelope.
function toolReply(tool: string, action: string, payload: object): any {
  const out = execFileSync(
    "python3",
    [path.join(here, "tools", "tool_creature.py"), tool, action, JSON.stringify(payload)],
    { env: { ...process.env, GROK_TOOLS_DIR: grokTools }, encoding: "utf8" },
  );
  return JSON.parse(out);
}

// Render a client-built widget's `_view` through the tool's REAL front-end on the
// Elpian engine, and return the runtime for widget-tree assertions.
function renderWidget(engine: VictorEngine, tool: string, frontend: string, widget: any): ElpianRuntime {
  const source = fs.readFileSync(path.join(grokTools, tool, "frontend", frontend), "utf8");
  const ctx = {
    mode: "widget",
    command: widget.command,
    data: widget.data,
    theme: { bg: "#0b1220", surface: "#111a2e", surfaceAlt: "#16223b", line: "#22304d", text: "#e6edf7", muted: "#8ea3c4", accent: "#4ade80", onAccent: "#052e16", danger: "#f87171", link: "#7cc4ff" },
  };
  const rt = engine.createRuntime({ onLog: () => {} });
  rt.start(`var __CTX = ${JSON.stringify(ctx)};\n${source}`, { lang: "js" });
  return rt;
}

// ── set the stage ────────────────────────────────────────────────────────────
const engine = await VictorEngine.load(fs.readFileSync(enginePath));
const { host } = makeCaspar();
const register = await loadCreature("registerCommands", host);
const list = await loadCreature("listCommands", host);

// Deploy-time: each tool registers its commands into the registry creature.
const GH = "prog-github";
const BR = "prog-browser";
register("registerCommands", { programId: GH, toolId: "github", name: "GitHub", commands: commandsFromMetadata("github") });
register("registerCommands", { programId: BR, toolId: "browser_automation", name: "Browser", commands: commandsFromMetadata("browser_automation") });

// Space-open time: the client lists each tool's commands from the registry.
const ghCommands = list("listCommands", { programId: GH }).commands;
const brCommands = list("listCommands", { programId: BR }).commands;

const candidates = [
  { kind: "tool", handle: "github", label: "GitHub", programId: GH, toolId: "github" },
  { kind: "tool", handle: "browser", label: "Browser", programId: BR, toolId: "browser_automation" },
];
const tools = toolCandidatesByHandle(candidates as any);
const byProgram = new Map<string, any[]>([[GH, ghCommands], [BR, brCommands]]);

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── the registry (tools wasm creature) synthesised help for every tool ───────
test("tools creature registered commands + synthesised a help command", () => {
  assert.ok(ghCommands.find((c: any) => c.name === "orgs"), "github orgs registered");
  assert.ok(ghCommands.find((c: any) => c.name === "help"), "github help synthesised");
  assert.ok(brCommands.find((c: any) => c.name === "screenshot"), "browser screenshot registered");
  assert.ok(brCommands.find((c: any) => c.name === "help"), "browser help synthesised");
  // The org command kept the widget template the tool declared.
  const orgs = ghCommands.find((c: any) => c.name === "orgs");
  assert.ok(orgs.widget && orgs.widget.list === "orgs", `orgs template preserved: ${JSON.stringify(orgs.widget)}`);
});

// ── github orgs: renders org names, never "item" (the reported bug) ──────────
test("@github orgs renders real org names, not 'item'", () => {
  const [parsed] = parseToolCommandsInMessage("@github orgs", tools, byProgram);
  assert.ok(parsed && parsed.command.name === "orgs", "parsed the orgs command");
  const reply = toolReply("github", "orgs", { space_id: "s1" });
  assert.strictEqual(reply.orgs[0].login, "cosmopole-org");
  const widget = widgetFromToolResult(reply, {
    toolId: GH, toolName: "GitHub", command: "orgs", template: parsed.command.widget,
  });
  const rt = renderWidget(engine, "github", "dashboard.js", widget);
  const texts = textsOf(rt);
  assert.ok(texts.includes("cosmopole-org"), `orgs listed: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("decillionai"), `orgs listed: ${JSON.stringify(texts)}`);
  assert.ok(!texts.includes("item"), `no 'item' placeholder: ${JSON.stringify(texts)}`);
  rt.stop();
});

// ── browser screenshot: renders the image, not the "no preview" box ──────────
test("@browser screenshot renders the captured image", () => {
  const reply = toolReply("browser_automation", "screenshot", { space_id: "s1", format: "png" });
  const br = brCommands.find((c: any) => c.name === "screenshot");
  const widget = widgetFromToolResult(reply, {
    toolId: BR, toolName: "Browser", command: "screenshot", template: br.widget,
  });
  const rt = renderWidget(engine, "browser_automation", "browser.js", widget);
  const imgs = imageSrcs(rt);
  assert.ok(imgs.some((s) => s.startsWith("data:image/png;base64,")), `image rendered: ${JSON.stringify(imgs)}`);
  const texts = textsOf(rt);
  assert.ok(!texts.includes("The tool returned no preview."), `no empty note: ${JSON.stringify(texts)}`);
  rt.stop();
});

// ── browser pdf: a produced document reads as a real (non-empty) widget ──────
test("@browser pdf reports a real result, not an empty box", () => {
  const reply = toolReply("browser_automation", "pdf", { space_id: "s1" });
  const br = brCommands.find((c: any) => c.name === "pdf");
  const widget = widgetFromToolResult(reply, {
    toolId: BR, toolName: "Browser", command: "pdf", template: br.widget,
  });
  const rt = renderWidget(engine, "browser_automation", "browser.js", widget);
  const texts = textsOf(rt).join(" | ");
  assert.ok(/PDF ready/.test(texts), `pdf note present: ${texts}`);
  assert.ok(!/no preview/.test(texts), `not the empty card: ${texts}`);
  rt.stop();
});

// ── help: lists the tool's commands and their parameters, rendered as a widget ─
test("@github help lists commands and parameters (rendered)", () => {
  const [parsed] = parseToolCommandsInMessage("@github help", tools, byProgram);
  assert.ok(parsed && parsed.command.name === "help", "help is parseable");
  const widget = helpWidgetFromCommands({ toolId: GH, toolName: "GitHub" }, withHelpCommand(ghCommands));
  const rt = renderWidget(engine, "github", "dashboard.js", widget);
  const texts = textsOf(rt);
  assert.ok(texts.includes("orgs"), `help lists orgs: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("repos"), `help lists repos: ${JSON.stringify(texts)}`);
  // repos declares an `org` parameter; help should surface its name.
  assert.ok(texts.some((t) => /org/.test(t)), "help surfaces a parameter name");
  rt.stop();
});

console.log(`\n${passed} tool-commands system tests passed.`);
