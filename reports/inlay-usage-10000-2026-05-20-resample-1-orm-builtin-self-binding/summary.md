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
- Current graph usage refresh: changed=377, missing=0, errors=0
- Graph usage changed from cached baseline: 8001/10000

## Usage Signal

- Exact match: **6442/10000 = 64.4%**
- Within +/-1: 74.2%
- Within +/-5: 85.0%
- Mean absolute error: 7.74
- Inlay mean: 11.27
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 61.2 | 69.5 | 84.4 | 8.50 | 11.26 | 2.77 |
| class | 2000 | 75.8 | 92.6 | 98.0 | 0.87 | 6.96 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.85 | 4.57 | 3.71 |
| constant | 2000 | 32.2 | 43.4 | 60.1 | 19.99 | 22.30 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 6442 | 64.4% |
| inlay_over_no_lsp_refs | 1364 | 13.6% |
| inlay_over_by_1-5 | 1235 | 12.3% |
| inlay_over_by_6-50 | 664 | 6.6% |
| inlay_over_by_50plus | 295 | 2.9% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +569 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 571 | 2 |
| +513 | `zuzu/packages/question_thread/types/question_thread_message_reviewer_type.py:26` | `full_name` | method | 513 | 0 |
| +457 | `zuzu/common/logging.py:16` | `filter` | method | 457 | 0 |
| +454 | `zuzu/packages/company/capital/capital_service.py:86` | `date` | method | 454 | 0 |
| +434 | `zuzu/db/models/meeting_document/shareholders_meeting_audit_report_document.py:65` | `date` | method | 437 | 3 |
| +433 | `zuzu/db/models/meeting_document/shareholders_written_resolution_document.py:67` | `date` | method | 435 | 2 |
| +433 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_document.py:63` | `date` | method | 433 | 0 |
| +433 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:79` | `date` | method | 433 | 0 |
| +433 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:84` | `date` | method | 433 | 0 |
| +433 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:74` | `date` | method | 433 | 0 |
| +433 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_individual_document.py:85` | `date` | method | 433 | 0 |
| +433 | `zuzu/db/models/meeting_document/shareholders_meeting_minutes_document.py:96` | `date` | method | 433 | 0 |
| +424 | `zuzu/app/graphql/types/co_ceo_system_change_input.py:5` | `date` | constant | 425 | 1 |
| +422 | `zuzu/packages/option/graphql/mutations/option_pause_mutation.py:39` | `date` | constant | 422 | 0 |
| +421 | `zuzu/packages/investment_association/document/services/ia_partner_certificate_of_investment_document_service.py:96` | `date` | constant | 424 | 3 |
| +421 | `zuzu/packages/document/options/predefined_options.py:123` | `date` | function | 425 | 4 |
| +420 | `zuzu/common/factory/company/company_option_rule_factory.py:31` | `date` | constant | 420 | 0 |
| +420 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:76` | `date` | constant | 420 | 0 |
| +420 | `zuzu/packages/with_shareholder_role/shareholder/types.py:52` | `date` | constant | 420 | 0 |
| +420 | `zuzu/packages/with_shareholder_role/employee_stock/types.py:97` | `date` | constant | 420 | 0 |
| +420 | `zuzu/packages/phantom_stock/graphql/types/types.py:161` | `date` | constant | 420 | 0 |
| +420 | `zuzu/app/graphql/types/company_type.py:232` | `date` | constant | 420 | 0 |
| +419 | `zuzu/db/models/investment_association/document/ia_explanation_form_for_electronic_signature_document.py:49` | `date` | constant | 422 | 3 |
| +383 | `zuzu/db/models/purchase/service_fee/service_fee.py:90` | `items` | method | 386 | 3 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_option_exercise.py:76` | `items` | method | 378 | 0 |
| +378 | `zuzu/packages/option/tests/services/test_vesting_traceable_create_service_data.py:28` | `items` | constant | 386 | 8 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_branch_change.py:66` | `items` | method | 378 | 0 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_authorized_shares_change.py:39` | `items` | method | 378 | 0 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text.py:27` | `items` | method | 378 | 0 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_new_options_rule_v2.py:46` | `items` | method | 378 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-orm-builtin-self-binding/discrepancies.jsonl`
