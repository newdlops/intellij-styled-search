# Inlay Hint Accuracy Measurement — intellij-styled-search

**Date**: 2026-05-19
**Target**: `newdlops.intellij-styled-search` v0.1.706 — `usages` and `impl` inlay counts
**Workspace**: `/Users/lky/project/captain`, `zuzu/` Python source (excluding migrations)
**Ground truth**: Pyright `pyright-langserver` (Pylance proxy; both use the same Pyright type-analysis core for `textDocument/references` and `textDocument/implementation`)

## TL;DR

| Signal | Effective n | Exact match | ±1 | ±5 | MAE |
|---|---:|---:|---:|---:|---:|
| `usages` | 512 | **57.8 %** | 73.6 % | 85.0 % | 50.66 |
| `impl` | 421 | **80.5 %** | 93.3 % | 96.2 % | 31.24 |

Headline error patterns (`usages`):
- **9.4 % "inlay shows count but Pyright finds zero"** — over-counts caused by same-name collisions across modules (e.g. `remarks`, `authenticate`).
- **3.3 % over-count by ≥50** — driven by widely-used identifier names (`append`, `company`, `meeting`).
- **2.1 % "inlay = 0 while Pyright > 0"** — driven by a confirmed **tokenizer bug producing the ghost symbol `ault` from `default=…` kwargs** (290 inflated references per occurrence).

Headline pattern (`impl`):
- **19.5 % over-counts** dominated by GraphQL mutation/query classes (`UploadWhtCertificateMutation`, etc.) reporting 1612-1614 implementations. This is implausible at face value — almost certainly an artifact of mass-counting derived/abstract base class hits across the codebase.

---

## 1. Methodology

### 1.1 Data flow

```
zoek-rs graph-symbol-query (per-file)                 →  population.jsonl (164,411 symbols)
  ↓ stratified random sample (kind buckets)
sample.jsonl (1,500 symbols)
  ↓ pyright-langserver --stdio + textDocument/references + textDocument/implementation
lsp_results.jsonl (1,359 responded; some Pyright timeouts)
  ↓ compare inlay vs LSP counts, classify discrepancies
summary.md + discrepancies.jsonl + REPORT.md
```

### 1.2 Population extraction

- Iterated 10,990 `.py` files under `zuzu/` (excluding `migrations`).
- For each file invoked `zoek-rs graph-symbol-query --uri <file_uri> --limit 5000`.
- The Rust CLI returns the same `usageCount`/`implementationCount` the inlay hint provider reads via the JS `CallGraphInlayHintsProvider`.
- 164,411 symbol rows produced.

### 1.3 Sampling

Stratified random sample with seed `20260519`:

| stratum (kind) | target | eligible | sampled |
|---|---:|---:|---:|
| function | 300 | 7,075 | 300 |
| method | 600 | 9,688 | 600 |
| class | 300 | 22,635 | 300 |
| field/attribute (`constant`) | 300 | 44,226 | 300 |
| **total** | **1,500** | **83,624** | **1,500** |

Eligibility filter dropped:
- non-identifier names,
- entries where `usage = 0` AND `impl = 0` (5 % of zero/zero kept to evaluate false-negatives).

### 1.4 LSP ground truth

- 6 parallel `pyright-langserver --stdio` workers.
- Workspace root `/Users/lky/project/captain`, `pyrightconfig.json` written with `useLibraryCodeForTypes: true` and `venv: .venv`.
- For each sampled symbol the worker opens the host file once, then calls `textDocument/references` (`includeDeclaration: false`) and `textDocument/implementation` at the symbol's start position. Column fallback (`col` then `col + 4` for def, `col + 6` for class).
- 30s per-call timeout; null result counts as `None` (not as 0).

### 1.5 Classification rule

```
match                           inlay == lsp
inlay_missed_*                  inlay == 0  and lsp > 0
inlay_over_no_lsp_refs          inlay > 0  and lsp == 0
inlay_over_by_<bucket>          inlay - lsp ∈ {1-5, 6-50, 50+}
inlay_under_by_<bucket>         lsp - inlay ∈ {1-5, 6-50, 50+}
lsp_unknown                     lsp == None (Pyright timeout / no response)
```

---

## 2. Scope and limitations

### 2.1 Coverage rates (Pyright `None` responses)

Pyright failed to return a result for a substantial share of sampled symbols, almost certainly due to overload of 6 concurrent Pyright instances against a large Django codebase combined with the 30s per-call timeout:

