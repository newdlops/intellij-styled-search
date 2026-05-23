# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Census mode: full population
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **41404**
- Dropped cached LSP symbols missing from current graph: 3899
- Skipped/unknown LSP candidates: 363
- Quarantined LSP timeout candidates: 18193
- Conservative 95% proportion margin at n=41404: +/-0.5%
- Current graph usage refresh: changed=20533, missing=3899, errors=0
- Graph usage changed from cached baseline: 20533/41404

## Usage Signal

- Exact match: **1187/41404 = 2.9%**
- Within +/-1: 4.7%
- Within +/-5: 14.8%
- Mean absolute error: 37.04
- Inlay mean: 40.92
- Pyright mean: 3.87

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 22413 | 0.5 | 2.6 | 3.4 | 53.52 | 55.62 | 2.11 |
| class | 10394 | 7.7 | 10.6 | 16.1 | 19.00 | 27.12 | 8.12 |
| method | 4873 | 1.1 | 1.2 | 1.6 | 24.41 | 27.21 | 2.81 |
| function | 3724 | 5.6 | 6.1 | 96.6 | 4.81 | 8.86 | 4.05 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 16423 | 39.7% |
| inlay_over_no_lsp_refs | 14976 | 36.2% |
| inlay_over_by_50plus | 4454 | 10.8% |
| inlay_over_by_1-5 | 4356 | 10.5% |
| match | 1187 | 2.9% |
| inlay_under_by_1-5 | 6 | 0.0% |
| inlay_under_by_6-50 | 2 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4861 | `zuzu/common/factory/base.py:73` | `create` | method | 4861 | 0 |
| +1786 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:58` | `errors` | constant | 1789 | 3 |
| +1676 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:61` | `validate` | constant | 1680 | 4 |
| +1637 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:62` | `execute` | constant | 1640 | 3 |
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 |
| +526 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 527 | 1 |
| +512 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:57` | `ok` | constant | 514 | 2 |
| +472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 |
| +333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 |
| +330 | `zuzu/common/celery/celery.py:8` | `app` | constant | 334 | 4 |
| +320 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 368 | 48 |
| +318 | `zuzu/common/models/purchasable.py:193` | `objects` | constant | 318 | 0 |
| +316 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 317 | 1 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 |
| +299 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | `value` | method | 301 | 2 |
| +294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 |
| +271 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 584 | 313 |
| +255 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | `value` | method | 257 | 2 |
| +254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 |
| +215 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 234 | 19 |
| +214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 |
| +213 | `zuzu/db/models/company/registration_case_report/registration_case_report_update_log.py:64` | `error` | constant | 213 | 0 |
| +211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 |
| +211 | `zuzu/packages/company/payroll/year_end_tax_settlement/types/bulk_send_yets_help_types.py:11` | `error` | constant | 214 | 3 |
| +210 | `zuzu/app/services/stock_factory_service.py:20` | `name` | constant | 224 | 14 |
| +208 | `zuzu/packages/notification/base/company_owner_slack_notification.py:59` | `link_url` | method | 208 | 0 |
| +207 | `zuzu/app/graphql/query/types.py:7` | `value` | constant | 208 | 1 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -29 | `zuzu/common/requests/api.py:43` | `get` | constant | 41 | 70 |
| -7 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/ia_meeting.py:42` | `get_queryset` | method | 12 | 19 |
| -4 | `zuzu/db/models/captable.py:91` | `at` | method | 24 | 28 |
| -2 | `zuzu/db/models/venture_capital/portfolio_company_manager.py:49` | `PortfolioCompanyManager` | class | 34 | 36 |
| -2 | `zuzu/packages/subscription/graphql/mutations/standard/pay_standard_subscription_mutation.py:82` | `TypedArguments` | class | 11 | 13 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/base/fi_sta_base_mutation.py:29` | `TypedArguments` | class | 8 | 9 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/base/staff_fi_sta_base_mutation.py:35` | `TypedArguments` | class | 6 | 7 |
| -1 | `zuzu/packages/option/option_exercise_management/graphql/mutations/base/option_exercise_claim_candidates_validation_mutation.py:42` | `TypedArguments` | class | 6 | 7 |

## Artifacts

- Population: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/population.jsonl`
- Candidate pool: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/sample_candidates.jsonl`
- Valid LSP results: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/lsp_usage_skipped.jsonl`
- Timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/lsp_usage_timeouts.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-fresh-structural-margin/discrepancies.jsonl`
