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
- Current graph usage refresh: changed=25625, missing=0, errors=0
- Graph usage changed from cached baseline: 25660/25706

## Usage Signal

- Exact match: **8/25706 = 0.0%**
- Within +/-1: 0.0%
- Within +/-5: 3.9%
- Mean absolute error: 38.96
- Inlay mean: 46.63
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 46.99 | 51.38 | 4.39 |
| class | 4903 | 0.0 | 0.0 | 0.0 | 24.76 | 42.76 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 27.85 | 35.03 | 7.18 |
| function | 1149 | 0.3 | 0.3 | 85.6 | 9.26 | 21.99 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 15770 | 61.3% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_50plus | 2223 | 8.6% |
| inlay_over_by_1-5 | 977 | 3.8% |
| match | 8 | 0.0% |
| inlay_under_by_1-5 | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +1153 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1153 | 0 |
| +869 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 870 | 1 |
| +667 | `zuzu/common/factory/base.py:132` | `fake` | function | 673 | 6 |
| +548 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 549 | 1 |
| +547 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 547 | 0 |
| +536 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 541 | 5 |
| +510 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 510 | 0 |
| +493 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 502 | 9 |
| +471 | `zuzu/common/models/protocol.py:11` | `exists` | method | 471 | 0 |
| +387 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 452 | 65 |
| +378 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 387 | 9 |
| +371 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 530 | 159 |
| +355 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 356 | 1 |
| +349 | `zuzu/common/factory/company_user_relation_factory.py:47` | `stakeholder` | constant | 350 | 1 |
| +349 | `zuzu/common/factory/company_user_relation_factory.py:53` | `stakeholder` | constant | 350 | 1 |
| +346 | `zuzu/packages/with_shareholder_role/types/types.py:277` | `stakeholder` | constant | 346 | 0 |
| +345 | `zuzu/packages/owner_role/types.py:65` | `stakeholder` | constant | 346 | 1 |
| +345 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 346 | 1 |
| +343 | `zuzu/db/models/company/user_relation/company_user_relation.py:90` | `stakeholder` | constant | 394 | 51 |
| +325 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 615 | 290 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 |
| +310 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 312 | 2 |
| +300 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 313 | 13 |
| +295 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | `value` | method | 297 | 2 |
| +295 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | `value` | method | 297 | 2 |
| +287 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 306 | 19 |
| +274 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 285 | 11 |
| +264 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 265 | 1 |
| +262 | `zuzu/packages/ms_word/services/field_tracker_service.py:31` | `all` | method | 266 | 4 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -1 | `zuzu/db/models/stakeholder/stakeholder.py:265` | `registration_number` | constant | 162 | 163 |

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-keyword-arg-and-duplicate-param-filter/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-keyword-arg-and-duplicate-param-filter/discrepancies.jsonl`
