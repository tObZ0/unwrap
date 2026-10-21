#!/usr/bin/env python3
"""
UNWRAP static-analysis worker.

Runs Slither on verified Solidity sources in an isolated process. Deploy it as
a separate service (see Dockerfile); the Next.js app never compiles code itself.

Security model:
  * Bearer-token authentication (SLITHER_WORKER_TOKEN, required).
  * Request body capped (MAX_BODY_BYTES), file count and path safety enforced.
  * Each job runs in a fresh temp dir with a scrubbed environment, CPU / memory /
    process / file-size rlimits, and a wall-clock timeout.
  * The container should run as non-root with no outbound network (see README).
  * Only pre-installed compiler versions are used unless SOLC_AUTO_INSTALL=1.
"""
import hmac
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePosixPath

TOKEN = os.environ.get("SLITHER_WORKER_TOKEN", "")
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(8 * 1024 * 1024)))
MAX_FILES = 400
TIMEOUT_S = int(os.environ.get("SLITHER_TIMEOUT_SECONDS", "120"))
SOLC_DIR = os.environ.get("SOLC_BINARY_DIR", "")  # contains solc-<version> binaries
SOLC_DEFAULT = os.environ.get("SOLC_DEFAULT", "")  # optional fallback binary, used only if its version matches
SLITHER_BIN = os.environ.get("SLITHER_BIN", shutil.which("slither") or "slither")
EXCLUDED = {"naming-convention", "solc-version", "pragma", "too-many-digits", "similar-names", "dead-code", "constable-states", "immutable-states", "external-function", "cache-array-length"}
VERSION_RE = re.compile(r"(\d+\.\d+\.\d+)")


def safe_path(p: str) -> str | None:
    p = p.replace("\\", "/").lstrip("/")
    pp = PurePosixPath(p)
    if not p or any(part in ("..", "") for part in pp.parts) or len(p) > 300:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_@./\- ]+", p):
        return None
    return str(pp)


def solc_for(version: str) -> str | None:
    candidates = []
    if SOLC_DIR:
        candidates.append(os.path.join(SOLC_DIR, f"solc-{version}"))
    home = os.path.expanduser("~")
    candidates.append(os.path.join(home, ".solc-select", "artifacts", f"solc-{version}", f"solc-{version}"))
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    if os.environ.get("SOLC_AUTO_INSTALL") == "1" and shutil.which("solc-select"):
        r = subprocess.run(["solc-select", "install", version], capture_output=True, timeout=120)
        if r.returncode == 0:
            return candidates[-1] if os.path.isfile(candidates[-1]) else None
    if SOLC_DEFAULT and os.path.isfile(SOLC_DEFAULT):
        out = subprocess.run([SOLC_DEFAULT, "--version"], capture_output=True, text=True, timeout=10).stdout
        m = VERSION_RE.search(out.splitlines()[-1] if out else "")
        if m and m.group(1) == version:
            return SOLC_DEFAULT
    return None


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_S, TIMEOUT_S))
    resource.setrlimit(resource.RLIMIT_AS, (3 << 30, 3 << 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 << 20, 256 << 20))
    os.setsid()


def analyse(payload: dict) -> tuple[int, dict]:
    files = payload.get("files")
    name = str(payload.get("contractName") or "")[:120]
    compiler = str(payload.get("compilerVersion") or "")
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        return 400, {"error": "invalid_files"}
    if not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", name or "x"):
        return 400, {"error": "invalid_contract_name"}
    m = VERSION_RE.search(compiler)
    if not m:
        return 422, {"error": "unknown_compiler_version", "detail": "Compiler version missing; Slither needs the exact solc version."}
    version = m.group(1)
    if tuple(int(x) for x in version.split(".")) < (0, 4, 11):
        return 422, {"error": "unsupported_compiler", "detail": f"solc {version} is too old for Slither."}
    solc = solc_for(version)
    if not solc:
        return 422, {"error": "compiler_not_installed", "detail": f"solc {version} is not installed on the worker."}

    work = tempfile.mkdtemp(prefix="unwrap-")
    try:
        main_file = None
        for f in files:
            if not isinstance(f, dict) or not isinstance(f.get("content"), str):
                return 400, {"error": "invalid_file"}
            sp = safe_path(str(f.get("path", "")))
            if not sp:
                return 400, {"error": "unsafe_path"}
            dest = os.path.join(work, sp)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(f["content"])
            if name and re.search(rf"\b(contract|abstract\s+contract)\s+{re.escape(name)}\b", f["content"]):
                main_file = sp
        if not main_file:
            main_file = safe_path(str(files[0].get("path")))
        env = {"PATH": os.path.dirname(solc) + ":/usr/local/bin:/usr/bin:/bin", "HOME": work, "LANG": "C.UTF-8"}
        out_path = os.path.join(work, ".unwrap-slither.json")
        cmd = [SLITHER_BIN, main_file, "--solc", solc, "--json", out_path, "--disable-color"]
        try:
            proc = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=TIMEOUT_S, preexec_fn=limits)
        except subprocess.TimeoutExpired:
            return 504, {"error": "timeout", "detail": f"Slither exceeded {TIMEOUT_S}s."}
        try:
            with open(out_path, encoding="utf-8") as fh:
                out = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return 502, {"error": "slither_failed", "detail": (proc.stderr or "")[-400:]}
        if not out.get("success"):
            return 502, {"error": "slither_failed", "detail": str(out.get("error") or proc.stderr[-400:])[:400]}
        results = []
        for d in (out.get("results") or {}).get("detectors") or []:
            if d.get("check") in EXCLUDED or d.get("impact") == "Optimization":
                continue
            loc = None
            for el in d.get("elements") or []:
                sm = el.get("source_mapping") or {}
                lines = sm.get("lines") or []
                if sm.get("filename_relative") and lines:
                    loc = {"file": sm["filename_relative"], "line": lines[0], "endLine": lines[-1]}
                    break
            results.append({
                "check": d.get("check"),
                "impact": d.get("impact"),
                "confidence": d.get("confidence"),
                "description": str(d.get("description", ""))[:1200],
                "location": loc,
            })
        return 200, {"tool": "slither", "solc": version, "detectors": results[:150]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "unwrap-worker"

    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # no request bodies in logs
        sys.stderr.write("worker %s %s\n" % (self.command, self.path))

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/analyze":
            return self._send(404, {"error": "not_found"})
        auth = self.headers.get("Authorization", "")
        if not TOKEN or not hmac.compare_digest(auth, f"Bearer {TOKEN}"):
            return self._send(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._send(413, {"error": "payload_too_large"})
        try:
            payload = json.loads(self.rfile.read(length))
        except Exception:
            return self._send(400, {"error": "invalid_json"})
        code, body = analyse(payload)
        self._send(code, body)


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("SLITHER_WORKER_TOKEN must be set")
    port = int(os.environ.get("PORT", "8787"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
