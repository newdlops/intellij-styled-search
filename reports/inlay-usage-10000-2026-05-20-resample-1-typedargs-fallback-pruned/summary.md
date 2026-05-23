# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/Users/lky/project/captain/.venv/bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Census mode: stratified sample
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 14
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=122, missing=0, errors=0
- Graph usage changed from cached baseline: 8001/10000

## Usage Signal

- Exact match: **6444/10000 = 64.4%**
- Within +/-1: 74.7%
- Within +/-5: 85.2%
- Mean absolute error: 7.31
- Inlay mean: 10.84
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 61.2 | 70.2 | 84.6 | 8.30 | 11.06 | 2.77 |
| class | 2000 | 75.8 | 92.6 | 98.0 | 0.87 | 6.96 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.84 | 4.56 | 3.71 |
| constant | 2000 | 32.2 | 44.4 | 60.6 | 18.26 | 20.57 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 6444 | 64.4% |
| inlay_over_no_lsp_refs | 1364 | 13.6% |
| inlay_over_by_1-5 | 1242 | 12.4% |
| inlay_over_by_6-50 | 721 | 7.2% |
| inlay_over_by_50plus | 229 | 2.3% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +1835 | `zuzu/common/logging.py:16` | `filter` | method | 1835 | 0 |
| +569 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 571 | 2 |
| +513 | `zuzu/packages/question_thread/types/question_thread_message_reviewer_type.py:26` | `full_name` | method | 513 | 0 |
| +475 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 484 | 9 |
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
| +401 | `zuzu/packages/document/options/predefined_options.py:123` | `date` | function | 405 | 4 |
| +400 | `zuzu/common/factory/company/company_option_rule_factory.py:31` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:76` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/with_shareholder_role/shareholder/types.py:52` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/with_shareholder_role/employee_stock/types.py:97` | `date` | constant | 400 | 0 |
| +400 | `zuzu/packages/phantom_stock/graphql/types/types.py:161` | `date` | constant | 400 | 0 |
| +400 | `zuzu/app/graphql/types/company_type.py:232` | `date` | constant | 400 | 0 |
| +399 | `zuzu/db/models/investment_association/document/ia_explanation_form_for_electronic_signature_document.py:49` | `date` | constant | 402 | 3 |
| +384 | `zuzu/packages/with_shareholder_role/payroll/graphql/queries/portal_cash_compensations_query.py:27` | `count` | constant | 384 | 0 |
| +383 | `zuzu/db/models/purchase/service_fee/service_fee.py:90` | `items` | method | 386 | 3 |
| +381 | `zuzu/packages/ms_word/services/field_tracker_service.py:46` | `count` | method | 385 | 4 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_option_exercise.py:76` | `items` | method | 378 | 0 |
| +378 | `zuzu/packages/option/tests/services/test_vesting_traceable_create_service_data.py:28` | `items` | constant | 386 | 8 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_branch_change.py:66` | `items` | method | 378 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-typedargs-fallback-pruned/discrepancies.jsonl`