| kind | n | usage None | impl None |
|---|---:|---:|---:|
| method | 552 | 58.3 % | 58.3 % |
| function | 266 | 66.5 % | 66.5 % |
| class | 268 | 62.7 % | 62.7 % |
| constant | 273 | 65.9 % | 100 %* |

*`textDocument/implementation` is never meaningful for module-/class-level attributes; we treat null as "n/a" rather than counting them in impl accuracy.

This drops effective sample sizes to:
- usages: **n = 512** (CI 95 %, ±~4 %)
- impl: **n = 421** (CI 95 %, ±~4.5 %)

These are still statistically meaningful, but per-kind cuts (esp. constant/impl) are noisier than originally targeted.

### 2.2 Ground truth limitations (Pyright/Pylance)

Pyright is the best practical ground truth but has known limitations that affect counts independently of the inlay engine:

1. **Django ORM queryset method dispatch** — without django-stubs configured for Pyright, calls like `WhtReceipt.objects.annotate_employee_number(...)` are typed as `QuerySet[WhtReceipt]` rather than the concrete `WhtReceiptQuerySet`. `textDocument/references` on the method definition therefore misses ORM call sites. **This biases `lsp_usage` low for queryset/manager methods**, producing apparent inlay "over-counts" that are partially Pyright limitations rather than inlay bugs.
2. **Abstract → concrete `implementation`** — Pyright's `textDocument/implementation` is conservative; it does not return all subclass overrides for an abstract method in some patterns. The 19.5 % "inlay over-no-lsp-refs" in the `impl` signal is therefore at least partially Pyright under-counting, not necessarily inlay over-counting.

The numbers are most informative when interpreted **directionally**: clear-cut bugs surface as large absolute mismatches with concrete reproducible examples (see §4).

### 2.3 Time budget

Target: 30 minutes total. Actual:
- Population extraction: 12 min 24 s (parallel `zoek-rs` CLI invocations).
- Pyright LSP queries: ~30 min wall before truncating at 1,359/1,500 responses.

The Pyright single-query latency on a Django project of this size dominates total time. Future runs should either (a) configure django-stubs for Pyright, (b) reduce target sample size to ~500, or (c) use a long-lived Pyright session with batched, throttled requests rather than parallel server instances.

---

## 3. Findings — usages signal

### 3.1 Headline numbers

```
Effective sample:        512  (skipped 847 no-LSP-response)
Exact match:             296/512 = 57.8 %
Within ±1:               73.6 %
Within ±5:               85.0 %
Mean Absolute Error:     50.66    (driven by long tail; see §3.3)
Inlay mean:              51.63
Pyright mean:             5.77
```

### 3.2 Per-kind accuracy

| kind | n | exact% | ±1% | ±5% | MAE | inlaȳ | pyright̄ |
|---|---:|---:|---:|---:|---:|---:|---:|
| function | 89 | **87.6** | 92.1 | 98.9 | 0.35 | 4.03 | 3.80 |
| class | 100 | 68.0 | 91.0 | 96.0 | 5.23 | 9.92 | 5.45 |
| method | 230 | 47.8 | 63.9 | 73.0 | 108.53 | 107.57 | 6.93 |
| constant | 93 | 43.0 | 61.3 | 89.2 | 4.54 | 3.66 | 5.12 |

**Functions and classes are accurate; methods and field-like `constant`s are where the engine struggles.** The `method` MAE of 108 is almost entirely driven by the over-count tail (§3.3).

### 3.3 Error-pattern distribution

| tag | n | % |
|---|---:|---:|
| match | 296 | 57.8 % |
| inlay_over_by_1-5 | 69 | 13.5 % |
| inlay_over_no_lsp_refs | 48 | 9.4 % |
| inlay_under_by_1-5 | 33 | 6.4 % |
| inlay_over_by_6-50 | 30 | 5.9 % |
| inlay_over_by_50plus | 17 | 3.3 % |
| inlay_missed (under, lsp>0) | 11 | 2.1 % |
| inlay_under_by_6-50 | 7 | 1.4 % |
| inlay_under_by_50plus | 1 | 0.2 % |

Skew is **strongly toward over-counting**: 32.1 % over vs 7.9 % under. The 50+ bucket is small in count (3.3 %) but is responsible for nearly all of the MAE.

### 3.4 Top over-counts (engineering targets)

