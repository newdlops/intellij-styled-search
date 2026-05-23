# Undercount Pattern Analysis

- Date: 2026-05-20
- Source report: `summary.md`
- Source discrepancies: `discrepancies.jsonl`
- LSP sample: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Rule for next fixes: use explicit type information only. Avoid name-prefix return inference, duck typing, and project-specific keyword assumptions.

## Totals

| metric | value |
|---|---:|
| Valid LSP sample | 25,706 |
| Exact matches | 4,840 |
| Undercount records | 112 |
| Total missing references across undercounts | 462 |
| `under_by_1-5` | 97 |
| `under_by_6-50` | 12 |
| `missed` | 3 |

## By Kind

| kind | records | missing refs |
|---|---:|---:|
| constant | 71 | 372 |
| method | 20 | 56 |
| function | 11 | 22 |
| class | 10 | 12 |

## Main Patterns

| pattern | evidence | impact |
|---|---|---:|
| Unannotated factory/manager return flow | `Stakeholder.registration_number`: `lsp=163`, `graph=119`; missing uses include variables returned by custom manager/factory methods without explicit return annotations. | 132 missing refs across 3 duplicate field symbols |
| Assignment-call type alias / TypedDict form | `XmlParserCorporateRegistration = TypedDict(...)`: `lsp=50`, `graph=20`; missing refs are imports and annotations to the alias. | 30 |
| Inherited dataclass/base field through subclass or `cls` | `EmploymentCertificateDocument.document_type_name`: report `25` vs `46`; missing refs are mostly base/subclass document flows and `cls.document_type_name`. | 21 |
| Explicit Django reverse/manager fields and multi-line typed casts | `AppUser.two_factor_authentication_set`: `21` vs `6`; `HrmApprovalLine.approver`: `32` vs `20`, with missing `for review in cast(Iterable[HrmApprovalLine], ...)` bindings. | 76 in Django-ish slice |
| Re-exported uppercase constants and enum/text-choice members | Uppercase constants: 27 records, 78 missing refs. Examples: `CORPORATION` through multi-hop `__init__.py` re-exports, `StockTransferAgreementManagement.Status.COMPLETED`, alimtalk/email `Template` enum values. | 78 |
| Imported module singleton alias with explicit constructor assignment | `PipedriveClient.update_user`: `lsp=5`, `graph=0`; calls go through `from .pipedrive_client import client as pipedrive_client`, where `client = PipedriveClient()`. | 5 |
| Remaining long tail | Small misses in methods/functions/constants, usually 1-4 refs each. | about 120 |

## High-Impact Examples

| symbol | current | pyright | notes |
|---|---:|---:|---|
| `Stakeholder.registration_number` | 119 | 163 | Largest undercount. The unsafe fix would be inferring return types from names like `create_director`; avoid that. A valid fix needs explicit return annotations, stubs, or a proven generic manager contract. |
| `XmlParserCorporateRegistration` | 20 | 50 | `TypedDict("Name", {...})` assignment creates a type alias-like symbol; imports and annotations to it are undercounted. This is an explicit Python typing construct, but should be handled as parser support, not project-specific special casing. |
| `EmploymentCertificateDocument.document_type_name` | 25 | 46 | Class/dataclass field inherited from `AbstractDocument`; uses flow through subclasses and `cls.document_type_name`. Needs explicit class hierarchy and field ownership propagation. |
| `CORPORATION` | 61 | 77 | Missing refs are imports/usages through multi-hop package re-exports. This should be handled by resolving actual import/re-export chains, not by fallback name matching. |
| `AppUser.two_factor_authentication_set` | 6 | 21 | Explicit reverse manager field exists under `TYPE_CHECKING`, but several typed context-user flows do not bind through to the field. |
| `HrmApprovalLine.approver` | 20 | 32 | Missing refs are in multi-line `cast(Iterable[HrmApprovalLine], ...)` for-loops; binding the loop variable from the explicit cast should cover this. |
| `StockTransferAgreementManagement.COMPLETED` | 5 | 19 | Nested `TextChoices` constant accessed through `self.Status.COMPLETED` and related class paths. Needs nested class member-chain resolution. |
| `PipedriveClient.update_user` | 0 | 5 | Explicit module variable assignment `client = PipedriveClient()` is imported with an alias and then used as a receiver. |

## Explicit-Only Fix Candidates

1. Multi-line `cast(Iterable[T], expr)` for-loop binding.
   This is explicit and should reduce misses like `HrmApprovalLine.approver` without widening unknown receivers.

2. Actual import/re-export chain resolution for constants and classes.
   Follow real `from .x import Y` and `from package import *` edges already present in files; do not use global name fallback.

3. Nested class member-chain resolution.
   Resolve `self.Status.COMPLETED` and `Class.Nested.MEMBER` through the enclosing class and indexed nested class symbols.

4. Inherited field resolution for explicit class hierarchies.
   Apply to `cls.field` and subclass field refs only when the base class and field are indexed or annotated.

5. Imported module singleton constructor typing.
   Allow receiver typing for imported variables only when the source assignment is an explicit constructor call like `client = PipedriveClient()`.

6. Leave unannotated manager/factory return flows unresolved unless explicit typing exists.
   This keeps the no-duck-typing rule intact for cases like `registration_number`.
