#!/usr/bin/env python3
"""Check live count/list parity and independent semantic reference expectations.

Name frequency is a lexical diagnostic, never a precision/recall score or an
upper bound: aliases, shadowing, comments and framework edges invalidate that.

  verify_usage_accuracy.py WORKSPACE LIVE_AUDIT.tsv
  verify_usage_accuracy.py WORKSPACE --expectations EXPECTED.json --binary ZOEK

Expectations contain handwritten zero-based [path, line, column] locations.
"""
import argparse
import collections
import csv
import json
from pathlib import Path
import re
import subprocess
import sys

EXTENSIONS = {".py", ".pyi", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx",
              ".mjs", ".cjs", ".java", ".kt", ".kts", ".go", ".rs"}
DEFAULT_EXCLUDES = {".git", ".zoek-rs", "node_modules", ".venv"}
TOKEN = re.compile(r"(?:[^\W\d]|[$_])(?:\w|[$])*")


def lexical_frequency(workspace, excludes=DEFAULT_EXCLUDES):
    import os
    frequency = collections.Counter()
    for root, directories, files in os.walk(workspace):
        directories[:] = [name for name in directories if name not in excludes]
        for name in files:
            source = Path(root) / name
            if source.suffix.lower() not in EXTENSIONS:
                continue
            try:
                frequency.update(TOKEN.findall(source.read_text(encoding="utf-8", errors="replace")))
            except OSError:
                continue
    return frequency


def verify_dump(workspace, dump, excludes):
    frequency = lexical_frequency(workspace, excludes)
    with Path(dump).open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source, delimiter="\t")
        if not {"relPath", "name", "usageCount", "queryable"}.issubset(reader.fieldnames or []):
            raise ValueError("Expected usageCount/queryable columns; regenerate with graph-audit-counts.")
        rows = list(reader)
    mismatches = [row for row in rows if int(row["usageCount"]) != int(row["queryable"])]
    print(json.dumps({
        "check": "live-count-list-parity", "symbols": len(rows), "mismatches": len(mismatches),
        "lexicalDiagnostic": "Name frequency includes comments/strings; it is not precision, recall, or an upper bound.",
        "samples": [{"path": row["relPath"], "name": row["name"], "usageCount": int(row["usageCount"]),
                     "queryable": int(row["queryable"]), "lexicalFrequency": frequency[row["name"]]}
                    for row in (mismatches or rows)[:20]],
    }, ensure_ascii=False))
    return not mismatches


def run_query(binary, *arguments):
    result = subprocess.run([str(binary), *map(str, arguments)], capture_output=True, text=True,
                            encoding="utf-8", timeout=120, check=True)
    response = json.loads(result.stdout)
    if not response.get("ok", False):
        raise ValueError(f"zoek query failed: {response}")
    return response


def verify_semantics(workspace, expectations, binary, rebuild=False):
    expected = json.loads(Path(expectations).read_text(encoding="utf-8"))
    if expected.get("version") != 1 or not expected.get("symbols"):
        raise ValueError("Expectations require version=1 and a non-empty symbols array.")
    if rebuild:
        run_query(binary, "graph-rebuild", workspace, "--workers", 1)
    failures = []
    for item in expected["symbols"]:
        response = run_query(binary, "graph-symbol-query", workspace, "--query", item["query"], "--limit", 100)
        symbols = [symbol for symbol in response.get("symbols", [])
                   if symbol["qualifiedName"] == item["query"] and symbol["relPath"] == item["relPath"]
                   and ("declarationLine" not in item or symbol["range"]["startLine"] == item["declarationLine"])]
        if len(symbols) != 1:
            failures.append({"query": item["query"], "error": "expected one matching declaration", "matches": len(symbols)})
            continue
        symbol = symbols[0]
        result = run_query(binary, "graph-query", workspace, "--symbol-id", symbol["id"], "--limit", 2147483647)
        refs = result["references"]
        if symbol.get("usageCount") != result["totalReferences"] or len(refs) != result["totalReferences"]:
            failures.append({"query": item["query"], "error": "count/list mismatch"})
        all_locations = {(ref["relPath"], ref["range"]["startLine"], ref["range"]["startColumn"]) for ref in refs}
        forbidden = sorted(all_locations & {tuple(location) for location in item.get("forbiddenLocations", [])})
        if forbidden:
            failures.append({"query": item["query"], "error": "forbidden references", "actual": forbidden})
        missing = sorted({tuple(location) for location in item.get("requiredLocations", [])} - all_locations)
        if missing:
            failures.append({"query": item["query"], "error": "missing required references", "expected": missing})
        selected = [ref for ref in refs if ref.get("confidence") in item.get("confidences", ["exact", "resolved"])
                    and (not item.get("edgeKinds") or ref.get("edgeKind") in item["edgeKinds"])]
        actual = sorted({(ref["relPath"], ref["range"]["startLine"], ref["range"]["startColumn"]) for ref in selected})
        wanted = sorted(tuple(location) for location in item["locations"])
        if actual != wanted:
            failures.append({"query": item["query"], "expected": wanted, "actual": actual})
    print(json.dumps({"check": "semantic-reference-locations", "symbols": len(expected["symbols"]),
                      "failures": failures}, ensure_ascii=False))
    return not failures


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", type=Path)
    parser.add_argument("dump", type=Path, nargs="?")
    parser.add_argument("--expectations", type=Path)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--exclude-dir", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        if args.expectations:
            if not args.binary or args.dump:
                parser.error("Semantic mode requires --binary and no audit dump.")
            passed = verify_semantics(args.workspace.resolve(), args.expectations, args.binary.resolve(), args.rebuild)
        else:
            if not args.dump:
                parser.error("Supply a live audit dump or --expectations and --binary.")
            passed = verify_dump(args.workspace, args.dump, DEFAULT_EXCLUDES | set(args.exclude_dir))
        return 0 if passed else 1
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
