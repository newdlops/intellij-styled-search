# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 14
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=1291, missing=0, errors=0
- Graph usage changed from cached baseline: 8000/10000

## Usage Signal

- Exact match: **5239/10000 = 52.4%**
- Within +/-1: 64.0%
- Within +/-5: 78.9%
- Mean absolute error: 11.31
- Inlay mean: 14.84
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 42.1 | 52.8 | 73.7 | 15.96 | 18.73 | 2.77 |
| class | 2000 | 73.7 | 89.8 | 98.0 | 0.95 | 7.05 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.84 | 4.55 | 3.71 |
| constant | 2000 | 12.2 | 28.6 | 50.9 | 22.84 | 25.15 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 5239 | 52.4% |
| inlay_over_no_lsp_refs | 1953 | 19.5% |
| inlay_over_by_1-5 | 1635 | 16.4% |
| inlay_over_by_6-50 | 746 | 7.5% |
| inlay_over_by_50plus | 427 | 4.3% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4870 | `zuzu/common/factory/base.py:73` | `create` | method | 4870 | 0 |
| +4058 | `zuzu/packages/company/payroll/ai_payroll_ledger/graphql/mutations/staff_create_payroll_ledger_ai_analysis_mutation.py:49` | `model_name` | constant | 4058 | 0 |
| +1851 | `zuzu/common/logging.py:16` | `filter` | method | 1851 | 0 |
| +992 | `zuzu/cms/admin/portal_academy_guide/portal_academy_guide.py:14` | `model` | constant | 992 | 0 |
| +569 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 571 | 2 |
| +513 | `zuzu/packages/question_thread/types/question_thread_message_reviewer_type.py:26` | `full_name` | method | 513 | 0 |
| +511 | `zuzu/packages/user/types/visit_user_type.py:14` | `full_name` | constant | 511 | 0 |
| +510 | `zuzu/packages/unlisted_stock_management/graphql/types.py:55` | `full_name` | constant | 510 | 0 |
| +476 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 485 | 9 |
| +425 | `zuzu/packages/company/capital/capital_service.py:86` | `date` | method | 425 | 0 |
| +405 | `zuzu/db/models/meeting_document/shareholders_meeting_audit_report_document.py:65` | `date` | method | 408 | 3 |
| +404 | `zuzu/db/models/meeting_document/shareholders_written_resolution_document.py:67` | `date` | method | 406 | 2 |
| +404 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_document.py:63` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:79` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:84` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:74` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_individual_document.py:85` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/shareholders_meeting_minutes_document.py:96` | `date` | method | 404 | 0 |
| +395 | `zuzu/app/graphql/types/co_ceo_system_change_input.py:5` | `date` | constant | 396 | 1 |
| +393 | `zuzu/packages/with_shareholder_role/payroll/graphql/queries/portal_cash_compensations_query.py:27` | `count` | constant | 393 | 0 |
| +393 | `zuzu/packages/option/graphql/mutations/option_pause_mutation.py:39` | `date` | constant | 393 | 0 |
| +393 | `zuzu/packages/investment_association/document/services/ia_partner_certificate_of_investment_document_service.py:96` | `date` | constant | 396 | 3 |
| +392 | `zuzu/packages/stock_unissued_confirmation_request/types.py:20` | `date` | constant | 392 | 0 |
| +392 | `zuzu/packages/document/options/predefined_options.py:123` | `date` | function | 396 | 4 |
| +391 | `zuzu/common/factory/company/company_option_rule_factory.py:31` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:76` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/document/graphql/types.py:614` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/with_shareholder_role/shareholder/types.py:52` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/with_shareholder_role/employee_stock/types.py:97` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/phantom_stock/graphql/types/types.py:161` | `date` | constant | 391 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-property-targeted/discrepancies.jsonl`
