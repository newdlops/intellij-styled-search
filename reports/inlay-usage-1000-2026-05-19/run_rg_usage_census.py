from __future__ import annotations

import io
import json
import os
import subprocess
import time
import tokenize
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path


WORKSPACE = Path(os.environ.get("CAPTAIN_WORKSPACE", "/Users/lky/project/captain"))
REPO = Path(os.environ.get("IJSS_REPO", "/Users/lky/project/intellij-styled-search"))
ZRS = Path(os.environ.get("ZOEK_RS", str(REPO / "target/release/zoek-rs")))
REPORT_DIR = Path(os.environ.get("REPORT_DIR", str(Path(__file__).resolve().parent)))
OUT_DIR = Path(os.environ.get("OUT_DIR", "/private/tmp/inlay_usage_rg_census"))
GRAPH_SYMBOL_LIMIT = int(os.environ.get("GRAPH_SYMBOL_LIMIT", "500000"))
CENSUS_MIN_USAGE = int(os.environ.get("CENSUS_MIN_USAGE", "5"))

SUMMARY = REPORT_DIR / "summary.md"
DISCREPANCIES = REPORT_DIR / "discrepancies.jsonl"
POPULATION = OUT_DIR / "population.jsonl"

KIND_MAP = {
    "function": "function",
    "method": "method",
    "constructor": "method",
    "property": "method",
    "class": "class",
    "constant": "field",
    "field": "field",
}


def ensure_dirs() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)


def query_all_symbols() -> list[dict]:
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
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or proc.stdout[:500])
    data = json.loads(proc.stdout)
    if not data.get("ok"):
        raise SystemExit(json.dumps(data)[:500])
    return data.get("symbols", [])


def usage_count(symbol: dict) -> int:
    return int(symbol.get("usageCount") or 0)


def usage_may(symbol: dict) -> int:
    return int(symbol.get("usageMayCount") or symbol.get("usageCount") or 0)


def symbol_record(symbol: dict) -> dict:
    range_data = symbol.get("range") or {}
    rel_path = str(symbol.get("relPath") or "")
    return {
        "symbolId": symbol.get("id"),
        "file": rel_path,
        "name": symbol.get("name"),
        "qualifiedName": symbol.get("qualifiedName"),
        "kind": symbol.get("kind"),
        "stratum": KIND_MAP.get(str(symbol.get("kind") or "").lower()),
        "line": int(range_data.get("startLine") or 0),
        "col": int(range_data.get("startColumn") or 0),
        "usage": usage_count(symbol),
        "usage_must": int(symbol.get("usageMustCount") or 0),
        "usage_may": usage_may(symbol),
    }


def is_python_census_symbol(symbol: dict) -> bool:
    rel_path = str(symbol.get("relPath") or "")
    return (
        symbol.get("language") == "python"
        and rel_path.startswith("zuzu/")
        and rel_path.endswith(".py")
        and "/migrations/" not in rel_path
        and KIND_MAP.get(str(symbol.get("kind") or "").lower()) is not None
        and usage_may(symbol) >= CENSUS_MIN_USAGE
    )


def extract_population(symbols: list[dict]) -> list[dict]:
    records = [symbol_record(symbol) for symbol in symbols if is_python_census_symbol(symbol)]
    with POPULATION.open("w") as out:
        for row in records:
            out.write(json.dumps(row) + "\n")
    return records


def is_python_definition_symbol(symbol: dict) -> bool:
    rel_path = str(symbol.get("relPath") or "")
    return (
        symbol.get("language") == "python"
        and rel_path.startswith("zuzu/")
        and rel_path.endswith(".py")
        and "/migrations/" not in rel_path
    )


def all_definition_positions(
    symbols: list[dict], names: set[str]
) -> set[tuple[str, int, int, str]]:
    positions: set[tuple[str, int, int, str]] = set()
    for symbol in symbols:
        if not is_python_definition_symbol(symbol):
            continue
        name = str(symbol.get("name") or "")
        if name not in names:
            continue
        range_data = symbol.get("range") or {}
        positions.add(
            (
                str(symbol.get("relPath") or ""),
                int(range_data.get("startLine") or 0),
                int(range_data.get("startColumn") or 0),
                name,
            )
        )
    return positions


