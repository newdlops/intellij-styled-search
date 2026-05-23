from __future__ import annotations

import concurrent.futures
import json
import math
import os
import random
import statistics
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from queue import Empty, Queue


WORKSPACE = Path(os.environ.get("CAPTAIN_WORKSPACE", "/Users/lky/project/captain"))
REPO = Path(os.environ.get("IJSS_REPO", "/Users/lky/project/intellij-styled-search"))
ZRS = Path(os.environ.get("ZOEK_RS", str(REPO / "target/release/zoek-rs")))
PYRIGHT = Path(os.environ.get("PYRIGHT", str(WORKSPACE / ".venv/bin/pyright-langserver")))
PYTHON = Path(os.environ.get("CAPTAIN_PYTHON", str(WORKSPACE / ".venv/bin/python")))
FULL_CENSUS = os.environ.get("FULL_CENSUS", "0") == "1"
CENSUS_INCLUDE_ZERO_USAGE = os.environ.get("CENSUS_INCLUDE_ZERO_USAGE", "0") == "1"
CENSUS_MIN_USAGE = int(os.environ.get("CENSUS_MIN_USAGE", "1"))
CENSUS_ORDER = os.environ.get("CENSUS_ORDER", "round_robin")
TARGET_SCALE = int(os.environ.get("TARGET_SCALE", "10"))
BASE_TARGETS = {
    "function": 200,
    "method": 400,
    "class": 200,
    "field": 200,
}
TARGETS = {} if FULL_CENSUS else {kind: target * TARGET_SCALE for kind, target in BASE_TARGETS.items()}
SAMPLE_SIZE = "census" if FULL_CENSUS else str(sum(TARGETS.values()))
OUT_DIR = Path(os.environ.get("OUT_DIR", f"/tmp/inlay_usage_{SAMPLE_SIZE}_20260519"))
REPORT_DIR = Path(os.environ.get("REPORT_DIR", str(Path(__file__).resolve().parent)))

POPULATION = OUT_DIR / "population.jsonl"
CANDIDATES = OUT_DIR / "sample_candidates.jsonl"
RESULTS = OUT_DIR / "lsp_usage_results.jsonl"
SKIPPED = OUT_DIR / "lsp_usage_skipped.jsonl"
TIMEOUTS = OUT_DIR / "lsp_usage_timeouts.jsonl"
SUMMARY = REPORT_DIR / "summary.md"
DISCREPANCIES = REPORT_DIR / "discrepancies.jsonl"

DISCOVERY_WORKERS = int(os.environ.get("DISCOVERY_WORKERS", "12"))
LSP_WORKERS = int(os.environ.get("WORKERS", "3"))
LSP_TIMEOUT_SECONDS = float(os.environ.get("PYRIGHT_TIMEOUT", "90"))
INITIAL_LSP_SLEEP_SECONDS = float(os.environ.get("PYRIGHT_INITIAL_SLEEP", "5"))
RESTART_LSP_SLEEP_SECONDS = float(
    os.environ.get("PYRIGHT_RESTART_SLEEP", str(min(INITIAL_LSP_SLEEP_SECONDS, 1.0)))
)
RANDOM_SEED = int(os.environ.get("RANDOM_SEED", "20260519"))
OVERSAMPLE_FACTOR = int(os.environ.get("OVERSAMPLE_FACTOR", "5"))
REUSE_POPULATION = os.environ.get("REUSE_POPULATION", "1") != "0"
REUSE_CANDIDATES = os.environ.get("REUSE_CANDIDATES", "1") != "0"
RESUME_RESULTS = os.environ.get("RESUME_RESULTS", "1") != "0"
RETRY_SKIPPED = os.environ.get("RETRY_SKIPPED", "0") == "1"
RETRY_TIMEOUTS = os.environ.get("RETRY_TIMEOUTS", "0") == "1"
LSP_TIMEOUT_FAMILY_THRESHOLD = int(os.environ.get("LSP_TIMEOUT_FAMILY_THRESHOLD", "3"))
LSP_TIMEOUT_FAMILY_MIN_USAGE = int(os.environ.get("LSP_TIMEOUT_FAMILY_MIN_USAGE", "20"))
SEND_DID_OPEN = os.environ.get("SEND_DID_OPEN", "0") == "1"
REFRESH_GRAPH_USAGE = os.environ.get("REFRESH_GRAPH_USAGE", "1") != "0"
GRAPH_SYMBOL_LIMIT = int(os.environ.get("GRAPH_SYMBOL_LIMIT", "500000"))
STOP_AFTER_CANDIDATES = os.environ.get("STOP_AFTER_CANDIDATES", "0") == "1"

KIND_MAP = {
    "function": "function",
    "method": "method",
    "constructor": "method",
    "property": "method",
    "class": "class",
    "constant": "field",
    "field": "field",
}

