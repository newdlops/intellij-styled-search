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
- Current graph usage refresh: changed=25669, missing=0, errors=0
- Graph usage changed from cached baseline: 25671/25706

## Usage Signal

- Exact match: **0/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 0.0%
- Mean absolute error: 128.33
- Inlay mean: 135.99
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 129.06 | 133.44 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 195.21 | 213.21 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 28.18 | 35.36 | 7.18 |
| function | 1149 | 0.0 | 0.0 | 0.0 | 78.33 | 91.07 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_50plus | 16905 | 65.8% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_6-50 | 2072 | 8.1% |
| inlay_over_by_1-5 | 2 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4163 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4168 | 5 |
| +4162 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4162 | 0 |
| +3449 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3454 | 5 |
| +1222 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1222 | 0 |
| +1039 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 1040 | 1 |
| +981 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 1008 | 27 |
| +981 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 982 | 1 |
| +981 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 982 | 1 |
| +981 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 995 | 14 |
| +981 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 987 | 6 |
| +845 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 846 | 1 |
| +736 | `zuzu/common/factory/base.py:132` | `fake` | function | 742 | 6 |
| +715 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 715 | 0 |
| +715 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 715 | 0 |
| +714 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 714 | 0 |
| +714 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 714 | 0 |
| +714 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 714 | 0 |
| +714 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 714 | 0 |
| +714 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:62` | `output_field` | constant | 714 | 0 |
| +714 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:85` | `output_field` | constant | 714 | 0 |
| +663 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 672 | 9 |
| +662 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 668 | 6 |
| +646 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 646 | 0 |
| +605 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 610 | 5 |
| +541 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 700 | 159 |
| +525 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 526 | 1 |
| +511 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 511 | 0 |
| +495 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 785 | 290 |
| +473 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 492 | 19 |
| +472 | `zuzu/common/models/protocol.py:11` | `exists` | method | 472 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-explicit-reexport-follow/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-explicit-reexport-follow/discrepancies.jsonl`