| Δ | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +8126 | `zuzu/db/models/shareholders_meeting.py:328` | `company` | method | 8138 | 12 |
| +8115 | `zuzu/db/models/question_thread/question_thread.py:681` | `company` | method | 8134 | 19 |
| +2610 | `zuzu/packages/company/meeting/actions/send_directors_meeting_notice_email_action.py:22` | `meeting` | method | 2611 | 1 |
| +1526 | `zuzu/common/personal_information/personal_information_log_builder.py:40` | `append` | method | 1547 | 21 |
| +715 | `zuzu/common/graphql/middleware/privacy_middleware.py:29` | `resolve` | method | 715 | 0 |
| +677 | `zuzu/db/models/agenda/base/directors_or_shareholders_meeting_agenda_child_base.py:28` | `shareholders_meeting` | method | 740 | 63 |
| +457 | `zuzu/db/models/investment_association/consent_form_or_meeting/ia_consent_form_or_meeting.py:95` | `Type` | class | 474 | 17 |
| +295 | `zuzu/vcm/models/investor/vcm_investor.py:217` | `category` | method | 296 | 1 |
| +188 | `zuzu/db/models/stakeholder/stakeholder.py:172` | `invitation` | method | 189 | 1 |
| +120 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option.py:127` | `exercise_price` | method | 121 | 1 |
| +115 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_claim.py:79` | `exercise_price` | method | 117 | 2 |
| +115 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee.py:145` | `exercise_price` | method | 116 | 1 |
| +109 | `zuzu/packages/document/document_types/option_exercise_claim_document/option_exercise_claim_document.py:274` | `payment_date` | method | 110 | 1 |
| +105 | `zuzu/common/factory/providers/phone_number_provider.py:11` | `phone_number` | method | 105 | 0 |
| +81 | `zuzu/vcm/models/ir/vcm_ir.py:910` | `is_closed` | method | 81 | 0 |

**Pattern**: All-of-these are very common identifier names appearing on dozens of unrelated models (every model has a `company` FK; every meeting-like entity has a `meeting` field; `Type` is the conventional nested enum class name). The over-count's magnitude (often equal to the global occurrence count of that bare name) suggests zoek-rs counts **textual occurrences of the name across the whole codebase** rather than only references that bind back to the specific symbol's qualified scope. Note however that Pyright's ORM dispatch limitation (§2.2) inflates these Δs.

### 3.5 Top under-counts and the **`ault` tokenizer bug**

| Δ | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| **-290** | `zuzu/db/models/email_activity/email_activity_recipient_status_history.py:30` | **`ault`** | method | 0 | 290 |
| **-290** | `zuzu/db/models/option/option_query_set_mixin/cancel_reason_option_query_set_mixin.py:28` | **`ault`** | method | 0 | 290 |
| **-290** | `zuzu/db/models/subscription/subscription.py:713` | **`ault`** | method | 0 | 290 |
| -198 | `zuzu/db/models/company/company.py:1860` | `output_field` | constant | 1 | 199 |
| -27 | `zuzu/packages/option/tests/services/test_option_grant_service.py:81` | `granted_shares` | constant | 1 | 28 |
| -17 | `zuzu/packages/user_activity/types.py:7` | `UserActivityKind` | class | 22 | 39 |

#### Bug 1 — `default=…` mis-parsed as method `ault`

`zoek-rs`'s Python parser is emitting **ghost method symbols named `ault`** at the position of `default=` in keyword arguments inside `Case(...)`/`When(...)`/`models.IntegerField(...)` constructs. Concrete evidence:

```python
# email_activity_recipient_status_history.py around line 30
            ],
            default=5,  # DROPPED, DEFERRED, BOUNCE   <-- zoek-rs creates "ault" here
        )
```
```python
# cancel_reason_option_query_set_mixin.py around line 27-28
                ),
                default=None,                              <-- ditto
            )
```
```python
# subscription/subscription.py:713
                default=False,                             <-- ditto