class LspClient:
    def __init__(self, command: list[str], root: Path, timeout_seconds: float):
        self.proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self.root = root
        self.timeout_seconds = timeout_seconds
        self._id = 0
        self._lock = threading.Lock()
        self._responses: dict[int, dict] = {}
        self._cv = threading.Condition()
        self._opened_uris: set[str] = set()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        stream = self.proc.stdout
        assert stream is not None
        while True:
            line = stream.readline()
            if not line:
                return
            if not line.startswith(b"Content-Length:"):
                continue
            length = int(line.split(b":", 1)[1].strip())
            stream.readline()
            body = stream.read(length)
            try:
                msg = json.loads(body)
            except Exception:
                continue
            mid = msg.get("id")
            if mid is None:
                continue
            with self._cv:
                self._responses[mid] = msg
                self._cv.notify_all()

    def _send(self, method: str, params: dict) -> dict | None:
        if self.proc.poll() is not None:
            return None
        with self._lock:
            self._id += 1
            mid = self._id
        msg = {"jsonrpc": "2.0", "id": mid, "method": method, "params": params}
        body = json.dumps(msg).encode()
        header = f"Content-Length: {len(body)}\r\n\r\n".encode()
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.write(header + body)
            self.proc.stdin.flush()
        except Exception:
            return None
        deadline = time.time() + self.timeout_seconds
        with self._cv:
            while mid not in self._responses:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self._cv.wait(timeout=min(remaining, 1.0))
            return self._responses.pop(mid)

    def _notify(self, method: str, params: dict) -> None:
        if self.proc.poll() is not None:
            return
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        body = json.dumps(msg).encode()
        header = f"Content-Length: {len(body)}\r\n\r\n".encode()
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.write(header + body)
            self.proc.stdin.flush()
        except Exception:
            return

    def initialize(self) -> dict | None:
        root_uri = "file://" + str(self.root)
        response = self._send(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": root_uri,
                "rootPath": str(self.root),
                "capabilities": {
                    "textDocument": {
                        "references": {"dynamicRegistration": False},
                        "synchronization": {"dynamicRegistration": False},
                    },
                    "workspace": {"workspaceFolders": True},
                },
                "workspaceFolders": [{"uri": root_uri, "name": "captain"}],
                "initializationOptions": {},
            },
        )
        self._notify("initialized", {})
        return response

    def open_file(self, file_uri: str, text: str) -> None:
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
        response = self._send(
            "textDocument/references",
            {
                "textDocument": {"uri": file_uri},
                "position": {"line": line, "character": character},
                "context": {"includeDeclaration": False},
            },
        )
        if response is None:
            return None
        result = response.get("result")
        if result is None:
            return None
        return len(result)

    def shutdown(self, graceful: bool = False) -> None:
        if graceful:
            try:
                old_timeout = self.timeout_seconds
                self.timeout_seconds = min(old_timeout, 2.0)
                self._send("shutdown", {})
                self.timeout_seconds = old_timeout
                self._notify("exit", {})
            except Exception:
                pass
        try:
            self.proc.terminate()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=2)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def run_capture(args: list[str], cwd: Path | None = None, timeout: int = 30) -> str:
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception as exc:
        return f"ERROR: {exc}"
    text = (proc.stdout or proc.stderr).strip()
    if proc.returncode != 0:
        return f"ERROR({proc.returncode}): {text[:500]}"
    return text[:1000]


