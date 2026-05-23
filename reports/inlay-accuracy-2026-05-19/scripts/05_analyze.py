"""Compare inlay counts vs LSP counts and classify error patterns.

Reads:  /tmp/inlay_accuracy/lsp_results.jsonl
Writes: /tmp/inlay_accuracy/summary.md
        /tmp/inlay_accuracy/discrepancies.jsonl
"""
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

RESULTS = Path("/tmp/inlay_accuracy/lsp_results.jsonl")
SUMMARY = Path("/tmp/inlay_accuracy/summary.md")
DISCREP = Path("/tmp/inlay_accuracy/discrepancies.jsonl")


def classify(rec: dict, signal: str) -> str:
    """Return a coarse error pattern tag for one (rec, signal) pair."""
    inlay = rec.get("usage" if signal == "usage" else "impl", 0)
    lsp = rec.get(f"lsp_{signal}")
    if lsp is None:
        return "lsp_unknown"
    if inlay == lsp:
        return "match"
    diff = inlay - lsp
    name = rec.get("name") or ""
    kind = (rec.get("kind") or "").lower()

    if inlay == 0 and lsp > 0:
        if name.endswith("_set"):
            return "inlay_missed_reverse_accessor"
        if name.startswith("_") and not name.startswith("__"):
            return "inlay_missed_private"
        return "inlay_missed"
    if inlay > 0 and lsp == 0:
        if name in ("self", "cls", "kwargs", "args"):
            return "inlay_over_dunder_like"
        return "inlay_over_no_lsp_refs"
    if diff > 0:
        return f"inlay_over_by_{'1-5' if diff <= 5 else '6-50' if diff <= 50 else '50plus'}"
    return f"inlay_under_by_{'1-5' if -diff <= 5 else '6-50' if -diff <= 50 else '50plus'}"


def main():
    records: list[dict] = []
    with RESULTS.open() as f:
        for line in f:
            records.append(json.loads(line))

    if not records:
        print("No records in lsp_results.jsonl")
        return

    out_lines = []
    out_lines.append("# Inlay Accuracy Measurement")
    out_lines.append("")
    out_lines.append(f"- Sample size: **{len(records)}**")
    out_lines.append(
        f"- Ground truth: Pyright (`pyright-langserver` via LSP) — Pylance proxy"
    )
    out_lines.append(
        f"- Scope: `zuzu/` Python files, excluding migrations"
    )
    out_lines.append("")

    for signal in ("usage", "impl"):
        out_lines.append(f"## Signal: `{signal}`")
        out_lines.append("")
        # Filter records where LSP returned a result
        valid = [
            r for r in records if r.get(f"lsp_{signal}") is not None
        ]
        miss_lsp = len(records) - len(valid)
        if not valid:
            out_lines.append(f"_No LSP results available ({miss_lsp} skipped)._")
            out_lines.append("")
            continue

        # Match / mismatch counts
        match = sum(1 for r in valid if r.get(signal, 0) == r[f"lsp_{signal}"])
        total = len(valid)
        diffs = [r.get(signal, 0) - r[f"lsp_{signal}"] for r in valid]
        abs_diffs = [abs(d) for d in diffs]
        mae = statistics.mean(abs_diffs) if abs_diffs else 0
        mean_inlay = statistics.mean(r.get(signal, 0) for r in valid)
        mean_lsp = statistics.mean(r[f"lsp_{signal}"] for r in valid)
        within1 = sum(1 for d in abs_diffs if d <= 1)
        within5 = sum(1 for d in abs_diffs if d <= 5)

        out_lines.append(f"- Effective sample: {total} (skipped {miss_lsp} no-LSP-resp)")
        out_lines.append(f"- Exact match: **{match}/{total} = {match/total*100:.1f}%**")
        out_lines.append(f"- Within ±1: {within1/total*100:.1f}%")
        out_lines.append(f"- Within ±5: {within5/total*100:.1f}%")
        out_lines.append(f"- Mean Absolute Error: {mae:.2f}")
        out_lines.append(f"- Inlay mean: {mean_inlay:.2f}  |  Pyright mean: {mean_lsp:.2f}")
        out_lines.append("")

        # Per-kind breakdown
        by_kind: dict[str, list[dict]] = defaultdict(list)
        for r in valid:
            by_kind[(r.get("kind") or "?")].append(r)
        out_lines.append("### Per-kind accuracy")
        out_lines.append("")
        out_lines.append("| kind | n | exact% | ±1% | ±5% | MAE | inlaȳ | pyright̄ |")
        out_lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
        for kind, lst in sorted(by_kind.items(), key=lambda x: -len(x[1])):
            n = len(lst)
            m = sum(1 for r in lst if r.get(signal, 0) == r[f"lsp_{signal}"])
            ds = [r.get(signal, 0) - r[f"lsp_{signal}"] for r in lst]
            mae_k = statistics.mean(abs(d) for d in ds) if ds else 0
            w1 = sum(1 for d in ds if abs(d) <= 1)
            w5 = sum(1 for d in ds if abs(d) <= 5)
            mi = statistics.mean(r.get(signal, 0) for r in lst)
            ml = statistics.mean(r[f"lsp_{signal}"] for r in lst)
            out_lines.append(
                f"| {kind} | {n} | {m/n*100:.1f} | {w1/n*100:.1f} | {w5/n*100:.1f} | {mae_k:.2f} | {mi:.2f} | {ml:.2f} |"
            )
        out_lines.append("")

        # Pattern classification
        tags = Counter(classify(r, signal) for r in valid)
        out_lines.append("### Error pattern distribution")
        out_lines.append("")
        out_lines.append("| tag | n | % |")
        out_lines.append("|---|---:|---:|")
        for tag, n in tags.most_common():
            out_lines.append(f"| {tag} | {n} | {n/total*100:.1f}% |")
        out_lines.append("")

        # Sample examples per non-match tag
        out_lines.append("### Sample discrepancies")
        out_lines.append("")
        examples_per_tag = defaultdict(list)
        for r in valid:
            t = classify(r, signal)
            if t == "match":
                continue
            if len(examples_per_tag[t]) < 3:
                examples_per_tag[t].append(r)
        for tag, exs in examples_per_tag.items():
            out_lines.append(f"**{tag}**")
            out_lines.append("")
            for r in exs:
                out_lines.append(
                    f"- `{r['file']}:{r['line']+1}` `{r['name']}` "
                    f"({r.get('kind')}) — inlay {signal}={r.get(signal,0)}, "
                    f"pyright={r[f'lsp_{signal}']}"
                )
            out_lines.append("")

    # Persist discrepancies (non-matches) for usage signal
    with DISCREP.open("w") as f:
        for r in records:
            ul = r.get("lsp_usage")
            il = r.get("lsp_impl")
            u_diff = (
                (r.get("usage", 0) - ul) if ul is not None else None
            )
            i_diff = (
                (r.get("impl", 0) - il) if il is not None else None
            )
            if (u_diff and u_diff != 0) or (i_diff and i_diff != 0):
                f.write(
                    json.dumps(
                        {
                            **r,
                            "usage_diff": u_diff,
                            "impl_diff": i_diff,
                        }
                    )
                    + "\n"
                )

    SUMMARY.write_text("\n".join(out_lines))
    print(f"WROTE {SUMMARY}")
    print(f"WROTE {DISCREP}")


if __name__ == "__main__":
    main()
