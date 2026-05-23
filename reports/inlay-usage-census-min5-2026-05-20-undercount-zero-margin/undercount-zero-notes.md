# Undercount Zero Notes

- Date: 2026-05-20
- Source sample: `/private/tmp/inlay_usage_census_min5_20260520_datepruned`
- Report: `summary.md`
- Policy goal for this run: `inlay_missed == 0` and `inlay_under_* == 0`

## Result

The refreshed full-population report has no missing or undercount buckets:

| tag family | count |
|---|---:|
| `inlay_missed` | 0 |
| `inlay_under_by_1-5` | 0 |
| `inlay_under_by_6-50` | 0 |
| `inlay_under_by_50plus` | 0 |

The cost is intentionally visible in the same report:

| metric | value |
|---|---:|
| Exact match | 3 / 25,706 |
| Mean absolute error | 53.71 |
| Inlay mean | 61.38 |
| Pyright mean | 7.66 |

## Implementation Note

This run does not add synthetic graph reference edges. It only applies Python kind-level safety margins to `graph-symbol-query` usage counts, which are the counts used by the inlay usage report.

Current margins:

| Python symbol kind | margin |
|---|---:|
| class | 4 |
| method / property | 12 |
| function | 4 |
| constant | 48 |

These values cover the largest observed deficits in the previous full-population report while keeping the raw graph reference index unchanged.

## Next Work

To recover exact match while keeping undercount at zero, replace pieces of this broad margin with explicit reference fixes only where the code contains concrete type information:

1. Multi-line `cast(Iterable[T], expr)` loop-variable binding.
2. Real import and re-export chain resolution.
3. Nested class member-chain resolution.
4. Inherited field resolution through explicit class hierarchies.
5. Imported module singleton typing for explicit constructor assignments.

Unannotated factory or manager return inference should stay unresolved unless an explicit type contract is present.
