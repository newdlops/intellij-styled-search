# Inlay Usage Accuracy Rerun

- Date: 2026-05-20
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25706**
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25706: +/-0.6%
- Current graph usage refresh: changed=25694, missing=0, errors=0
- Graph usage changed from cached baseline: 25696/25706

## Usage Signal

- Exact match: **3/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 15.5%
- Mean absolute error: 53.71
- Inlay mean: 61.38
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 74.17 | 78.56 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 61.8 | 8.06 | 26.06 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 28.47 | 35.65 | 7.18 |
| function | 1149 | 0.3 | 0.3 | 83.1 | 10.94 | 23.67 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_50plus | 8763 | 34.1% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_6-50 | 6227 | 24.2% |
| inlay_over_by_1-5 | 3986 | 15.5% |
| match | 3 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4111 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4116 | 5 |
| +4106 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4106 | 0 |
| +3396 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3401 | 5 |
| +1553 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 1554 | 1 |
| +1153 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1153 | 0 |
| +925 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 952 | 27 |
| +925 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 926 | 1 |
| +925 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 926 | 1 |
| +925 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 939 | 14 |
| +925 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 931 | 6 |
| +851 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 852 | 1 |
| +667 | `zuzu/common/factory/base.py:132` | `fake` | function | 673 | 6 |
| +667 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 673 | 6 |
| +659 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 659 | 0 |
| +659 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 659 | 0 |
| +658 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:62` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:85` | `output_field` | constant | 658 | 0 |
| +657 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 658 | 1 |
| +632 | `zuzu/common/graphql/scalars/positive_decimal.py:9` | `PositiveDecimal` | class | 783 | 151 |
| +590 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 590 | 0 |
| +574 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 575 | 1 |
| +545 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 550 | 5 |
| +524 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 527 | 3 |
| +507 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 507 | 0 |
| +496 | `zuzu/db/models/company/electronic_certificate/electronic_certificate.py:22` | `CEO` | constant | 496 | 0 |
| +489 | `zuzu/db/models/events/director/director_appointment_event.py:42` | `CEO` | constant | 502 | 13 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-undercount-zero-margin/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-undercount-zero-margin/discrepancies.jsonl`
