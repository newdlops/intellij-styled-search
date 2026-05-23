# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/Users/lky/project/captain/.venv/bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 14
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=1, missing=0, errors=0
- Graph usage changed from cached baseline: 8001/10000

## Usage Signal

- Exact match: **6089/10000 = 60.9%**
- Within +/-1: 71.0%
- Within +/-5: 82.6%
- Mean absolute error: 9.09
- Inlay mean: 12.62
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 59.2 | 68.8 | 84.0 | 9.86 | 12.62 | 2.77 |
| class | 2000 | 75.8 | 92.6 | 98.0 | 0.87 | 6.96 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.84 | 4.56 | 3.71 |
| constant | 2000 | 18.4 | 28.5 | 49.0 | 24.00 | 26.31 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 6089 | 60.9% |
| inlay_over_no_lsp_refs | 1670 | 16.7% |
| inlay_over_by_1-5 | 1269 | 12.7% |
| inlay_over_by_6-50 | 737 | 7.4% |
| inlay_over_by_50plus | 235 | 2.4% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4870 | `zuzu/common/factory/base.py:73` | `create` | method | 4870 | 0 |
| +4058 | `zuzu/packages/company/payroll/ai_payroll_ledger/graphql/mutations/staff_create_payroll_ledger_ai_analysis_mutation.py:49` | `model_name` | constant | 4058 | 0 |
| +1849 | `zuzu/common/logging.py:16` | `filter` | method | 1849 | 0 |
| +992 | `zuzu/cms/admin/portal_academy_guide/portal_academy_guide.py:14` | `model` | constant | 992 | 0 |
| +569 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 571 | 2 |
| +513 | `zuzu/packages/question_thread/types/question_thread_message_reviewer_type.py:26` | `full_name` | method | 513 | 0 |
| +511 | `zuzu/packages/user/types/visit_user_type.py:14` | `full_name` | constant | 511 | 0 |
| +510 | `zuzu/packages/unlisted_stock_management/graphql/types.py:55` | `full_name` | constant | 510 | 0 |
| +476 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 485 | 9 |
| +434 | `zuzu/packages/company/capital/capital_service.py:86` | `date` | method | 434 | 0 |
| +414 | `zuzu/db/models/meeting_document/shareholders_meeting_audit_report_document.py:65` | `date` | method | 417 | 3 |
| +413 | `zuzu/db/models/meeting_document/shareholders_written_resolution_document.py:67` | `date` | method | 415 | 2 |
| +413 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_document.py:63` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:79` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:84` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:74` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_individual_document.py:85` | `date` | method | 413 | 0 |
| +413 | `zuzu/db/models/meeting_document/shareholders_meeting_minutes_document.py:96` | `date` | method | 413 | 0 |
| +404 | `zuzu/app/graphql/types/co_ceo_system_change_input.py:5` | `date` | constant | 405 | 1 |
| +402 | `zuzu/packages/option/graphql/mutations/option_pause_mutation.py:39` | `date` | constant | 402 | 0 |
| +401 | `zuzu/packages/investment_association/document/services/ia_partner_certificate_of_investment_document_service.py:96` | `date` | constant | 404 | 3 |
| +401 | `zuzu/packages/stock_unissued_confirmation_request/types.py:20` | `date` | constant | 401 | 0 |
| +401 | `zuzu/packages/document/options/predefined_options.py:123` | `date` | function | 405 | 4 |
| +400 | `zuzu/common/factory/company/company_option_rule_factory.py:31` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:76` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/document/graphql/types.py:614` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/with_shareholder_role/shareholder/types.py:52` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/with_shareholder_role/employee_stock/types.py:97` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/phantom_stock/graphql/types/types.py:161` | `date` | constant | 400 | 0 |
| +400 | `zuzu/app/graphql/types/company_type.py:232` | `date` | constant | 400 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-undercount0/discrepancies.jsonl`
