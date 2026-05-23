"""Minimal LSP JSON-RPC client to drive pyright-langserver --stdio.

Used by 04_run_pyright.py. Provides:
  - LspClient.initialize(root_uri)
  - LspClient.references(file_uri, line, character) -> int (count)
  - LspClient.implementations(file_uri, line, character) -> int (count)
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
from queue import Queue, Empty


class LspClient:
    def __init__(self, command: list[str], root: str):
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self.root = root
        self._id = 0
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._responses: dict[int, dict] = {}
        self._cv = threading.Condition()
        self._reader.start()
        self._opened_uris: set[str] = set()

    def _read_loop(self):
        f = self.proc.stdout
        assert f is not None
        while True:
            line = f.readline()
            if not line:
                return
            if not line.startswith(b"Content-Length:"):
                continue
            length = int(line.split(b":")[1].strip())
            # consume empty line
            f.readline()
            body = f.read(length)
            try:
                msg = json.loads(body)
            except Exception:
                continue
            mid = msg.get("id")
            if mid is None:
                continue  # notifications
            with self._cv:
                self._responses[mid] = msg
                self._cv.notify_all()

    def _send(self, method: str, params: dict, expect_response: bool = True):
        with self._lock:
            self._id += 1
            mid = self._id
        msg = {"jsonrpc": "2.0", "id": mid, "method": method, "params": params}
        body = json.dumps(msg).encode()
        header = f"Content-Length: {len(body)}\r\n\r\n".encode()
        assert self.proc.stdin is not None
        self.proc.stdin.write(header + body)
        self.proc.stdin.flush()
        if not expect_response:
            return None
        with self._cv:
            while mid not in self._responses:
                self._cv.wait(timeout=30)
                if mid not in self._responses:
                    return None
            return self._responses.pop(mid)

    def _notify(self, method: str, params: dict):
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        body = json.dumps(msg).encode()
        header = f"Content-Length: {len(body)}\r\n\r\n".encode()
        assert self.proc.stdin is not None
        self.proc.stdin.write(header + body)
        self.proc.stdin.flush()

    def initialize(self):
        root_uri = "file://" + self.root
        resp = self._send(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": root_uri,
                "rootPath": self.root,
                "capabilities": {
                    "textDocument": {
                        "references": {"dynamicRegistration": False},
                        "implementation": {"dynamicRegistration": False},
                        "synchronization": {"dynamicRegistration": False},
                    },
                    "workspace": {"workspaceFolders": True},
                },
                "workspaceFolders": [{"uri": root_uri, "name": "captain"}],
                "initializationOptions": {},
            },
        )
        self._notify("initialized", {})
        return resp

    def open_file(self, file_uri: str, text: str):
        if file_uri in self._opened_uris:
            return
        self._notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": file_uri,
                    "languageId": "python",
                    "version": 1,
                    "text": text,
                }
            },
        )
        self._opened_uris.add(file_uri)

    def references(self, file_uri: str, line: int, character: int) -> int | None:
        resp = self._send(
            "textDocument/references",
            {
                "textDocument": {"uri": file_uri},
                "position": {"line": line, "character": character},
                "context": {"includeDeclaration": False},
            },
        )
        if resp is None:
            return None
        result = resp.get("result")
        if result is None:
            return None
        return len(result)

    def implementations(self, file_uri: str, line: int, character: int) -> int | None:
        resp = self._send(
            "textDocument/implementation",
            {
                "textDocument": {"uri": file_uri},
                "position": {"line": line, "character": character},
            },
        )
        if resp is None:
            return None
        result = resp.get("result")
        if result is None:
            return 0
        # result can be Location | Location[]
        if isinstance(result, list):
            return len(result)
        return 1

    def shutdown(self):
        try:
            self._send("shutdown", {})
            self._notify("exit", {})
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass
