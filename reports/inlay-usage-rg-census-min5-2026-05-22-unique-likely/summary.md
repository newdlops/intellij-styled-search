# Fast RG Usage Census

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158568**
- Elapsed: 10.4s

## Proxy Result

- Exact likely/proxy match: **35326/158568 = 22.3%**
- MAY undercount risk: **0/158568 = 0.0%**
- Likely below proxy but MAY safe: **116643/158568 = 73.6%**
- Proxy overcount: **6599/158568 = 4.2%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10244 | 31.2 | 0.0 | 26.2 | 42.5 |
| field | 131054 | 22.3 | 0.0 | 76.8 | 0.9 |
| function | 4134 | 41.9 | 0.0 | 39.5 | 18.7 |
| method | 13136 | 8.6 | 0.0 | 89.2 | 2.1 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +7907 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | field | 22502 | 14595 | 8822 | 14595 |
| +2213 | `zuzu/common/graphql/decorators/common.py:34` | `Info` | class | 10433 | 8220 | 8220 | 0 |
| +1180 | `zuzu/common/graphql/typed_graphene/typed_field.py:16` | `TypedField` | class | 12289 | 11109 | 11109 | 0 |
| +1132 | `zuzu/db/models/owner_role/owner_role.py:81` | `OwnerPermissionType` | class | 2986 | 1854 | 1854 | 0 |
| +862 | `zuzu/common/utils/__init__.py:102` | `legal_site_url` | function | 1723 | 861 | 861 | 65 |
| +833 | `zuzu/common/graphql/typed_graphene/types/id_str.py:4` | `IDStr` | class | 8592 | 7759 | 7759 | 0 |
| +724 | `zuzu/packages/vcm/common/graphql/context.py:26` | `VcmInfo` | class | 1454 | 730 | 730 | 0 |
| +708 | `zuzu/common/graphql/decorators/common.py:25` | `BaseContext` | class | 3049 | 2341 | 2341 | 0 |
| +610 | `zuzu/common/graphql/__init__.py:131` | `ItemNotFound` | class | 1224 | 614 | 614 | 0 |
| +424 | `zuzu/packages/hrm/contexts.py:5` | `HrmOwnerContext` | class | 848 | 424 | 424 | 0 |
| +417 | `zuzu/vcm/models/ir/vcm_ir.py:579` | `VcmIr` | class | 832 | 415 | 415 | 0 |
| +414 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:62` | `base` | field | 3032 | 2618 | 90 | 2618 |
| +385 | `zuzu/common/utils/masking/__init__.py:23` | `masking_name` | function | 922 | 537 | 537 | 1 |
| +365 | `zuzu/common/graphql/paginator.py:29` | `paginate` | function | 734 | 369 | 369 | 0 |
| +359 | `zuzu/db/models/owner_role/owner_role.py:83` | `PERMISSION_BASIC` | field | 706 | 347 | 0 | 347 |
| +350 | `zuzu/packages/notification/base/slack_notification.py:27` | `AbstractSlackNotification` | class | 805 | 455 | 455 | 0 |
| +332 | `zuzu/tests/base.py:52` | `GraphQLTestCase` | class | 664 | 332 | 332 | 0 |
| +319 | `zuzu/common/factory/company_factory.py:18` | `CompanyFactory` | class | 1074 | 755 | 755 | 0 |
| +314 | `zuzu/common/graphql/paginator.py:24` | `PaginationArguments` | class | 634 | 320 | 320 | 0 |
| +292 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 297 | 5 | 5 | 443 |
| +260 | `zuzu/packages/document/base.py:96` | `DocumentViewContext` | class | 611 | 351 | 351 | 0 |
| +254 | `zuzu/packages/venture_capital/contexts.py:9` | `VcUserPermissionRequiredContext` | class | 511 | 257 | 257 | 0 |
| +233 | `zuzu/common/factory/app_user_factory.py:18` | `AppUserFactory` | class | 877 | 644 | 644 | 0 |
| +231 | `zuzu/packages/venture_capital/decorators.py:20` | `vc_user_permission_required` | function | 474 | 243 | 243 | 0 |
| +214 | `zuzu/common/graphql/__init__.py:47` | `to_camelcase` | function | 430 | 216 | 216 | 0 |
| +187 | `zuzu/db/models/option/option_vesting/option_vesting.py:26` | `VestingInputType` | class | 402 | 215 | 215 | 0 |
| +184 | `zuzu/common/management/commands/render_test_timing_tree.py:31` | `Node` | class | 188 | 4 | 4 | 0 |
| +183 | `zuzu/packages/document/options/__init__.py:33` | `DocumentOption` | class | 411 | 228 | 228 | 0 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +180 | `zuzu/db/models/question_thread/company_question_thread.py:351` | `CompanyHelpType` | class | 505 | 325 | 325 | 0 |
| +177 | `zuzu/common/graphql/types.py:51` | `TypedPageInfoType` | class | 385 | 208 | 208 | 0 |
| +171 | `zuzu/common/utils/__init__.py:109` | `staff_site_url` | function | 344 | 173 | 173 | 22 |
| +169 | `zuzu/common/management/commands/collect_constants.py:335` | `choices_to_dict` | function | 338 | 169 | 169 | 0 |
| +167 | `zuzu/packages/vcm/investor/contexts.py:7` | `VcmInvestorContext` | class | 342 | 175 | 175 | 0 |
| +165 | `zuzu/common/graphql/types.py:84` | `FieldFileType` | class | 356 | 191 | 191 | 0 |
| +165 | `zuzu/db/models/owner_role/owner_role.py:84` | `PERMISSION_OPTION_BASIC` | field | 328 | 163 | 0 | 163 |
| +156 | `zuzu/db/models/meeting_document/base/meeting_document.py:81` | `Type` | field | 489 | 333 | 199 | 333 |
| +154 | `zuzu/packages/vcm/company/contexts.py:5` | `VcmCompanyContext` | class | 308 | 154 | 154 | 0 |
| +154 | `zuzu/packages/vcm/investor/decorators.py:23` | `vcm_investor_permission_required` | function | 312 | 158 | 158 | 0 |
| +153 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:42` | `locale` | field | 153 | 0 | 19 | 0 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260522_unique_likely/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-22-unique-likely/discrepancies.jsonl`
