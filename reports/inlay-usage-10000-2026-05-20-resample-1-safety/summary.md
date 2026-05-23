# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 14
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=8000, missing=0, errors=0
- Graph usage changed from cached baseline: 8000/10000

## Usage Signal

- Exact match: **1841/10000 = 18.4%**
- Within +/-1: 19.4%
- Within +/-5: 64.2%
- Mean absolute error: 14.26
- Inlay mean: 17.79
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 0.1 | 0.1 | 48.8 | 19.94 | 22.70 | 2.77 |
| class | 2000 | 0.1 | 0.1 | 95.9 | 3.87 | 9.96 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.84 | 4.55 | 3.71 |
| constant | 2000 | 0.1 | 0.2 | 29.6 | 26.70 | 29.01 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_1-5 | 3613 | 36.1% |
| inlay_over_no_lsp_refs | 2467 | 24.7% |
| match | 1841 | 18.4% |
| inlay_over_by_6-50 | 1611 | 16.1% |
| inlay_over_by_50plus | 468 | 4.7% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4872 | `zuzu/common/factory/base.py:73` | `create` | method | 4872 | 0 |
| +4062 | `zuzu/packages/company/payroll/ai_payroll_ledger/graphql/mutations/staff_create_payroll_ledger_ai_analysis_mutation.py:49` | `model_name` | constant | 4062 | 0 |
| +1853 | `zuzu/common/logging.py:16` | `filter` | method | 1853 | 0 |
| +996 | `zuzu/cms/admin/portal_academy_guide/portal_academy_guide.py:14` | `model` | constant | 996 | 0 |
| +573 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 575 | 2 |
| +522 | `zuzu/packages/question_thread/types/question_thread_message_reviewer_type.py:26` | `full_name` | method | 522 | 0 |
| +515 | `zuzu/packages/user/types/visit_user_type.py:14` | `full_name` | constant | 515 | 0 |
| +514 | `zuzu/packages/unlisted_stock_management/graphql/types.py:55` | `full_name` | constant | 514 | 0 |
| +478 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 487 | 9 |
| +434 | `zuzu/packages/company/capital/capital_service.py:86` | `date` | method | 434 | 0 |
| +414 | `zuzu/db/models/meeting_document/shareholders_meeting_audit_report_document.py:65` | `date` | method | 417 | 3 |
| +413 | `zuzu/db/models/meeting_document/shareholders_written_resolution_document.py:67` | `date` | method | 415 | 2 |
| +413 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_document.py:63` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:79` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:84` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:74` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_individual_document.py:85` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/shareholders_meeting_minutes_document.py:96` | `date` | method | 413 | 0 |
| +399 | `zuzu/app/graphql/types/co_ceo_system_change_input.py:5` | `date` | constant | 400 | 1 |
| +397 | `zuzu/packages/with_shareholder_role/payroll/graphql/queries/portal_cash_compensations_query.py:27` | `count` | constant | 397 | 0 |
| +397 | `zuzu/packages/option/graphql/mutations/option_pause_mutation.py:39` | `date` | constant | 397 | 0 |
| +396 | `zuzu/packages/investment_association/document/services/ia_partner_certificate_of_investment_document_service.py:96` | `date` | constant | 399 | 3 |
| +396 | `zuzu/packages/stock_unissued_confirmation_request/types.py:20` | `date` | constant | 396 | 0 |
| +395 | `zuzu/common/factory/company/company_option_rule_factory.py:31` | `date` | constant | 395 | 0 |
| +395 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:76` | `date` | constant | 395 | 0 |
| +395 | `zuzu/packages/document/graphql/types.py:614` | `date` | constant | 395 | 0 |
| +395 | `zuzu/packages/with_shareholder_role/shareholder/types.py:52` | `date` | constant | 395 | 0 |
| +395 | `zuzu/packages/with_shareholder_role/employee_stock/types.py:97` | `date` | constant | 395 | 0 |
| +395 | `zuzu/packages/phantom_stock/graphql/types/types.py:161` | `date` | constant | 395 | 0 |
| +395 | `zuzu/app/graphql/types/company_type.py:232` | `date` | constant | 395 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-safety/discrepancies.jsonl`