def ensure_inputs() -> None:
    required = [WORKSPACE, ZRS, PYTHON]
    if not complete_lsp_results_available():
        required.append(PYRIGHT)
    missing = [path for path in required if not path.exists()]
    if missing:
        raise SystemExit(f"missing required path(s): {missing}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)


def complete_lsp_results_available() -> bool:
    if FULL_CENSUS:
        return False
    if not RESUME_RESULTS or not RESULTS.exists():
        return False
    counts = Counter()
    try:
        with RESULTS.open() as fh:
            for line in fh:
                if not line.strip():
                    continue
                rec = json.loads(line)
                stratum = rec.get("stratum")
                if stratum in TARGETS and counts[stratum] < TARGETS[stratum]:
                    counts[stratum] += 1
    except Exception:
        return False
    return all(counts[stratum] >= target for stratum, target in TARGETS.items())


def jsonl_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as fh:
        return [json.loads(line) for line in fh if line.strip()]


def rec_symbol_id(rec: dict) -> str | None:
    symbol_id = rec.get("symbolId")
    return symbol_id if isinstance(symbol_id, str) else None


def timeout_family_key(rec: dict) -> tuple[str, str] | None:
    stratum = rec.get("stratum")
    name = rec.get("name")
    if not isinstance(stratum, str) or not isinstance(name, str) or not name:
        return None
    return stratum, name


def should_quarantine_timeout_family(rec: dict, counts: Counter[tuple[str, str]]) -> bool:
    key = timeout_family_key(rec)
    if key is None:
        return False
    if counts[key] < LSP_TIMEOUT_FAMILY_THRESHOLD:
        return False
    return int(rec.get("usage") or 0) >= LSP_TIMEOUT_FAMILY_MIN_USAGE


def query_file(file_path: Path) -> tuple[Path, list[dict] | None, str | None]:
    uri = "file://" + str(file_path)
    try:
        proc = subprocess.run(
            [
                str(ZRS),
                "graph-symbol-query",
                str(WORKSPACE),
                "--uri",
                uri,
                "--limit",
                "5000",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return file_path, None, "timeout"
    if proc.returncode != 0 and not proc.stdout.strip():
        return file_path, None, proc.stderr.strip()[:300]
    try:
        data = json.loads(proc.stdout)
    except Exception as exc:
        return file_path, None, f"json: {exc}"
    if not data.get("ok"):
        return file_path, None, json.dumps(data)[:300]
    return file_path, data.get("symbols", []), None


def query_all_symbols() -> tuple[list[dict] | None, str | None]:
    try:
        proc = subprocess.run(
            [
                str(ZRS),
                "graph-symbol-query",
                str(WORKSPACE),
                "--limit",
                str(GRAPH_SYMBOL_LIMIT),
                "--no-implementation-counts",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    if proc.returncode != 0 and not proc.stdout.strip():
        return None, proc.stderr.strip()[:300]
    try:
        data = json.loads(proc.stdout)
    except Exception as exc:
        return None, f"json: {exc}"
    if not data.get("ok"):
        return None, json.dumps(data)[:300]
    return data.get("symbols", []), None


def symbol_to_record(symbol: dict) -> dict:
    range_data = symbol.get("range") or {}
    return {
        "file": symbol.get("relPath"),
        "name": symbol.get("name"),
        "kind": symbol.get("kind"),
        "line": range_data.get("startLine"),
        "col": range_data.get("startColumn"),
        "endLine": range_data.get("endLine"),
        "endCol": range_data.get("endColumn"),
        "usage": symbol.get("usageCount", 0) or 0,
        "qualifiedName": symbol.get("qualifiedName"),
        "symbolId": symbol.get("id"),
    }


def extract_population() -> list[dict]:
    if REUSE_POPULATION and POPULATION.exists():
        print(f"population: reusing {POPULATION}", flush=True)
        with POPULATION.open() as fh:
            return [json.loads(line) for line in fh if line.strip()]

    symbols, err = query_all_symbols()
    if err is None:
        records: list[dict] = []
        with POPULATION.open("w") as out:
            for symbol in symbols or []:
                rel_path = str(symbol.get("relPath") or "")
                if (
                    symbol.get("language") != "python"
                    or not rel_path.startswith("zuzu/")
                    or not rel_path.endswith(".py")
                    or "/migrations/" in rel_path
                ):
                    continue
                rec = symbol_to_record(symbol)
                out.write(json.dumps(rec) + "\n")
                records.append(rec)
        print(
            f"population: bulk graph query symbols={len(symbols or [])} "
            f"python_records={len(records)}",
            flush=True,
        )
        return records
    print(f"population: bulk graph query failed, falling back to per-file scan: {err}", flush=True)

    files = [
        path
        for path in (WORKSPACE / "zuzu").rglob("*.py")
        if "/migrations/" not in str(path)
    ]
    files.sort()
    print(f"population: discovered {len(files)} Python files", flush=True)
    records: list[dict] = []
    errors = 0
    t0 = time.time()
    with POPULATION.open("w") as out:
        with concurrent.futures.ThreadPoolExecutor(max_workers=DISCOVERY_WORKERS) as ex:
            futures = {ex.submit(query_file, path): path for path in files}
            for index, fut in enumerate(concurrent.futures.as_completed(futures), start=1):
                file_path, symbols, err = fut.result()
                if err is not None:
                    errors += 1
                    if errors <= 10:
                        print(f"population error {file_path}: {err}", flush=True)
                    continue
                rel = file_path.relative_to(WORKSPACE)
                for symbol in symbols or []:
                    rec = {**symbol_to_record(symbol), "file": str(rel)}
                    out.write(json.dumps(rec) + "\n")
                    records.append(rec)
                if index % 500 == 0:
                    elapsed = time.time() - t0
                    print(
                        f"population: processed {index}/{len(files)} files, "
                        f"{len(records)} symbols, elapsed={elapsed:.1f}s",
                        flush=True,
                    )
    print(
        f"population: done files={len(files)} symbols={len(records)} "
        f"errors={errors} elapsed={time.time() - t0:.1f}s",
        flush=True,
    )
    return records


def is_identifier_name(name: object) -> bool:
    if not isinstance(name, str) or not name:
        return False
    if not (name[0].isalpha() or name[0] == "_"):
        return False
    return all(ch.isalnum() or ch == "_" for ch in name)


def make_candidate_records(population: list[dict]) -> list[dict]:
    if REUSE_CANDIDATES and CANDIDATES.exists():
        print(f"sample pool: reusing {CANDIDATES}", flush=True)
        with CANDIDATES.open() as fh:
            return [json.loads(line) for line in fh if line.strip()]

    random.seed(RANDOM_SEED)
    buckets: dict[str, list[dict]] = defaultdict(list)
    for rec in population:
        if rec.get("line") is None or rec.get("col") is None:
            continue
        if not is_identifier_name(rec.get("name")):
            continue
        stratum = KIND_MAP.get(str(rec.get("kind") or "").lower())
        if not stratum:
            continue
        if FULL_CENSUS and not CENSUS_INCLUDE_ZERO_USAGE:
            if rec.get("usage", 0) < CENSUS_MIN_USAGE:
                continue
        if not FULL_CENSUS and rec.get("usage", 0) == 0 and random.random() > 0.10:
            continue
        rec = {**rec, "stratum": stratum}
        buckets[stratum].append(rec)

    candidates: list[dict] = []
    if FULL_CENSUS:
        ordered_strata = [
            value.strip()
            for value in os.environ.get(
                "CENSUS_STRATA_ORDER", "method,function,field,class"
            ).split(",")
            if value.strip()
        ]
        ordered_strata.extend(
            stratum for stratum in sorted(buckets) if stratum not in ordered_strata
        )
        for stratum, pool in sorted(buckets.items()):
            pool.sort(key=lambda rec: (str(rec.get("file") or ""), int(rec.get("line") or 0), int(rec.get("col") or 0)))
            print(f"census pool {stratum}: eligible={len(pool)}", flush=True)
        if CENSUS_ORDER == "stratum":
            for stratum in ordered_strata:
                candidates.extend(buckets.get(stratum, []))
        elif CENSUS_ORDER == "random":
            for stratum in ordered_strata:
                candidates.extend(buckets.get(stratum, []))
            random.shuffle(candidates)
        else:
            offsets = {stratum: 0 for stratum in ordered_strata}
            while True:
                progressed = False
                for stratum in ordered_strata:
                    pool = buckets.get(stratum, [])
                    offset = offsets[stratum]
                    if offset >= len(pool):
                        continue
                    candidates.append(pool[offset])
                    offsets[stratum] = offset + 1
                    progressed = True
                if not progressed:
                    break
    else:
        for stratum, target in TARGETS.items():
            pool = buckets.get(stratum, [])
            random.shuffle(pool)
            wanted = min(len(pool), max(target * OVERSAMPLE_FACTOR, target))
            candidates.extend(pool[:wanted])
            print(
                f"sample pool {stratum}: eligible={len(pool)} candidates={wanted} "
                f"target_valid={target}",
                flush=True,
            )
    if not FULL_CENSUS:
        random.shuffle(candidates)
    with CANDIDATES.open("w") as out:
        for rec in candidates:
            out.write(json.dumps(rec) + "\n")
    print(f"sample pool: wrote {len(candidates)} candidates to {CANDIDATES}", flush=True)
    return candidates


def candidate_positions(rec: dict, text: str) -> list[int]:
    line_no = rec["line"]
    name = str(rec.get("name") or "")
    line = text.splitlines()[line_no] if line_no < len(text.splitlines()) else ""
    positions = [int(rec["col"])]
    found = line.find(name)
    if found >= 0:
        positions.append(found)
    kind = str(rec.get("kind") or "").lower()
    if kind in {"function", "method", "constructor"}:
        positions.append(int(rec["col"]) + 4)
    elif kind == "class":
        positions.append(int(rec["col"]) + 6)
    out: list[int] = []
    for value in positions:
        if value >= 0 and value not in out:
            out.append(value)
    return out


def query_usage(client: LspClient, rec: dict) -> tuple[int | None, str | None]:
    file_path = WORKSPACE / rec["file"]
    if not file_path.exists():
        return None, "missing-file"
    try:
        text = file_path.read_text()
    except Exception as exc:
        return None, f"read-error:{exc}"
    file_uri = "file://" + str(file_path)
    if SEND_DID_OPEN:
        client.open_file(file_uri, text)
    for col in candidate_positions(rec, text):
        result = client.references(file_uri, int(rec["line"]), col)
        if result is not None:
            return result, None
    return None, "lsp-timeout-or-null"


def run_lsp_until_targets(candidates: list[dict]) -> tuple[list[dict], list[dict]]:
    results: list[dict] = []
    skipped: list[dict] = []
    timeouts: list[dict] = []
    seen_symbols: set[str] = set()
    timeout_family_counts: Counter[tuple[str, str]] = Counter()
    valid_counts = Counter()

    if RESUME_RESULTS and RESULTS.exists():
        for rec in jsonl_rows(RESULTS):
            stratum = rec.get("stratum")
            if FULL_CENSUS or (stratum in TARGETS and valid_counts[stratum] < TARGETS[stratum]):
                results.append(rec)
                valid_counts[stratum] += 1
                if symbol_id := rec_symbol_id(rec):
                    seen_symbols.add(symbol_id)
        legacy_timeouts: list[dict] = []
        for rec in jsonl_rows(SKIPPED):
            if rec.get("skip_reason") == "lsp-timeout-or-null":
                legacy_timeouts.append(rec)
                if key := timeout_family_key(rec):
                    timeout_family_counts[key] += 1
                if not RETRY_TIMEOUTS:
                    if symbol_id := rec_symbol_id(rec):
                        seen_symbols.add(symbol_id)
            else:
                skipped.append(rec)
                if not RETRY_SKIPPED:
                    if symbol_id := rec_symbol_id(rec):
                        seen_symbols.add(symbol_id)
        timeout_symbol_ids: set[str] = set()
        for rec in jsonl_rows(TIMEOUTS):
            timeouts.append(rec)
            if key := timeout_family_key(rec):
                timeout_family_counts[key] += 1
            if symbol_id := rec_symbol_id(rec):
                timeout_symbol_ids.add(symbol_id)
                if not RETRY_TIMEOUTS:
                    seen_symbols.add(symbol_id)
        migrated_timeouts = [
            rec for rec in legacy_timeouts
            if (rec_symbol_id(rec) or "") not in timeout_symbol_ids
        ]
        if migrated_timeouts:
            with TIMEOUTS.open("a", buffering=1) as timeouts_out:
                for rec in migrated_timeouts:
                    timeouts.append(rec)
                    timeouts_out.write(json.dumps(rec) + "\n")
        print(
            f"lsp: resuming {len(results)} valid results "
            f"counts={dict(valid_counts)} skipped={len(skipped)} "
            f"timeouts={len(timeouts)}",
            flush=True,
        )
        if not FULL_CENSUS and all(valid_counts[stratum] >= target for stratum, target in TARGETS.items()):
            print(
                f"lsp: reusing complete result set valid={len(results)} "
                f"skipped={len(skipped)}",
                flush=True,
            )
            return results, skipped

    work_q: Queue[dict | None] = Queue()
    for rec in candidates:
        symbol_id = rec.get("symbolId")
        if isinstance(symbol_id, str) and symbol_id in seen_symbols:
            continue
        work_q.put(rec)
    for _ in range(LSP_WORKERS):
        work_q.put(None)

    result_lock = threading.Lock()
    stop = threading.Event()
    t0 = time.time()

    def targets_met() -> bool:
        if FULL_CENSUS:
            return False
        return all(valid_counts[stratum] >= target for stratum, target in TARGETS.items())

    def new_client(worker_id: int, sleep_seconds: float = INITIAL_LSP_SLEEP_SECONDS) -> LspClient:
        client = LspClient([str(PYRIGHT), "--stdio"], WORKSPACE, LSP_TIMEOUT_SECONDS)
        init = client.initialize()
        if init is None:
            print(f"worker {worker_id}: pyright initialize timed out", flush=True)
        if sleep_seconds > 0:
            time.sleep(sleep_seconds)
        return client

    def worker(worker_id: int) -> None:
        client = new_client(worker_id)
        try:
            while not stop.is_set():
                try:
                    rec = work_q.get(timeout=1)
                except Empty:
                    continue
                if rec is None:
                    return
                stratum = rec["stratum"]
                with result_lock:
                    if should_quarantine_timeout_family(rec, timeout_family_counts):
                        row = {**rec, "skip_reason": "lsp-timeout-family"}
                        timeouts.append(row)
                        if key := timeout_family_key(row):
                            timeout_family_counts[key] += 1
                        if symbol_id := rec_symbol_id(row):
                            seen_symbols.add(symbol_id)
                        timeouts_out.write(json.dumps(row) + "\n")
                        timeouts_out.flush()
                        if len(timeouts) % 50 == 0:
                            print(
                                "lsp: "
                                f"timeout-family quarantined={len(timeouts)} "
                                f"valid={len(results)}",
                                flush=True,
                            )
                        continue
                    if not FULL_CENSUS and valid_counts[stratum] >= TARGETS[stratum]:
                        continue
                lsp_usage, error = query_usage(client, rec)
                with result_lock:
                    if lsp_usage is None:
                        row = {**rec, "skip_reason": error or "unknown"}
                        if error == "lsp-timeout-or-null":
                            timeouts.append(row)
                            if key := timeout_family_key(row):
                                timeout_family_counts[key] += 1
                            if symbol_id := rec_symbol_id(row):
                                seen_symbols.add(symbol_id)
                            timeouts_out.write(json.dumps(row) + "\n")
                            timeouts_out.flush()
                            print(
                                f"worker {worker_id}: quarantined timeout "
                                f"at {rec.get('file')}:{int(rec.get('line') or 0) + 1}",
                                flush=True,
                            )
                            client.shutdown()
                            client = new_client(worker_id, RESTART_LSP_SLEEP_SECONDS)
                        else:
                            skipped.append(row)
                            skipped_out.write(json.dumps(row) + "\n")
                            skipped_out.flush()
                    elif FULL_CENSUS or valid_counts[stratum] < TARGETS[stratum]:
                        valid_counts[stratum] += 1
                        row = {**rec, "lsp_usage": lsp_usage}
                        results.append(row)
                        symbol_id = row.get("symbolId")
                        if isinstance(symbol_id, str):
                            seen_symbols.add(symbol_id)
                        results_out.write(json.dumps(row) + "\n")
                        results_out.flush()
                        if len(results) % 50 == 0:
                            elapsed = time.time() - t0
                            target_total = len(candidates) if FULL_CENSUS else sum(TARGETS.values())
                            print(
                                "lsp: "
                                f"valid={len(results)}/{target_total} "
                                f"counts={dict(valid_counts)} "
                                f"skipped={len(skipped)} timeouts={len(timeouts)} "
                                f"elapsed={elapsed:.1f}s",
                                flush=True,
                            )
                        if targets_met():
                            stop.set()
        finally:
            client.shutdown()

    result_mode = "a" if results else "w"
    skipped_mode = "a" if RESUME_RESULTS and SKIPPED.exists() else "w"
    timeouts_mode = "a" if RESUME_RESULTS and TIMEOUTS.exists() else "w"
    with RESULTS.open(result_mode, buffering=1) as results_out:
        with SKIPPED.open(skipped_mode, buffering=1) as skipped_out:
            with TIMEOUTS.open(timeouts_mode, buffering=1) as timeouts_out:
                with concurrent.futures.ThreadPoolExecutor(max_workers=LSP_WORKERS) as ex:
                    futures = [ex.submit(worker, idx) for idx in range(LSP_WORKERS)]
                    for fut in concurrent.futures.as_completed(futures):
                        fut.result()
    print(
        f"lsp: done valid={len(results)} skipped={len(skipped)} "
        f"timeouts={len(timeouts)} counts={dict(valid_counts)} "
        f"elapsed={time.time() - t0:.1f}s",
        flush=True,
    )
    return results, skipped


def refresh_graph_usage_counts(results: list[dict]) -> tuple[list[dict], dict[str, int]]:
    if not REFRESH_GRAPH_USAGE or not results:
        return results, {"changed": 0, "missing": 0, "errors": 0}

    symbols, err = query_all_symbols()
    if err is None:
        symbol_map = {
            str(symbol.get("id") or symbol.get("symbolId")): symbol
            for symbol in symbols or []
        }
        changed = 0
        missing = 0
        refreshed: list[dict] = []
        for rec in results:
            symbol = symbol_map.get(str(rec.get("symbolId")))
            row = dict(rec)
            row.pop("graph_symbol_missing", None)
            if symbol is None:
                missing += 1
                row["graph_symbol_missing"] = True
                refreshed.append(row)
                continue
            new_usage = graph_conservative_usage(symbol)
            old_usage = int(rec.get("usage") or 0)
            if old_usage != new_usage:
                row.setdefault("previous_usage", old_usage)
                row["usage"] = new_usage
                changed += 1
            attach_graph_bound_counts(row, symbol)
            refreshed.append(row)
        with RESULTS.open("w") as out:
            for rec in refreshed:
                out.write(json.dumps(rec) + "\n")
        print(
            f"refresh: bulk graph usage changed={changed} missing={missing} "
            f"symbols={len(symbols or [])}",
            flush=True,
        )
        return refreshed, {"changed": changed, "missing": missing, "errors": 0}
    print(f"refresh: bulk graph query failed, falling back to per-file scan: {err}", flush=True)

    by_file: dict[str, list[dict]] = defaultdict(list)
    for rec in results:
        by_file[str(rec["file"])].append(rec)

    symbol_maps: dict[str, dict[str, dict]] = {}
    errors: list[str] = []
    t0 = time.time()
    files = sorted(by_file)
    print(f"refresh: querying current graph usage for {len(files)} files", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=DISCOVERY_WORKERS) as ex:
        futures = {
            ex.submit(query_file, WORKSPACE / rel_path): rel_path for rel_path in files
        }
        for index, fut in enumerate(concurrent.futures.as_completed(futures), start=1):
            rel_path = futures[fut]
            _, symbols, err = fut.result()
            if err is not None:
                errors.append(f"{rel_path}: {err}")
                continue
            symbol_maps[rel_path] = {
                str(symbol.get("symbolId") or symbol.get("id")): symbol
                for symbol in symbols or []
            }
            if index % 200 == 0:
                print(
                    f"refresh: processed {index}/{len(files)} files elapsed={time.time() - t0:.1f}s",
                    flush=True,
                )

    changed = 0
    missing = 0
    refreshed: list[dict] = []
    for rec in results:
        rel_path = str(rec["file"])
        symbol = symbol_maps.get(rel_path, {}).get(str(rec.get("symbolId")))
        row = dict(rec)
        row.pop("graph_symbol_missing", None)
        if symbol is None:
            missing += 1
            row["graph_symbol_missing"] = True
            refreshed.append(row)
            continue
        new_usage = graph_conservative_usage(symbol)
        old_usage = int(rec.get("usage") or 0)
        if old_usage != new_usage:
            row.setdefault("previous_usage", old_usage)
            row["usage"] = new_usage
            changed += 1
        attach_graph_bound_counts(row, symbol)
        refreshed.append(row)

    with RESULTS.open("w") as out:
        for rec in refreshed:
            out.write(json.dumps(rec) + "\n")
    print(
        f"refresh: updated current graph usage changed={changed} missing={missing} "
        f"errors={len(errors)} elapsed={time.time() - t0:.1f}s",
        flush=True,
    )
    for error in errors[:10]:
        print(f"refresh error {error}", flush=True)
    return refreshed, {"changed": changed, "missing": missing, "errors": len(errors)}


def graph_conservative_usage(symbol: dict) -> int:
    return int(
        symbol.get("usageMayCount")
        or symbol.get("usageCount")
        or symbol.get("usage")
        or 0
    )


def attach_graph_bound_counts(row: dict, symbol: dict) -> None:
    if "usageMustCount" in symbol:
        row["usage_must"] = int(symbol.get("usageMustCount") or 0)
    if "usageMayCount" in symbol:
        row["usage_may"] = int(symbol.get("usageMayCount") or 0)


def classify_usage(rec: dict) -> str:
    inlay = int(rec.get("usage") or 0)
    lsp = int(rec.get("lsp_usage") or 0)
    if inlay == lsp:
        return "match"
    diff = inlay - lsp
    if inlay == 0 and lsp > 0:
        return "inlay_missed"
    if inlay > 0 and lsp == 0:
        return "inlay_over_no_lsp_refs"
    if diff > 0:
        if diff <= 5:
            return "inlay_over_by_1-5"
        if diff <= 50:
            return "inlay_over_by_6-50"
        return "inlay_over_by_50plus"
    under = -diff
    if under <= 5:
        return "inlay_under_by_1-5"
    if under <= 50:
        return "inlay_under_by_6-50"
    return "inlay_under_by_50plus"


def summarize(
    results: list[dict], skipped: list[dict], refresh_stats: dict[str, int] | None
) -> None:
    graph_missing_count = sum(1 for rec in results if rec.get("graph_symbol_missing"))
    results = [rec for rec in results if not rec.get("graph_symbol_missing")]
    timeout_count = len(jsonl_rows(TIMEOUTS))
    n = len(results)
    if n == 0:
        SUMMARY.write_text("No valid LSP usage results.\n")
        return
    diffs = [int(r.get("usage") or 0) - int(r.get("lsp_usage") or 0) for r in results]
    abs_diffs = [abs(value) for value in diffs]
    match_count = sum(1 for diff in diffs if diff == 0)
    within1 = sum(1 for diff in abs_diffs if diff <= 1)
    within5 = sum(1 for diff in abs_diffs if diff <= 5)
    conservative_ci = 1.96 * math.sqrt(0.25 / n) * 100
    tags = Counter(classify_usage(rec) for rec in results)

    by_kind: dict[str, list[dict]] = defaultdict(list)
    for rec in results:
        by_kind[str(rec.get("kind") or "?")].append(rec)

    pyright_version = (
        run_capture([str(WORKSPACE / ".venv/bin/pyright"), "--version"], WORKSPACE)
        if (WORKSPACE / ".venv/bin/pyright").exists()
        else "unavailable"
    )
    django_stubs = run_capture([str(PYTHON), "-m", "pip", "show", "django-stubs"], WORKSPACE)
    django_stubs_fields = dict(
        line.split(": ", 1) for line in django_stubs.splitlines() if ": " in line
    )
    django_stubs_summary = "unknown"
    if django_stubs_fields.get("Name"):
        django_stubs_summary = (
            django_stubs_fields["Name"]
            + " "
            + django_stubs_fields.get("Version", "unknown")
        )

    lines: list[str] = []
    lines.append("# Inlay Usage Accuracy Rerun")
    lines.append("")
    lines.append(f"- Date: {date.today().isoformat()}")
    lines.append(f"- Workspace: `{WORKSPACE}`")
    lines.append(f"- Current zoek-rs: `{ZRS}`")
    lines.append(f"- Pyright: `{PYRIGHT}` ({pyright_version})")
    lines.append(f"- django-stubs: {django_stubs_summary}")
    lines.append(f"- Census mode: {'full population' if FULL_CENSUS else 'stratified sample'}")
    if FULL_CENSUS:
        lines.append(
            "- Census zero-usage symbols: "
            f"{'included' if CENSUS_INCLUDE_ZERO_USAGE else 'excluded'}"
        )
        if not CENSUS_INCLUDE_ZERO_USAGE:
            lines.append(f"- Census minimum graph usage: {CENSUS_MIN_USAGE}")
    lines.append(f"- Valid LSP usage sample: **{n}**")
    if graph_missing_count:
        lines.append(
            f"- Dropped cached LSP symbols missing from current graph: {graph_missing_count}"
        )
    lines.append(f"- Skipped/unknown LSP candidates: {len(skipped)}")
    if timeout_count:
        lines.append(f"- Quarantined LSP timeout candidates: {timeout_count}")
    lines.append(f"- Conservative 95% proportion margin at n={n}: +/-{conservative_ci:.1f}%")
    if refresh_stats is not None:
        lines.append(
            "- Current graph usage refresh: "
            f"changed={refresh_stats.get('changed', 0)}, "
            f"missing={refresh_stats.get('missing', 0)}, "
            f"errors={refresh_stats.get('errors', 0)}"
        )
    refreshed_count = sum(1 for rec in results if "previous_usage" in rec)
    if refreshed_count:
        lines.append(f"- Graph usage changed from cached baseline: {refreshed_count}/{n}")
    bound_count = sum(1 for rec in results if "usage_must" in rec and "usage_may" in rec)
    if bound_count:
        interval_exact = sum(
            1
            for rec in results
            if int(rec.get("usage_must") or 0) == int(rec.get("usage_may") or 0)
        )
        lines.append(
            "- Graph bound counts: "
            f"{bound_count}/{n} rows include must/may; "
            f"interval-exact={interval_exact}/{bound_count}"
        )
    lines.append("")
    lines.append("## Usage Signal")
    lines.append("")
    lines.append(f"- Exact match: **{match_count}/{n} = {match_count / n * 100:.1f}%**")
    lines.append(f"- Within +/-1: {within1 / n * 100:.1f}%")
    lines.append(f"- Within +/-5: {within5 / n * 100:.1f}%")
    lines.append(f"- Mean absolute error: {statistics.mean(abs_diffs):.2f}")
    lines.append(f"- Inlay mean: {statistics.mean(int(r.get('usage') or 0) for r in results):.2f}")
    lines.append(f"- Pyright mean: {statistics.mean(int(r.get('lsp_usage') or 0) for r in results):.2f}")
    lines.append("")
    lines.append("## Per Kind")
    lines.append("")
    lines.append("| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for kind, items in sorted(by_kind.items(), key=lambda item: -len(item[1])):
        item_diffs = [int(r.get("usage") or 0) - int(r.get("lsp_usage") or 0) for r in items]
        item_abs = [abs(value) for value in item_diffs]
        item_n = len(items)
        item_match = sum(1 for value in item_diffs if value == 0)
        lines.append(
            f"| {kind} | {item_n} | {item_match / item_n * 100:.1f} | "
            f"{sum(1 for value in item_abs if value <= 1) / item_n * 100:.1f} | "
            f"{sum(1 for value in item_abs if value <= 5) / item_n * 100:.1f} | "
            f"{statistics.mean(item_abs):.2f} | "
            f"{statistics.mean(int(r.get('usage') or 0) for r in items):.2f} | "
            f"{statistics.mean(int(r.get('lsp_usage') or 0) for r in items):.2f} |"
        )
    lines.append("")
    lines.append("## Error Pattern Distribution")
    lines.append("")
    lines.append("| tag | n | percent |")
    lines.append("|---|---:|---:|")
    for tag, count in tags.most_common():
        lines.append(f"| {tag} | {count} | {count / n * 100:.1f}% |")
    lines.append("")

    over = sorted(
        [r for r in results if int(r.get("usage") or 0) > int(r.get("lsp_usage") or 0)],
        key=lambda r: int(r.get("usage") or 0) - int(r.get("lsp_usage") or 0),
        reverse=True,
    )
    under = sorted(
        [r for r in results if int(r.get("usage") or 0) < int(r.get("lsp_usage") or 0)],
        key=lambda r: int(r.get("lsp_usage") or 0) - int(r.get("usage") or 0),
        reverse=True,
    )
    lines.append("## Top Over Counts")
    lines.append("")
    lines.append("| diff | file:line | name | kind | inlay | pyright |")
    lines.append("|---:|---|---|---|---:|---:|")
    for rec in over[:30]:
        diff = int(rec.get("usage") or 0) - int(rec.get("lsp_usage") or 0)
        lines.append(
            f"| +{diff} | `{rec['file']}:{int(rec['line']) + 1}` | "
            f"`{rec['name']}` | {rec.get('kind')} | {rec.get('usage')} | {rec.get('lsp_usage')} |"
        )
    lines.append("")
    lines.append("## Top Under Counts")
    lines.append("")
    lines.append("| diff | file:line | name | kind | inlay | pyright |")
    lines.append("|---:|---|---|---|---:|---:|")
    for rec in under[:30]:
        diff = int(rec.get("usage") or 0) - int(rec.get("lsp_usage") or 0)
        lines.append(
            f"| {diff} | `{rec['file']}:{int(rec['line']) + 1}` | "
            f"`{rec['name']}` | {rec.get('kind')} | {rec.get('usage')} | {rec.get('lsp_usage')} |"
        )
    lines.append("")
    lines.append("## Artifacts")
    lines.append("")
    lines.append(f"- Population: `{POPULATION}`")
    lines.append(f"- Candidate pool: `{CANDIDATES}`")
    lines.append(f"- Valid LSP results: `{RESULTS}`")
    lines.append(f"- Skipped LSP candidates: `{SKIPPED}`")
    lines.append(f"- Timeout quarantine: `{TIMEOUTS}`")
    lines.append(f"- Discrepancies: `{DISCREPANCIES}`")

    SUMMARY.write_text("\n".join(lines) + "\n")
    with DISCREPANCIES.open("w") as out:
        for rec in results:
            diff = int(rec.get("usage") or 0) - int(rec.get("lsp_usage") or 0)
            if diff != 0:
                out.write(json.dumps({**rec, "usage_diff": diff, "tag": classify_usage(rec)}) + "\n")
    print(f"summary: wrote {SUMMARY}", flush=True)
    print(f"summary: wrote {DISCREPANCIES}", flush=True)


def main() -> None:
    ensure_inputs()
    t0 = time.time()
    population = extract_population()
    candidates = make_candidate_records(population)
    if STOP_AFTER_CANDIDATES:
        print(f"stop: candidate generation complete candidates={len(candidates)}", flush=True)
        return
    results, skipped = run_lsp_until_targets(candidates)
    results, refresh_stats = refresh_graph_usage_counts(results)
    summarize(results, skipped, refresh_stats)
    print(f"done total elapsed={time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
