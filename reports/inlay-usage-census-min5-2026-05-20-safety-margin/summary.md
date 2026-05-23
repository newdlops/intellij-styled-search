# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Census mode: full population
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25706**
- Skipped/unknown LSP candidates: 0
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25706: +/-0.6%
- Current graph usage refresh: changed=108, missing=0, errors=0
- Graph usage changed from cached baseline: 108/25706

## Usage Signal

- Exact match: **4855/25706 = 18.9%**
- Within +/-1: 24.6%
- Within +/-5: 43.2%
- Mean absolute error: 22.28
- Inlay mean: 29.95
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 7.0 | 9.5 | 25.5 | 29.15 | 33.54 | 4.39 |
| class | 4903 | 44.6 | 61.8 | 91.0 | 4.04 | 22.03 | 18.00 |
| method | 2823 | 21.9 | 26.3 | 46.9 | 18.85 | 26.02 | 7.18 |
| function | 1149 | 75.5 | 82.7 | 88.5 | 8.05 | 20.78 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 6886 | 26.8% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_1-5 | 5609 | 21.8% |
| match | 4855 | 18.9% |
| inlay_over_by_50plus | 1629 | 6.3% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +21805 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 21810 | 5 |
| +12775 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | constant | 12777 | 2 |
| +4061 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4066 | 5 |
| +4056 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4056 | 0 |
| +1505 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 1506 | 1 |
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 |
| +910 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 937 | 27 |
| +910 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 911 | 1 |
| +910 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 911 | 1 |
| +910 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 924 | 14 |
| +910 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 916 | 6 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 |
| +682 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 685 | 3 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 |
| +653 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 654 | 1 |
| +628 | `zuzu/common/graphql/scalars/positive_decimal.py:9` | `PositiveDecimal` | class | 779 | 151 |
| +619 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 625 | 6 |
| +609 | `zuzu/common/requests/api.py:48` | `patch` | constant | 612 | 3 |
| +574 | `zuzu/common/tests/time_machine.py:22` | `now` | function | 583 | 9 |
| +570 | `zuzu/packages/product/tests/services/test_product_conversion_service.py:21` | `now` | constant | 578 | 8 |
| +555 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 556 | 1 |
| +548 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 548 | 0 |
| +506 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 511 | 5 |
| +504 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 504 | 0 |
| +484 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 484 | 0 |
| +484 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 484 | 0 |
| +483 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 483 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 483 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 483 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 483 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/population.jsonl`
- Candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_skipped.jsonl`
- Timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-safety-margin/discrepancies.jsonl`