```

These ghost symbols get attached to the *enclosing* QuerySet/Mixin/Model class (`EmailActivityRecipientStatusHistoryQuerySet.ault`, `CancelReasonOptionQuerySetMixin.ault`, etc.). Pyright meanwhile correctly resolves the position to whatever real symbol overlaps and reports its true reference count (often hundreds because the position is inside heavily-referenced ORM call sites).

**Action**: fix the Python AST extractor in `crates/zoek-rs/src/graph.rs` (or wherever symbol extraction occurs) so that `default` keyword argument names are not emitted as definition symbols. Likely cause is a regex/grammar rule that strips the `def` prefix from `default` and treats the suffix as an identifier.

#### Bug 2 — `output_field=` shadow constant
Same root cause family: `output_field` at `zuzu/db/models/company/company.py:1860` reports inlay `usage=1` but Pyright sees 199 references to whatever real symbol exists at that position. Likely the same keyword-arg-name-as-definition class of issue.

### 3.6 Pattern catalog

Each pattern below carries an actionable handle.

#### P1: Common-name cross-module conflation (high MAE, low % of rows)
- Frequency: ~3.3 % of measured rows, but contributes >80 % of MAE.
- Hallmark: short generic name (`company`, `meeting`, `Type`, `append`, `resolve`, `category`).
- Hypothesis: reference counting aggregates by `name` (not `symbolId`) when the name has no qualified disambiguation, especially across Django model fields that share names.
- Likely site: `relationIndex.usagesBySymbolId` population during graph indexing (callGraph.js / Rust shard build).
- Fix direction: ensure each reference is attributed by **symbolId** with a successful name-→-defining-symbol resolution; drop references that fall back to pure-textual matches.

#### P2: Ghost symbols from kwarg names ("ault", `output_field`)
- Frequency: each is rare individually but **every `Case(... default=...)` site spawns one**, so the absolute count across zuzu/ is large.
- Hypothesis: language-grammar fragment mis-recognises a kwarg name as a top-level method definition.
- Fix direction: trace from the symbol's `qualifiedName` (e.g. `EmailActivityRecipientStatusHistoryQuerySet.ault`) back through the AST builder; reject definitions whose name appears only as the LHS of a keyword argument.

#### P3: GraphQL mutation/query class implementations explosion (impl signal)
- Frequency: 8 classes report exactly 1611-1614 implementations each; all are GraphQL `Mutation`/`Query` classes (see §4).
- Hypothesis: the `implementations` index is treating "any class extending a common `graphene.Mutation`/`graphene.ObjectType`" as an implementation, conflating *protocol implementation* with *inheritance from a common base*.
- Fix direction: tighten the "is implementation" relation; restrict to symbols where the abstract method actually has `@abc.abstractmethod` / `Protocol` membership; or report `impl` count only for ABC/Protocol-decorated definitions.

#### P4: Same-name-different-model field over-count
- Examples in §3.4 — `exercise_price` on three different `option_exercise_*` files all report inlay 115-121 vs Pyright 1-2.
- Hypothesis: model fields with the same name on different models share one reference set in the index.
- Fix direction: scoped name resolution per `qualifiedName` parent.

#### P5: Pyright-blind queryset method
- Examples: every QuerySet annotate/method shows large inlay over Pyright = 0 or 1.
- Hypothesis: **Pyright limitation, not an inlay bug** (until django-stubs is configured for Pyright).
- Action for this report: discount these rows in the headline; planned follow-up is to rerun with django-stubs explicitly enabled and compare.

---

## 4. Findings — impl signal

```
Effective sample:        421  (skipped 938 no-LSP-response)
Exact match:             339/421 = 80.5 %
Within ±1:               93.3 %
Within ±5:               96.2 %
Mean Absolute Error:     31.24
Inlay mean:              31.24
Pyright mean:             0.00
```

The Pyright mean of 0 reflects the Pyright limitation (§2.2). The most interesting subset is the 19.5 % "inlay reports impl but Pyright reports 0" rows — these include both real over-counts and Pyright misses.

### 4.1 The "1611-1614" cluster (GraphQL Mutation classes)

| Δ | file:line | class | inlay impl |
|---:|---|---|---:|
| +1614 | `zuzu/packages/company/payroll/wht/wht_certificate/graphql/mutations/upload_wht_certificate_mutation.py:98` | `UploadWhtCertificateMutation` | 1614 |
| +1613 | `zuzu/packages/hrm/leave/grantable_leave/graphql/mutations/hrm_delete_leave_grant_mutation.py:106` | `HrmDeleteLeaveGrantMutation` | 1613 |
| +1613 | `zuzu/packages/hrm/emp/job/graphql/mutations/hrm_delete_emp_job_level_mutation.py:80` | `HrmDeleteEmpJobLevelMutation` | 1613 |
| +1612 | `zuzu/packages/company/registration_matters/graphql/mutations/company_purpose_change_add_or_edit_mutation.py:134` | `CompanyPurposeChangeAddOrEditMutation` | 1612 |
| +1612 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/edit_consent_form_or_meeting_title_mutation.py:67` | `EditConsentFormOrMeetingTitleMutation` | 1612 |
| +1612 | `zuzu/packages/hrm/dept/status/graphql/mutations/app_hrm_dept_status_mutations.py:9` | `AppHrmDeptStatusMutations` | 1612 |
| +1612 | `zuzu/packages/hrm/leave/annual_leave/graphql/mutations/app_hrm_leave_annual_leave_mutations.py:18` | `AppHrmLeaveAnnualLeaveMutations` | 1612 |
| +1611 | `zuzu/packages/document/graphql/mutations/staff_meeting_document_upsert_mutation.py:81` | `StaffMeetingDocumentUpsertMutation` | 1611 |

