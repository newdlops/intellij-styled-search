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
- Graph usage changed from cached baseline: 25694/25706

## Usage Signal

- Exact match: **3/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 0.0%
- Mean absolute error: 104.33
- Inlay mean: 111.99
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 123.06 | 127.45 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 99.21 | 117.21 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 27.18 | 34.36 | 7.18 |
| function | 1149 | 0.1 | 0.1 | 0.1 | 41.33 | 54.07 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_50plus | 15825 | 61.6% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_6-50 | 3150 | 12.3% |
| match | 3 | 0.0% |
| inlay_over_by_1-5 | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4157 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4162 | 5 |
| +4156 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4156 | 0 |
| +3443 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3448 | 5 |
| +1185 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1185 | 0 |
| +975 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 1002 | 27 |
| +975 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 976 | 1 |
| +975 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 976 | 1 |
| +975 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 989 | 14 |
| +975 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 981 | 6 |
| +943 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 944 | 1 |
| +749 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 750 | 1 |
| +709 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 709 | 0 |
| +709 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 709 | 0 |
| +708 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 708 | 0 |
| +708 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 708 | 0 |
| +708 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 708 | 0 |
| +708 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 708 | 0 |
| +708 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:62` | `output_field` | constant | 708 | 0 |
| +708 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:85` | `output_field` | constant | 708 | 0 |
| +699 | `zuzu/common/factory/base.py:132` | `fake` | function | 705 | 6 |
| +656 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 662 | 6 |
| +640 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 640 | 0 |
| +599 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 604 | 5 |
| +567 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 576 | 9 |
| +510 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 510 | 0 |
| +471 | `zuzu/common/models/protocol.py:11` | `exists` | method | 471 | 0 |
| +455 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 520 | 65 |
| +447 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 449 | 2 |
| +445 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 604 | 159 |
| +442 | `zuzu/packages/company/graphql/types/company_list_item_type.py:121` | `establishment_date` | constant | 442 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-explicit-reexport-follow-margin-lowered/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-explicit-reexport-follow-margin-lowered/discrepancies.jsonl`
