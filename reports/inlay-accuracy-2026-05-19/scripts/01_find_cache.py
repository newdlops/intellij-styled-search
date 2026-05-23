"""Find the callgraph cache dir corresponding to the captain workspace."""
import gzip
import json
import os
import sys
from pathlib import Path

WORKSPACE = "/Users/lky/project/captain"
CACHE_BASE = Path(
    os.path.expanduser(
        "~/Library/Application Support/Code/User/globalStorage/newdlops.intellij-styled-search"
    )
)

target = None
for d in sorted(CACHE_BASE.glob("callgraph-*-v14")):
    manifest_gz = d / "manifest.json.gz"
    if not manifest_gz.exists():
        continue
    try:
        with gzip.open(manifest_gz, "rt") as f:
            manifest = json.load(f)
    except Exception as e:
        print(f"SKIP {d.name}: {e}", file=sys.stderr)
        continue
    # Try multiple plausible keys
    candidates = []
    for key in (
        "workspaceRoot",
        "rootPath",
        "workspaceFolder",
        "workspaceUri",
        "workspacePath",
        "rootUri",
    ):
        v = manifest.get(key)
        if v:
            candidates.append((key, v))
    # Also recursively look one level for file-path-like strings
    for k, v in manifest.items():
        if isinstance(v, str) and "/captain" in v:
            candidates.append((k, v))
    if not candidates:
        # Dump top-level keys to debug
        print(f"{d.name}: keys={list(manifest.keys())[:20]}")
    for k, v in candidates:
        if "captain" in str(v):
            print(f"MATCH {d}: {k}={v}")
            target = d
            break
    if target:
        break

if not target:
    # Fall back: try documentSummaryFiles entries
    for d in sorted(CACHE_BASE.glob("callgraph-*-v14")):
        manifest_gz = d / "manifest.json.gz"
        try:
            with gzip.open(manifest_gz, "rt") as f:
                manifest = json.load(f)
        except Exception:
            continue
        files = manifest.get("documentSummaryFiles") or manifest.get("documentSummaries") or []
        for entry in files[:3]:
            if isinstance(entry, dict):
                for v in entry.values():
                    if isinstance(v, str) and "captain" in v:
                        print(f"MATCH(via files) {d}: {v}")
                        target = d
                        break
            elif isinstance(entry, str) and "captain" in entry:
                print(f"MATCH(via files) {d}: {entry}")
                target = d
                break
            if target:
                break
        if target:
            break

if target:
    print(f"\nSELECTED: {target}")
    # Inspect manifest structure
    with gzip.open(target / "manifest.json.gz", "rt") as f:
        manifest = json.load(f)
    print(f"manifest keys: {list(manifest.keys())}")
    for k, v in list(manifest.items())[:30]:
        if isinstance(v, (str, int, float, bool)):
            print(f"  {k} = {v!r}")
        elif isinstance(v, list):
            print(f"  {k}: list len={len(v)}", "first:", v[0] if v else None)
        elif isinstance(v, dict):
            print(f"  {k}: dict keys={list(v.keys())[:10]}")
    sys.exit(0)
else:
    print("NO MATCH FOUND", file=sys.stderr)
    sys.exit(1)
