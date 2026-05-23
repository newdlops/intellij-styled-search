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
- Mean absolute error: 97.47
- Inlay mean: 105.14
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 112.60 | 116.99 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 99.21 | 117.21 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 27.13 | 34.31 | 7.18 |
| function | 1149 | 0.1 | 0.1 | 0.1 | 41.33 | 54.07 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_50plus | 15824 | 61.6% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_6-50 | 3151 | 12.3% |
| match | 3 | 0.0% |
| inlay_over_by_1-5 | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +3443 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3448 | 5 |
| +1185 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1185 | 0 |
| +975 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 1002 | 27 |
| +975 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 976 | 1 |
| +975 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 976 | 1 |
| +975 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 989 | 14 |
| +975 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 981 | 6 |
| +943 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 944 | 1 |
| +749 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 750 | 1 |
| +699 | `zuzu/common/factory/base.py:132` | `fake` | function | 705 | 6 |
| +656 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 662 | 6 |
| +611 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 611 | 0 |
| +599 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 604 | 5 |
| +567 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 576 | 9 |
| +510 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 510 | 0 |
| +471 | `zuzu/common/models/protocol.py:11` | `exists` | method | 471 | 0 |
| +455 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 520 | 65 |
| +445 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 604 | 159 |
| +429 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 430 | 1 |
| +417 | `zuzu/common/factory/company_user_relation_factory.py:47` | `stakeholder` | constant | 418 | 1 |
| +417 | `zuzu/common/factory/company_user_relation_factory.py:53` | `stakeholder` | constant | 418 | 1 |
| +414 | `zuzu/packages/with_shareholder_role/types/types.py:277` | `stakeholder` | constant | 414 | 0 |
| +413 | `zuzu/packages/owner_role/types.py:65` | `stakeholder` | constant | 414 | 1 |
| +411 | `zuzu/db/models/company/user_relation/company_user_relation.py:90` | `stakeholder` | constant | 462 | 51 |
| +410 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | constant | 412 | 2 |
| +402 | `zuzu/packages/company/payroll/services/payroll_statement_excel_writer.py:63` | `value` | constant | 402 | 0 |
| +399 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 689 | 290 |
| +384 | `zuzu/common/celery/celery.py:8` | `app` | constant | 388 | 4 |
| +384 | `zuzu/db/models/subscription/subscription_perk.py:192` | `value` | constant | 384 | 0 |
| +384 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 385 | 1 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-keyword-fallback-removed/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-keyword-fallback-removed/discrepancies.jsonl`
