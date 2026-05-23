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
- Current graph usage refresh: changed=25597, missing=0, errors=0
- Graph usage changed from cached baseline: 25658/25706

## Usage Signal

- Exact match: **7/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 3.8%
- Mean absolute error: 40.65
- Inlay mean: 48.31
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 49.64 | 54.03 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 24.89 | 42.89 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 27.13 | 34.31 | 7.18 |
| function | 1149 | 0.3 | 0.3 | 85.1 | 9.38 | 22.11 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 15566 | 60.6% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_50plus | 2432 | 9.5% |
| inlay_over_by_1-5 | 974 | 3.8% |
| match | 7 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +3380 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3385 | 5 |
| +1153 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1153 | 0 |
| +912 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 939 | 27 |
| +912 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 913 | 1 |
| +912 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 913 | 1 |
| +912 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 926 | 14 |
| +912 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 918 | 6 |
| +869 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 870 | 1 |
| +676 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 677 | 1 |
| +667 | `zuzu/common/factory/base.py:132` | `fake` | function | 673 | 6 |
| +593 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 599 | 6 |
| +548 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 548 | 0 |
| +536 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 541 | 5 |
| +510 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 510 | 0 |
| +493 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 502 | 9 |
| +471 | `zuzu/common/models/protocol.py:11` | `exists` | method | 471 | 0 |
| +392 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 457 | 65 |
| +378 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 387 | 9 |
| +371 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 530 | 159 |
| +355 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 356 | 1 |
| +354 | `zuzu/common/factory/company_user_relation_factory.py:47` | `stakeholder` | constant | 355 | 1 |
| +354 | `zuzu/common/factory/company_user_relation_factory.py:53` | `stakeholder` | constant | 355 | 1 |
| +351 | `zuzu/packages/with_shareholder_role/types/types.py:277` | `stakeholder` | constant | 351 | 0 |
| +350 | `zuzu/packages/owner_role/types.py:65` | `stakeholder` | constant | 351 | 1 |
| +348 | `zuzu/db/models/company/user_relation/company_user_relation.py:90` | `stakeholder` | constant | 399 | 51 |
| +347 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | constant | 349 | 2 |
| +345 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 346 | 1 |
| +339 | `zuzu/packages/company/payroll/services/payroll_statement_excel_writer.py:63` | `value` | constant | 339 | 0 |
| +325 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 615 | 290 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-class-margin-22/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-class-margin-22/discrepancies.jsonl`