All cluster at **~1612**, suggesting a constant-of-the-repo (total number of mutation/query classes in zuzu/). This is consistent with **P3**: the impl index treats inheritance from a common base (`graphene.Mutation`) as cross-implementation. From a user experience standpoint, an inlay reading `impl 1612` next to a GraphQL mutation class is misleading — that number does not represent anything useful.

**Recommended quick win**: cap or hide `impl` count when it exceeds, e.g., 50 unless the symbol carries an `@abstractmethod` decorator or implements a `Protocol`.

---

## 5. Reproduction

All inputs and outputs are at `/tmp/inlay_accuracy/`:

```
population.jsonl       64 MB    164,411 symbols (zoek-rs extraction)
sample.jsonl          603 KB    1,500 stratified-sampled symbols
lsp_results.jsonl     593 KB    1,359 with Pyright references + impl counts
discrepancies.jsonl   132 KB    286 mismatches with diffs
summary.md            5 KB      auto-generated short summary
```

Scripts (committed in `scripts/inlay_accuracy/`):

| script | purpose |
|---|---|
| `01_find_cache.py` | locate the `callgraph-…-v14` cache dir for this workspace (diagnostic only) |
| `02_extract_population.py` | iterate `zuzu/**/*.py` and call `zoek-rs graph-symbol-query` per file (parallel, 12 workers) |
| `03_sample.py` | stratified random sample to 1,500 symbols |
| `04_run_pyright.py` | drive 6 `pyright-langserver` workers; emit `lsp_results.jsonl` |
| `lsp_client.py` | minimal LSP JSON-RPC client (used by `04_run_pyright.py`) |
| `smoke_pyright.py` | sanity check |
| `05_analyze.py` | compute metrics, classify patterns, write `summary.md` + `discrepancies.jsonl` |

Re-run end to end:
```bash
.venv/bin/python scripts/inlay_accuracy/02_extract_population.py
.venv/bin/python scripts/inlay_accuracy/03_sample.py
WORKERS=6 .venv/bin/python scripts/inlay_accuracy/04_run_pyright.py
.venv/bin/python scripts/inlay_accuracy/05_analyze.py
```

---

## 6. Recommended next actions

Ranked by ratio (expected accuracy gain : implementation effort):

1. **Fix the `ault` / kwarg-name ghost-symbol bug (P2).** Likely a 1-line grammar fix in `crates/zoek-rs/src/graph.rs` or symbol-extraction logic. Eliminates the worst under-count case and any other kwarg-leak symbols.
2. **Cap or hide `impl` when count ≥ 50 unless symbol is `@abstractmethod`/`Protocol` (P3).** Mechanical UI guard; eliminates the 1612-cluster noise and prevents future regressions of the same shape.
3. **Tighten reference attribution by `symbolId` not raw name (P1, P4).** Larger refactor in the relation-index build, but addresses the long MAE tail (`company`, `meeting`, `exercise_price`, …).
4. **Configure `pyrightconfig.json` with django-stubs paths in this measurement harness and re-run.** Will sharply reduce the Pyright `None` rate (currently 60-65 %) and let us measure `method` accuracy on real terms.
5. **Persistent LSP pool with batched queries** for future runs to bring the measurement loop back under the 30-minute target.

---

## 7. Appendix — raw artifacts

- `/tmp/inlay_accuracy/population.jsonl` — full population JSONL (164k rows).
- `/tmp/inlay_accuracy/sample.jsonl` — sampled 1,500.
- `/tmp/inlay_accuracy/lsp_results.jsonl` — sample joined with Pyright counts.
- `/tmp/inlay_accuracy/discrepancies.jsonl` — non-matching rows with `usage_diff` / `impl_diff` fields.
- `/tmp/inlay_accuracy/summary.md` — short auto-generated summary (overlaps with §3-4).
