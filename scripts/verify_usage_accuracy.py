#!/usr/bin/env python3
"""Multi-language usage-count accuracy verification for the zoek-rs call graph.

The ground truth is an INDEPENDENT textual identifier-frequency count of the
source (NOT the engine's own index — don't grade the engine with itself). It is
equivalent to `rg -o '\\b<ident>\\b' | sort | uniq -c` per language; we tokenize
in Python so the script has no ripgrep dependency.

For every first-party symbol we compare the graph's per-symbol usage count
(`usageLikely`, the number the inline "N usages" hint shows) against the textual
occurrence count of the symbol name in that symbol's language:

  [A] OVERCOUNT  usageLikely > textual  -> logically impossible -> engine bug.
                 Language-agnostic and false-positive-resistant (the only FP is
                 the textual count missing the name, which we minimise by
                 counting every extension of the language).

  [B] RECALL     restricted to UNAMBIGUOUS symbols so a low count is a real gap,
                 not expected ambiguity: exactly one definition of the name in
                 the corpus, a BARE-resolvable kind (class/function/interface/
                 enum/type — not member-accessed method/field), textual >= 6, and
                 usage_may ~= textual (may >> textual means the name collides with
                 a ubiquitous member like `.all()`, so it is skipped). For these,
                 real-usages ~= textual - 1, so usageLikely far below that is a
                 genuine recall gap.

Inputs:
  1. dump.tsv from:  zoek-rs graph-audit-counts <ws> --dump-first-party dump.tsv
     (columns: relPath, name, kind, usageLikely, usageMust, usageMay, emitted)
  2. the workspace root (read to build the textual ground truth)

Usage:  verify_usage_accuracy.py <workspace_root> <dump.tsv>

Regression gates that must stay green after any resolver/count change:
  - overcount count stays ~0 (per language)
  - recall% does not drop
"""
import collections
import keyword
import os
import re
import sys

if len(sys.argv) != 3:
    sys.exit(__doc__)
WS, DUMP = sys.argv[1], sys.argv[2]

# Paths that are vendored / bundled / generated even though they sit under a
# first-party directory — their symbols and tokens are not user code.
BUNDLED_SUBSTR = (
    "/public/", "/pdfjs/", "/webviewer/", ".min.js", ".bundle.js", "/dist/",
    "/build/", "/__generated__/", ".generated.", "/vendor/", "/migrations/",
)
def is_bundled(rel):
    return any(s in rel for s in BUNDLED_SUBSTR)

LANGS = {
    "python":     ["py", "pyi"],
    "typescript": ["ts", "tsx"],
    "javascript": ["js", "jsx", "mjs", "cjs"],
    "java":       ["java"],
}
EXT2LANG = {e: lang for lang, exts in LANGS.items() for e in exts}

# Names that are keywords / ubiquitous builtins: rg/textual counts them but they
# are never meaningful user symbols to verify.
_TS_KW = {
    "function", "return", "const", "let", "var", "class", "interface", "type",
    "enum", "import", "export", "default", "extends", "implements", "public",
    "private", "protected", "static", "readonly", "new", "this", "super", "void",
    "null", "undefined", "true", "false", "if", "else", "for", "while", "switch",
    "case", "break", "continue", "async", "await", "yield", "typeof",
    "instanceof", "in", "of", "as", "from", "get", "set",
}
KEYWORDS = {
    "python": set(keyword.kwlist) | {"self", "cls", "True", "False", "None"},
    "typescript": _TS_KW,
    "javascript": _TS_KW,
    "java": {
        "public", "private", "protected", "static", "final", "class", "interface",
        "enum", "void", "return", "new", "this", "super", "extends", "implements",
        "import", "package", "if", "else", "for", "while", "switch", "case",
        "break", "continue", "true", "false", "null", "int", "long", "double",
        "float", "boolean", "char", "byte", "short", "String", "abstract",
    },
}
BARE_KINDS = {"class", "function", "interface", "enum", "type", "struct"}

