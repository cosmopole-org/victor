#!/usr/bin/env python3
"""Run a REAL docker tool creature handler (grok-build caspar/tools/<tool>/tool.py)
with its external I/O stubbed, and print the response envelope as JSON.

This lets the integration test exercise the tools' real response-shaping code
(the code that had the "orgs use `login`" and "screenshot returns base64 image"
shapes) without a network or a live Chromium. Usage:

    python3 tool_creature.py <tool> <action> '<payload-json>'
"""
import base64
import importlib.util
import json
import os
import sys
import types

TOOLS_DIR_ENV = "GROK_TOOLS_DIR"


def _load(tool: str):
    tools_dir = os.environ.get(TOOLS_DIR_ENV) or os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "..", "grok-build", "caspar", "tools"
    )
    tool_dir = os.path.abspath(os.path.join(tools_dir, tool))
    path = os.path.join(tool_dir, "tool.py")
    if not os.path.exists(path):
        print(json.dumps({"ok": False, "error": f"tool.py not found for {tool}"}))
        sys.exit(2)
    sys.path.insert(0, tool_dir)
    spec = importlib.util.spec_from_file_location(f"{tool}_tool", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _github_stubs(mod):
    # Real _a_orgs shaping, canned GitHub API responses (no network).
    mod._require_use = lambda space_id, payload: ("faketoken", {})
    def fake_paginate(token, path, params=None, **kw):
        if path == "/user/orgs":
            return [
                {"login": "cosmopole-org", "description": "Cosmopole", "avatar_url": "https://a/1"},
                {"login": "decillionai", "description": "Decillion", "avatar_url": "https://a/2"},
                {"login": "keyhmoham", "description": None, "avatar_url": "https://a/3"},
            ]
        if path.endswith("/repos") or path == "/user/repos":
            return [
                {"full_name": "cosmopole-org/grok-build", "name": "grok-build",
                 "owner": {"login": "cosmopole-org"}, "description": "agent harness",
                 "default_branch": "main", "language": "Rust", "stargazers_count": 3,
                 "open_issues_count": 1, "clone_url": "https://github.com/cosmopole-org/grok-build.git"},
            ]
        return []
    mod._paginate = fake_paginate
    mod._api = lambda method, path, token, **kw: {"login": "shayan", "name": "Shayan", "avatar_url": "https://a/me"}


def _browser_stubs(mod):
    # Real _do_screenshot/_do_pdf shaping over a fake Playwright worker/page.
    class FakePage:
        url = "https://www.google.com/"
        def title(self):
            return "Google"
        def screenshot(self, **kw):
            # 1x1 PNG-ish bytes; the shaping code base64-encodes whatever it gets.
            return b"\x89PNG\r\n\x1a\n" + b"FAKE-SHOT" * 4
        def pdf(self, **kw):
            return b"%PDF-1.4 fake pdf bytes"

    class FakeSession:
        def __init__(self):
            self.page = FakePage()
            self.key = "default::main"

    class FakeWorker:
        _sessions = {"default::main": FakeSession()}
        def _session(self, key, create=True):
            return self._sessions["default::main"]
        def call(self, fn, timeout=None):
            return fn(self)
        def _reap_idle(self):
            pass
        def _drop(self, key):
            self._sessions.pop(key, None)

    fake = FakeWorker()
    mod._worker = lambda: fake


def main():
    tool, action = sys.argv[1], sys.argv[2]
    payload = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    mod = _load(tool)
    if tool == "github":
        _github_stubs(mod)
    elif tool == "browser_automation":
        _browser_stubs(mod)
    result = mod.invoke(action, payload)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
