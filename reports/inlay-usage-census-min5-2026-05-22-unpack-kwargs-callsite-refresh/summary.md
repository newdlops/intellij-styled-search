# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Census mode: full population
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **40540**
- Dropped cached LSP symbols missing from current graph: 4763
- Skipped/unknown LSP candidates: 363
- Quarantined LSP timeout candidates: 18193
- Conservative 95% proportion margin at n=40540: +/-0.5%
- Current graph usage refresh: changed=5679, missing=4763, errors=0
- Graph usage changed from cached baseline: 20820/40540

## Usage Signal

- Exact match: **2575/40540 = 6.4%**
- Within +/-1: 8.2%
- Within +/-5: 18.4%
- Mean absolute error: 34.91
- Inlay mean: 38.80
- Pyright mean: 3.90

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 21725 | 7.0 | 9.0 | 10.0 | 50.00 | 52.08 | 2.08 |
| class | 10387 | 7.6 | 10.3 | 16.4 | 18.88 | 27.00 | 8.13 |
| method | 4844 | 1.1 | 1.2 | 1.5 | 24.02 | 26.83 | 2.81 |
| function | 3584 | 5.9 | 6.4 | 97.6 | 4.60 | 8.73 | 4.14 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 16115 | 39.8% |
| inlay_over_no_lsp_refs | 13565 | 33.5% |
| inlay_over_by_1-5 | 4301 | 10.6% |
| inlay_over_by_50plus | 3970 | 9.8% |
| match | 2575 | 6.4% |
| inlay_under_by_1-5 | 9 | 0.0% |
| inlay_missed | 3 | 0.0% |
| inlay_under_by_6-50 | 2 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4861 | `zuzu/common/factory/base.py:73` | `create` | method | 4861 | 0 |
| +1905 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:57` | `ok` | constant | 1907 | 2 |
| +1884 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:58` | `errors` | constant | 1887 | 3 |
| +1676 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:61` | `validate` | constant | 1680 | 4 |
| +1637 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:62` | `execute` | constant | 1640 | 3 |
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 |
| +846 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 847 | 1 |
| +664 | `zuzu/common/factory/base.py:132` | `fake` | function | 670 | 6 |
| +528 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 529 | 1 |
| +382 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 391 | 9 |
| +329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 |
| +318 | `zuzu/common/models/purchasable.py:193` | `objects` | constant | 318 | 0 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 |
| +294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 |
| +268 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 316 | 48 |
| +267 | `zuzu/app/services/stock_factory_service.py:20` | `name` | constant | 281 | 14 |
| +251 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 252 | 1 |
| +237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 |
| +219 | `zuzu/app/services/stock_factory_service.py:22` | `registration_number` | constant | 233 | 14 |
| +212 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 344 | 132 |
| +211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 |
| +211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 |
| +208 | `zuzu/packages/notification/base/company_owner_slack_notification.py:59` | `link_url` | method | 208 | 0 |
| +203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 |
| +197 | `zuzu/packages/user/types/staff_user_details_type.py:36` | `is_staff` | constant | 197 | 0 |
| +194 | `zuzu/packages/company/meeting/actions/send_new_issue_notice_email_action.py:18` | `meeting` | constant | 196 | 2 |
| +193 | `zuzu/common/factory/registration_assistance_factory.py:11` | `meeting` | constant | 193 | 0 |
| +192 | `zuzu/common/factory/directors_meeting_agenda_factory.py:11` | `meeting` | constant | 192 | 0 |
| +192 | `zuzu/common/factory/directors_meeting_factory.py:15` | `meeting` | constant | 192 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -29 | `zuzu/common/requests/api.py:43` | `get` | constant | 41 | 70 |
| -7 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/ia_meeting.py:42` | `get_queryset` | method | 12 | 19 |
| -5 | `zuzu/db/models/tbk/tbk_consulting/tbk_consulting_status_log.py:27` | `Status` | class | 17 | 22 |
| -4 | `zuzu/app/graphql/types/director_input.py:10` | `phone` | constant | 0 | 4 |
| -4 | `zuzu/db/models/captable.py:91` | `at` | method | 24 | 28 |
| -4 | `zuzu/db/models/tbk/tbk_consulting/tbk_consulting_status_log.py:26` | `TbkConsultingStatusLog` | class | 48 | 52 |
| -3 | `zuzu/common/graphql/types.py:137` | `TimestampedObjectType` | class | 183 | 186 |
| -2 | `zuzu/common/factory/agenda_bonus_issue_factory.py:27` | `paid_in_capital_in_excess_of_par_value` | constant | 0 | 2 |
| -2 | `zuzu/db/models/venture_capital/portfolio_company_manager.py:49` | `PortfolioCompanyManager` | class | 34 | 36 |
| -2 | `zuzu/packages/subscription/graphql/mutations/standard/pay_standard_subscription_mutation.py:82` | `TypedArguments` | class | 11 | 13 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/base/fi_sta_base_mutation.py:29` | `TypedArguments` | class | 8 | 9 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/base/staff_fi_sta_base_mutation.py:35` | `TypedArguments` | class | 6 | 7 |
| -1 | `zuzu/packages/option/option_exercise_management/graphql/mutations/base/option_exercise_claim_candidates_validation_mutation.py:42` | `TypedArguments` | class | 6 | 7 |
| -1 | `zuzu/packages/company/stakeholder/services/types.py:24` | `JobTitle` | constant | 0 | 1 |

## Artifacts

- Population: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/population.jsonl`
- Candidate pool: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/sample_candidates.jsonl`
- Valid LSP results: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/lsp_usage_skipped.jsonl`
- Timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260521_fresh_structural_margin/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-unpack-kwargs-callsite-refresh/discrepancies.jsonl`