def python_files() -> list[Path]:
    root = WORKSPACE / "zuzu"
    files = [
        path
        for path in root.rglob("*.py")
        if "/migrations/" not in str(path.relative_to(WORKSPACE)).replace("\\", "/")
    ]
    files.sort()
    return files


def tokenize_counts(
    names: set[str], definition_positions: set[tuple[str, int, int, str]]
) -> tuple[Counter[str], Counter[str], Counter[str], int, int]:
    bare_counts: Counter[str] = Counter()
    member_counts: Counter[str] = Counter()
    total_counts: Counter[str] = Counter()
    files_ok = 0
    files_error = 0
    for path in python_files():
        rel_path = str(path.relative_to(WORKSPACE)).replace("\\", "/")
        try:
            text = path.read_text()
            tokens = tokenize.generate_tokens(io.StringIO(text).readline)
            prev_sig = None
            for tok in tokens:
                if tok.type in {
                    tokenize.ENCODING,
                    tokenize.NL,
                    tokenize.NEWLINE,
                    tokenize.INDENT,
                    tokenize.DEDENT,
                    tokenize.ENDMARKER,
                }:
                    continue
                if tok.type != tokenize.NAME:
                    prev_sig = tok
                    continue
                name = tok.string
                line = tok.start[0] - 1
                col = tok.start[1]
                if name not in names:
                    prev_sig = tok
                    continue
                if (rel_path, line, col, name) in definition_positions:
                    prev_sig = tok
                    continue
                total_counts[name] += 1
                if prev_sig is not None and prev_sig.string == ".":
                    member_counts[name] += 1
                else:
                    bare_counts[name] += 1
                prev_sig = tok
            files_ok += 1
        except Exception:
            files_error += 1
    return bare_counts, member_counts, total_counts, files_ok, files_error


def proxy_count(row: dict, bare_counts: Counter[str], member_counts: Counter[str]) -> int:
    name = str(row.get("name") or "")
    kind = str(row.get("kind") or "").lower()
    if kind in {"method", "constructor", "property", "field"}:
        return member_counts[name]
    return bare_counts[name]


def classify(row: dict, proxy: int) -> str:
    usage = int(row.get("usage") or 0)
    usage_may_value = int(row.get("usage_may") or 0)
    if usage == proxy:
        return "match"
    if usage_may_value < proxy:
        return "may_under"
    if usage < proxy:
        return "likely_under_may_safe"
    return "proxy_over"


