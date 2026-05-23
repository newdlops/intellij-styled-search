# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 16
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=30, missing=0, errors=0
- Graph usage changed from cached baseline: 10000/10000

## Usage Signal

- Exact match: **7474/10000 = 74.7%**
- Within +/-1: 82.3%
- Within +/-5: 89.1%
- Mean absolute error: 5.40
- Inlay mean: 7.88
- Pyright mean: 2.48

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 78.8 | 83.0 | 88.9 | 6.11 | 7.34 | 1.24 |
| class | 2000 | 77.0 | 92.5 | 98.4 | 0.68 | 5.35 | 4.67 |
| constant | 2000 | 46.2 | 56.0 | 70.9 | 13.59 | 15.49 | 1.90 |
| function | 2000 | 93.0 | 96.8 | 98.5 | 0.53 | 3.86 | 3.33 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 7474 | 74.7% |
| inlay_over_no_lsp_refs | 1046 | 10.5% |
| inlay_over_by_1-5 | 872 | 8.7% |
| inlay_over_by_6-50 | 392 | 3.9% |
| inlay_over_by_50plus | 216 | 2.2% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +510 | `zuzu/app/graphql/mutation/user_edit_mutation.py:22` | `full_name` | constant | 511 | 1 |
| +510 | `zuzu/packages/company_managing_entity/types.py:259` | `full_name` | constant | 510 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 483 | 0 |
| +481 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:509` | `extracted` | constant | 483 | 2 |
| +419 | `zuzu/db/models/company/electronic_certificate/electronic_certificate.py:21` | `DIRECTOR` | constant | 419 | 0 |
| +419 | `zuzu/packages/corporate_registration/xml_parser/types/xml_parser_corporate_registration.py:56` | `DIRECTOR` | constant | 430 | 11 |
| +407 | `zuzu/db/models/meeting_document/option_exercise_claim_meeting_document.py:134` | `date` | method | 408 | 1 |
| +405 | `zuzu/db/models/meeting_document/shareholders_meeting_shorten_period_document.py:77` | `date` | method | 406 | 1 |
| +404 | `zuzu/db/models/meeting_document/registration_form_captable_document.py:113` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:74` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/new_issue_stock_subscription_document.py:101` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/directors_meeting_skip_notice_document.py:75` | `date` | method | 404 | 0 |
| +391 | `zuzu/packages/company/graphql/mutations/branch/branch_abolition_event_edit_mutation.py:37` | `date` | constant | 393 | 2 |
| +391 | `zuzu/packages/tbk/types.py:134` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/document/graphql/types.py:643` | `date` | constant | 391 | 0 |
| +389 | `zuzu/db/models/company/company_name_change.py:132` | `date` | constant | 392 | 3 |
| +383 | `zuzu/db/models/purchase/service_fee/service_fee.py:90` | `items` | method | 386 | 3 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_director_change.py:202` | `items` | method | 378 | 0 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_aoi_change.py:67` | `items` | method | 378 | 0 |
| +378 | `zuzu/db/models/registration_form_text/registration_form_text_branch_change.py:66` | `items` | method | 378 | 0 |
| +368 | `zuzu/packages/venture_capital/quarterly_report/types.py:296` | `items` | constant | 368 | 0 |
| +367 | `zuzu/db/models/agenda/purpose_change/agenda_purpose_change.py:134` | `items` | constant | 370 | 3 |
| +337 | `zuzu/db/models/company/user_relation/company_user_relation.py:90` | `stakeholder` | constant | 388 | 51 |
| +288 | `zuzu/common/models/protocol.py:13` | `annotate` | method | 485 | 197 |
| +284 | `zuzu/packages/dashboard/types.py:10` | `value` | constant | 284 | 0 |
| +273 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:426` | `vesting_start_date` | constant | 281 | 8 |
| +260 | `zuzu/db/models/question_thread/question_thread_assignment.py:42` | `question_thread` | constant | 260 | 0 |
| +253 | `zuzu/common/factory/rsu/vesting/rsu_vesting_traceable_factory.py:43` | `vesting_remaining_period` | constant | 253 | 0 |
| +251 | `zuzu/packages/question_thread/notifications/reach_reminder_time_slack_notification.py:26` | `question_thread` | constant | 256 | 5 |
| +226 | `zuzu/packages/company/meeting/graphql/types/meeting_type.py:305` | `meeting_plans` | constant | 226 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260519/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260519/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260519/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260519/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-19/discrepancies.jsonl`
