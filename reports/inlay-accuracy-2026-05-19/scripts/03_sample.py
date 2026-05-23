"""Stratified random sample of 1,500 symbols from population.jsonl.

Stratify by kind: function 300, method 600, class 300, field/attribute 300.
Output: /tmp/inlay_accuracy/sample.jsonl
"""
import json
import random
from collections import defaultdict
from pathlib import Path

random.seed(20260519)

POP = Path("/tmp/inlay_accuracy/population.jsonl")
OUT = Path("/tmp/inlay_accuracy/sample.jsonl")

# Map zoek-rs kinds to coarse strata
KIND_MAP = {
    "function": "function",
    "method": "method",
    "class": "class",
    "constant": "field",       # zoek-rs labels module-level / class-level assignments as 'constant'
    "field": "field",
    "property": "method",
    "constructor": "method",
}

TARGETS = {
    "function": 300,
    "method": 600,
    "class": 300,
    "field": 300,
}

# Collect strata
buckets: dict[str, list[dict]] = defaultdict(list)
total = 0
kept = 0
with POP.open() as f:
    for line in f:
        rec = json.loads(line)
        total += 1
        if rec.get("name") in (None, "", "_", "__"):
            continue
        if rec.get("line") is None or rec.get("col") is None:
            continue
        # Need a position to query LSP. Skip dunder-like / very short names with no value
        kind_raw = (rec.get("kind") or "").lower()
        stratum = KIND_MAP.get(kind_raw)
        if not stratum:
            continue
        # Drop names that aren't valid python identifiers (zoek-rs sometimes emits decorator-like junk)
        name = rec["name"]
        if not (name[0].isalpha() or name[0] == "_"):
            continue
        if not all(c.isalnum() or c == "_" for c in name):
            continue
        # Drop symbols that have BOTH usage=0 and impl=0 — they have no inlay shown,
        # so accuracy of "0" vs "0" is uninteresting.
        if rec.get("usage", 0) == 0 and rec.get("impl", 0) == 0:
            # Keep a SMALL fraction so we can also evaluate false-negative inlays.
            if random.random() > 0.05:
                continue
        buckets[stratum].append(rec)
        kept += 1

print(f"total parsed={total}, kept-eligible={kept}")
for k, v in buckets.items():
    print(f"  {k}: {len(v)} eligible")

# Sample
sample = []
for stratum, target in TARGETS.items():
    pool = buckets.get(stratum, [])
    if len(pool) <= target:
        sample.extend(pool)
        print(f"sample {stratum}: {len(pool)} (took all, target={target})")
    else:
        s = random.sample(pool, target)
        sample.extend(s)
        print(f"sample {stratum}: {len(s)} (from {len(pool)})")

random.shuffle(sample)
with OUT.open("w") as f:
    for rec in sample:
        f.write(json.dumps(rec) + "\n")
print(f"WROTE {len(sample)} to {OUT}")