def summarize(
    records: list[dict],
    bare_counts: Counter[str],
    member_counts: Counter[str],
    total_counts: Counter[str],
    files_ok: int,
    files_error: int,
    elapsed: float,
) -> None:
    rows = []
    for row in records:
        proxy = proxy_count(row, bare_counts, member_counts)
        rows.append(
            {
                **row,
                "rg_bare": bare_counts[str(row.get("name") or "")],
                "rg_member": member_counts[str(row.get("name") or "")],
                "rg_total": total_counts[str(row.get("name") or "")],
                "rg_proxy": proxy,
                "usage_diff": int(row.get("usage") or 0) - proxy,
                "tag": classify(row, proxy),
            }
        )

    tags = Counter(row["tag"] for row in rows)
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_kind[str(row.get("stratum") or "?")].append(row)

    n = len(rows)
    exact = tags["match"]
    may_under = tags["may_under"]
    likely_under = tags["likely_under_may_safe"]
    over = tags["proxy_over"]

    lines = [
        "# Fast RG Usage Census",
        "",
        f"- Date: {date.today().isoformat()}",
        f"- Workspace: `{WORKSPACE}`",
        f"- Current zoek-rs: `{ZRS}`",
        f"- Census minimum graph usage: {CENSUS_MIN_USAGE}",
        f"- Python files tokenized: {files_ok}",
        f"- Python files failed: {files_error}",
        f"- Census rows: **{n}**",
        f"- Elapsed: {elapsed:.1f}s",
        "",
        "## Proxy Result",
        "",
        f"- Exact likely/proxy match: **{exact}/{n} = {exact / n * 100:.1f}%**",
        f"- MAY undercount risk: **{may_under}/{n} = {may_under / n * 100:.1f}%**",
        f"- Likely below proxy but MAY safe: **{likely_under}/{n} = {likely_under / n * 100:.1f}%**",
        f"- Proxy overcount: **{over}/{n} = {over / n * 100:.1f}%**",
        "",
        "The proxy uses Python NAME tokens, excludes known symbol definition tokens, "
        "uses bare tokens for classes/functions and member tokens for methods/fields.",
        "",
        "## Per Kind",
        "",
        "| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for kind, items in sorted(by_kind.items()):
        item_n = len(items)
        item_tags = Counter(item["tag"] for item in items)
        lines.append(
            f"| {kind} | {item_n} | {item_tags['match'] / item_n * 100:.1f} | "
            f"{item_tags['may_under'] / item_n * 100:.1f} | "
            f"{item_tags['likely_under_may_safe'] / item_n * 100:.1f} | "
            f"{item_tags['proxy_over'] / item_n * 100:.1f} |"
        )

    lines.extend(
        [
            "",
            "## Top MAY Under Risk",
            "",
            "| diff | file:line | name | kind | graph | proxy | bare | member |",
            "|---:|---|---|---|---:|---:|---:|---:|",
        ]
    )
    under_rows = sorted(rows, key=lambda row: row["usage_diff"])
    for row in [row for row in under_rows if row["tag"] == "may_under"][:40]:
        lines.append(
            f"| {row['usage_diff']} | `{row['file']}:{int(row['line']) + 1}` | "
            f"`{row['name']}` | {row['stratum']} | {row['usage']} | {row['rg_proxy']} | "
            f"{row['rg_bare']} | {row['rg_member']} |"
        )

    lines.extend(
        [
            "",
            "## Top Proxy Over",
            "",
            "| diff | file:line | name | kind | graph | proxy | bare | member |",
            "|---:|---|---|---|---:|---:|---:|---:|",
        ]
    )
    over_rows = sorted(rows, key=lambda row: row["usage_diff"], reverse=True)
    for row in [row for row in over_rows if row["usage_diff"] > 0][:40]:
        lines.append(
            f"| +{row['usage_diff']} | `{row['file']}:{int(row['line']) + 1}` | "
            f"`{row['name']}` | {row['stratum']} | {row['usage']} | {row['rg_proxy']} | "
            f"{row['rg_bare']} | {row['rg_member']} |"
        )

    lines.extend(
        [
            "",
            "## Artifacts",
            "",
            f"- Population: `{POPULATION}`",
            f"- Discrepancies: `{DISCREPANCIES}`",
        ]
    )
    SUMMARY.write_text("\n".join(lines) + "\n")
    with DISCREPANCIES.open("w") as out:
        for row in rows:
            if row["tag"] != "match":
                out.write(json.dumps(row) + "\n")


def main() -> None:
    ensure_dirs()
    t0 = time.time()
    symbols = query_all_symbols()
    records = extract_population(symbols)
    names = {str(row.get("name") or "") for row in records}
    definitions = all_definition_positions(symbols, names)
    bare_counts, member_counts, total_counts, files_ok, files_error = tokenize_counts(
        names, definitions
    )
    summarize(
        records,
        bare_counts,
        member_counts,
        total_counts,
        files_ok,
        files_error,
        time.time() - t0,
    )
    print(f"summary: wrote {SUMMARY}", flush=True)
    print(f"summary: wrote {DISCREPANCIES}", flush=True)
    print(f"done elapsed={time.time() - t0:.1f}s rows={len(records)}", flush=True)


if __name__ == "__main__":
    main()
