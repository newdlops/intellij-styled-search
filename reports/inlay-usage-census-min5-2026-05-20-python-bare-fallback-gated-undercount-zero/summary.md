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

- Exact match: **0/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 0.0%
- Mean absolute error: 101.93
- Inlay mean: 109.59
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 89.20 | 93.57 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 193.86 | 211.85 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 28.33 | 35.50 | 7.18 |
| function | 1149 | 0.0 | 0.1 | 0.1 | 77.07 | 89.80 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_50plus | 16881 | 65.7% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_6-50 | 2089 | 8.1% |
| inlay_under_by_6-50 | 4 | 0.0% |
| inlay_over_by_1-5 | 3 | 0.0% |
| inlay_under_by_1-5 | 2 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4123 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4128 | 5 |
| +4122 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4122 | 0 |
| +3409 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3414 | 5 |
| +1220 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1220 | 0 |
| +1039 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 1040 | 1 |
| +941 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 968 | 27 |
| +941 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 942 | 1 |
| +941 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 942 | 1 |
| +941 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 955 | 14 |
| +941 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 947 | 6 |
| +845 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 846 | 1 |
| +735 | `zuzu/common/factory/base.py:132` | `fake` | function | 741 | 6 |
| +675 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 675 | 0 |
| +675 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 675 | 0 |
| +674 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 674 | 0 |
| +674 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 674 | 0 |
| +674 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 674 | 0 |
| +674 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 674 | 0 |
| +674 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:62` | `output_field` | constant | 674 | 0 |
| +674 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:85` | `output_field` | constant | 674 | 0 |
| +622 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 628 | 6 |
| +606 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 606 | 0 |
| +561 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 566 | 5 |
| +525 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 526 | 1 |
| +507 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 507 | 0 |
| +495 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 785 | 290 |
| +473 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 492 | 19 |
| +472 | `zuzu/common/models/protocol.py:11` | `exists` | method | 472 | 0 |
| +443 | `zuzu/app/services/stock_factory_service.py:19` | `Stakeholder` | class | 465 | 22 |
| +422 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 487 | 65 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -39 | `zuzu/db/models/stakeholder/director/director.py:59` | `AUDITOR` | constant | 137 | 176 |
| -37 | `zuzu/db/models/stakeholder/director/director.py:56` | `CO_CEO` | constant | 123 | 160 |
| -18 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:42` | `INDIVIDUAL` | constant | 94 | 112 |
| -12 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:43` | `INSTITUTION` | constant | 87 | 99 |
| -2 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:25` | `CORPORATION` | constant | 75 | 77 |
| -1 | `zuzu/packages/investment_association/owner/graphql/decorators/investment_association_owner_required.py:18` | `investment_association_owner_required` | function | 206 | 207 |

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-python-bare-fallback-gated-undercount-zero/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-python-bare-fallback-gated-undercount-zero/discrepancies.jsonl`
