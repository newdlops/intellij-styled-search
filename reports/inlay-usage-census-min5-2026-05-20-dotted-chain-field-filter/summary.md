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
- Current graph usage refresh: changed=25624, missing=0, errors=0
- Graph usage changed from cached baseline: 25661/25706

## Usage Signal

- Exact match: **7/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 3.8%
- Mean absolute error: 38.94
- Inlay mean: 46.60
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 46.90 | 51.29 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 24.89 | 42.89 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 27.86 | 35.04 | 7.18 |
| function | 1149 | 0.3 | 0.3 | 85.1 | 9.38 | 22.11 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 15793 | 61.4% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_50plus | 2201 | 8.6% |
| inlay_over_by_1-5 | 976 | 3.8% |
| match | 7 | 0.0% |
| inlay_under_by_6-50 | 2 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +3378 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3383 | 5 |
| +1153 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1153 | 0 |
| +869 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 870 | 1 |
| +676 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 677 | 1 |
| +667 | `zuzu/common/factory/base.py:132` | `fake` | function | 673 | 6 |
| +592 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 598 | 6 |
| +547 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 547 | 0 |
| +510 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 510 | 0 |
| +493 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 502 | 9 |
| +471 | `zuzu/common/models/protocol.py:11` | `exists` | method | 471 | 0 |
| +386 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 451 | 65 |
| +378 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 387 | 9 |
| +371 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 530 | 159 |
| +366 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 371 | 5 |
| +355 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 356 | 1 |
| +348 | `zuzu/common/factory/company_user_relation_factory.py:47` | `stakeholder` | constant | 349 | 1 |
| +348 | `zuzu/common/factory/company_user_relation_factory.py:53` | `stakeholder` | constant | 349 | 1 |
| +347 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | constant | 349 | 2 |
| +345 | `zuzu/packages/with_shareholder_role/types/types.py:277` | `stakeholder` | constant | 345 | 0 |
| +345 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 346 | 1 |
| +344 | `zuzu/packages/owner_role/types.py:65` | `stakeholder` | constant | 345 | 1 |
| +342 | `zuzu/db/models/company/user_relation/company_user_relation.py:90` | `stakeholder` | constant | 393 | 51 |
| +325 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 615 | 290 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 |
| +321 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 322 | 1 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 |
| +310 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 312 | 2 |
| +300 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 313 | 13 |
| +295 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | `value` | method | 297 | 2 |
| +295 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | `value` | method | 297 | 2 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -32 | `zuzu/db/models/site_settings.py:58` | `legal_site_url` | constant | 36 | 68 |
| -27 | `zuzu/db/models/events/option/option_exercise_event.py:117` | `NEW_SHARE` | constant | 38 | 65 |

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-dotted-chain-field-filter/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-dotted-chain-field-filter/discrepancies.jsonl`