TOKEN = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
PRUNE_DIRS = {
    ".venv", "node_modules", ".git", ".zoek-rs", "dist", "build",
    "__generated__", "migrations", "webviewer", "pdfjs", "public",
}
_FREQ_CACHE = {}
def textual_freq(exts):
    """name -> textual occurrence count across first-party files of these exts."""
    key = tuple(sorted(exts))
    if key in _FREQ_CACHE:
        return _FREQ_CACHE[key]
    wanted = {"." + e for e in exts}
    freq = collections.Counter()
    for root, dirs, files in os.walk(WS):
        dirs[:] = [d for d in dirs if d not in PRUNE_DIRS]
        for fn in files:
            if os.path.splitext(fn)[1] not in wanted:
                continue
            if fn.endswith((".min.js", ".bundle.js", ".generated.ts")):
                continue
            try:
                with open(os.path.join(root, fn), encoding="utf-8", errors="ignore") as fh:
                    for tok in TOKEN.findall(fh.read()):
                        freq[tok] += 1
            except OSError:
                pass
    _FREQ_CACHE[key] = freq
    return freq


def load_dump():
    by_lang = collections.defaultdict(list)
    with open(DUMP) as fh:
        next(fh)  # header
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) != 7:
                continue
            rel, name, kind, ul, must, may, em = f
            if is_bundled(rel):
                continue
            lang = EXT2LANG.get(os.path.splitext(rel)[1].lstrip("."))
            if not lang:
                continue
            by_lang[lang].append((rel, name, kind, int(ul), int(must), int(may), int(em)))
    return by_lang


def main():
    by_lang = load_dump()
    print(f"{'LANG':12} {'symbols':>9} {'overcount':>10} {'over%':>7} | "
          f"{'clean':>7} {'silent0':>8} {'under':>7} {'OK':>7} {'recall%':>8}")
    print("-" * 92)
    detail = {}
    for lang in ("python", "typescript", "javascript", "java"):
        syms = by_lang.get(lang, [])
        if not syms:
            continue
        freq = textual_freq(LANGS[lang])
        kw = KEYWORDS.get(lang, set())
        defs = collections.Counter(s[1] for s in syms)
        syms = [s for s in syms if s[1] not in kw]
        over = [s for s in syms if s[3] > freq.get(s[1], 0)]
        clean = [s for s in syms
                 if defs[s[1]] == 1 and s[2] in BARE_KINDS
                 and freq.get(s[1], 0) >= 6 and s[5] <= 2 * max(freq.get(s[1], 0), 1)]
        silent = [s for s in clean if s[3] == 0]
        under = [s for s in clean if 0 < s[3] < 0.5 * (freq[s[1]] - 1)]
        ok = len(clean) - len(silent) - len(under)
        detail[lang] = (over, silent, freq)
        print(f"{lang:12} {len(syms):9} {len(over):10} "
              f"{100 * len(over) / max(len(syms), 1):6.2f}% | {len(clean):7} {len(silent):8} "
              f"{len(under):7} {ok:7} {100 * ok / max(len(clean), 1):7.1f}%")

    for lang, (over, silent, freq) in detail.items():
        if over:
            print(f"\n[{lang}] OVERCOUNT offenders (usageLikely > textual):")
            for s in sorted(over, key=lambda s: s[3] - freq.get(s[1], 0), reverse=True)[:10]:
                print(f"    {s[1]:28} ({s[2]:9}) likely={s[3]:5} textual={freq.get(s[1], 0):5}  {s[0]}")
        if silent:
            print(f"\n[{lang}] worst clean-recall SILENT-ZEROS (unique bare name, may~=textual, likely=0):")
            for s in sorted(silent, key=lambda s: freq[s[1]], reverse=True)[:12]:
                print(f"    {s[1]:28} ({s[2]:9}) textual={freq[s[1]]:5} may={s[5]:5}  {s[0]}")


if __name__ == "__main__":
    main()
