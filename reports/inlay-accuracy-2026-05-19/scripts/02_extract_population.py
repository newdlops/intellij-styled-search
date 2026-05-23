"""Enumerate all .py files in zuzu/ (excl. migrations), query zoek-rs graph-symbol-query
per file in parallel, and emit one JSONL per symbol with inlay counts.

Output: /tmp/inlay_accuracy/population.jsonl
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import time
from pathlib import Path

WORKSPACE = Path("/Users/lky/project/captain")
EXT = Path(
    "/Users/lky/.vscode/extensions/newdlops.intellij-styled-search-0.1.706"
)
ZRS = EXT / "target" / "release" / "zoek-rs"
OUT_DIR = Path("/tmp/inlay_accuracy")
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_FILE = OUT_DIR / "population.jsonl"

PARALLEL = 12

# Discover files
files: list[Path] = []
for p in (WORKSPACE / "zuzu").rglob("*.py"):
    # skip migrations to align with engineering focus
    if "/migrations/" in str(p):
        continue
    files.append(p)
files.sort()
print(f"discovered {len(files)} files", file=sys.stderr)


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
        return file_path, None, proc.stderr.strip()[:200]
    try:
        data = json.loads(proc.stdout)
    except Exception as e:
        return file_path, None, f"json: {e}"
    if not data.get("ok"):
        return file_path, None, data.get("warnings", []) or "not-ok"
    return file_path, data.get("symbols", []), None


t0 = time.time()
total_symbols = 0
total_files_ok = 0
errors = 0

with OUT_FILE.open("w") as out, concurrent.futures.ThreadPoolExecutor(
    max_workers=PARALLEL
) as ex:
    futures = {ex.submit(query_file, fp): fp for fp in files}
    for i, fut in enumerate(concurrent.futures.as_completed(futures)):
        fp, symbols, err = fut.result()
        if err is not None:
            errors += 1
            if errors <= 5:
                print(f"ERR {fp}: {err}", file=sys.stderr)
            continue
        total_files_ok += 1
        rel = fp.relative_to(WORKSPACE)
        for s in symbols or []:
            r = s.get("range") or {}
            rec = {
                "file": str(rel),
                "name": s.get("name"),
                "kind": s.get("kind"),
                "line": r.get("startLine"),
                "col": r.get("startColumn"),
                "endLine": r.get("endLine"),
                "endCol": r.get("endColumn"),
                "usage": s.get("usageCount", 0) or 0,
                "impl": s.get("implementationCount", 0) or 0,
                "callee": s.get("calleeCount", 0) or 0,
                "qualifiedName": s.get("qualifiedName"),
                "symbolId": s.get("id"),
            }
            out.write(json.dumps(rec) + "\n")
            total_symbols += 1
        if (i + 1) % 500 == 0:
            elapsed = time.time() - t0
            print(
                f"  processed {i+1}/{len(files)} files, "
                f"{total_symbols} symbols, elapsed={elapsed:.1f}s",
                file=sys.stderr,
            )

elapsed = time.time() - t0
print(
    f"DONE: {total_files_ok} files OK, {errors} errors, "
    f"{total_symbols} symbols, elapsed={elapsed:.1f}s",
    file=sys.stderr,
)
print(f"OUTPUT: {OUT_FILE}", file=sys.stderr)
