# Notes

- Date: 2026-05-20
- Goal: keep `inlay_missed == 0` and `inlay_under_* == 0` while reducing overcount sources.

## Change Under Test

Python bare identifiers now resolve only through explicit imports or same-file symbols. They no longer fall back to arbitrary same-name symbols across the workspace. Python member access and dynamic string fallback remain enabled.

This is a general language rule: a bare Python name is lexical/import scoped, not a global workspace-wide symbol lookup.

## Result

The full census still has no missing or undercount buckets after raising the temporary safety floor:

| tag family | count |
|---|---:|
| `inlay_missed` | 0 |
| `inlay_under_*` | 0 |

The temporary floor is intentionally too broad:

| metric | value |
|---|---:|
| Exact match | 1 / 25,706 |
| Mean absolute error | 128.14 |
| Inlay mean | 135.81 |
| Pyright mean | 7.66 |

## Important Finding

When the bare-name fallback is removed without raising the floor, the report shows 252 undercount records. Most are classes that were previously counted through broad same-name fallback. That means the next exact-match work should not re-enable global bare-name fallback. Instead, it should replace those missing counts with explicit import and re-export resolution.

Top uncovered missing patterns from the intermediate report:

1. Imported/re-exported Python classes used through package exports.
2. Factory and Django model classes referenced through explicit imports that are not resolved to the originating definition.
3. A small set of uppercase constants that rely on re-export or alias paths.
4. Decorator functions referenced through explicit module/package imports.

## Next Step

Implement real import/re-export graph resolution for Python package exports and aliases, then lower the class/function/constant safety margins while re-running the full census after each reduction.
