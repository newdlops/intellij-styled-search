# Inlay Usage Accuracy Rerun

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25635**
- Dropped cached LSP symbols missing from current graph: 71
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25635: +/-0.6%
- Current graph usage refresh: changed=10244, missing=71, errors=0

## Usage Signal

- Exact match: **5233/25635 = 20.4%**
- Missing: **71**
- Undercount: **142**
- Overcount: 20260
- Within +/-1: 26.9%
- Within +/-5: 42.5%
- Mean absolute error: 21.63
- Inlay mean: 29.25
- Pyright mean: 7.67

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4900 | 33.1 | 0 | 42.8 | 60.8 | 9.93 | 27.94 | 18.00 |
| constant | 16764 | 18.1 | 142 | 24.4 | 35.6 | 26.56 | 30.86 | 4.38 |
| function | 1149 | 8.2 | 0 | 8.9 | 86.3 | 7.67 | 20.40 | 12.73 |
| method | 2822 | 17.4 | 0 | 21.8 | 34.2 | 18.38 | 25.56 | 7.18 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9703 | 37.9% |
| match | 5233 | 20.4% |
| inlay_over_no_lsp_refs | 4981 | 19.4% |
| inlay_over_by_1-5 | 4321 | 16.9% |
| inlay_over_by_50plus | 1255 | 4.9% |
| inlay_under_by_1-5 | 73 | 0.3% |
| inlay_missed | 43 | 0.2% |
| inlay_under_by_6-50 | 25 | 0.1% |
| inlay_under_by_50plus | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| +527 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 528 | 1 | 654 |
| +472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 | 144 |
| +364 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 373 | 9 | 377 |
| +353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 179 |
| +333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 481 |
| +325 | `zuzu/common/celery/celery.py:8` | `app` | constant | 329 | 4 | 291 |
| +318 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 320 | 2 | 302 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 | 175 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 596 |
| +300 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 301 | 1 | 556 |
| +294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 468 |
| +270 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 283 | 13 | 186 |
| +266 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 579 | 313 | 492 |
| +259 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 270 | 11 | 218 |
| +254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 270 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 91 |
| +223 | `zuzu/db/models/agenda/base/directors_meeting_agenda_child_base.py:24` | `meeting` | method | 224 | 1 | 124 |
| +217 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 219 | 2 | 424 |
| +215 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 246 | 31 | 160 |
| +215 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 234 | 19 | 300 |
| +214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 349 |
| +212 | `zuzu/vcm/models/company/vcm_company.py:125` | `establishment_date` | constant | 213 | 1 | 423 |
| +210 | `zuzu/db/models/investment_association/rule/ia_rule.py:293` | `meeting` | method | 215 | 5 | 100 |
| +209 | `zuzu/db/models/option/option_management.py:142` | `meeting` | method | 210 | 1 | 95 |
| +208 | `zuzu/db/models/company/registration_case_report/registration_case_report_update_log.py:64` | `error` | constant | 208 | 0 | 182 |
| +208 | `zuzu/packages/articles_of_incorporation/services/aoi_audit_dump_service.py:153` | `error` | constant | 210 | 2 | 184 |
| +208 | `zuzu/packages/bigquery/notifications/bigquery_error_notification.py:11` | `error` | constant | 209 | 1 | 183 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| -61 | `zuzu/packages/ms_word/services/utils/types.py:62` | `paragraph_format` | constant | 38 | 99 | 109 |
| -43 | `zuzu/packages/ms_word/services/utils/types.py:68` | `paragraphs` | constant | 9 | 52 | 80 |
| -38 | `zuzu/packages/ms_word/services/utils/types.py:60` | `add_run` | constant | 26 | 64 | 73 |
| -24 | `zuzu/packages/ms_word/services/utils/types.py:84` | `cells` | constant | 7 | 31 | 48 |
| -21 | `zuzu/packages/ms_word/services/utils/types.py:29` | `font` | constant | 4 | 25 | 37 |
| -20 | `zuzu/packages/corporate_registration/auto_updater/types/branch_change.py:9` | `note` | constant | 25 | 45 | 63 |
| -16 | `zuzu/packages/ms_word/services/utils/types.py:56` | `runs` | constant | 6 | 22 | 30 |
| -16 | `zuzu/packages/ms_word/services/utils/types.py:57` | `alignment` | constant | 23 | 39 | 57 |
| -15 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 6 | 21 | 6 |
| -15 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:16` | `agenda_type` | constant | 72 | 87 | 69 |
| -14 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:83` | `ceo_set` | constant | 14 | 28 | 36 |
| -12 | `zuzu/packages/ms_word/services/utils/types.py:21` | `size` | constant | 6 | 18 | 61 |
| -11 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:442` | `traceable_type` | constant | 0 | 11 | 33 |
| -11 | `zuzu/packages/company/payroll/year_end_tax_settlement/year_end_tax_settlement_public/types/yets_employee_upload_form_version2.py:9` | `public_link` | constant | 4 | 15 | 46 |
| -11 | `zuzu/packages/ms_word/services/utils/types.py:28` | `bold` | constant | 2 | 13 | 19 |
| -10 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:19` | `deadline_date` | constant | 30 | 40 | 16 |
| -10 | `zuzu/packages/ms_word/services/utils/types.py:85` | `height` | constant | 0 | 10 | 28 |
| -10 | `zuzu/packages/ms_word/services/utils/types.py:92` | `width` | constant | 20 | 30 | 62 |
| -9 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:443` | `valid_from` | constant | 1 | 10 | 36 |
| -8 | `zuzu/packages/ms_word/services/utils/types.py:73` | `add_paragraph` | constant | 10 | 18 | 18 |
| -7 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:11` | `purpose` | constant | 2 | 9 | 17 |
| -6 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:114` | `cme_company_set` | constant | 7 | 13 | 15 |
| -6 | `zuzu/db/models/question_thread/company_question_thread.py:383` | `message_set` | constant | 34 | 40 | 26 |
| -6 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:481` | `traceable_type` | constant | 0 | 6 | 33 |
| -6 | `zuzu/db/models/user/app_user.py:321` | `phone_set` | constant | 2 | 8 | 5 |
| -6 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:14` | `change_note` | constant | 2 | 8 | 18 |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:22` | `color` | constant | 1 | 7 | 8 |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:69` | `vertical_alignment` | constant | 1 | 7 | 7 |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:99` | `columns` | constant | 38 | 44 | 90 |
| -5 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee.py:130` | `option_set` | constant | 3 | 8 | 24 |

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-generic-typevar-cli/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-generic-typevar-cli/discrepancies.jsonl`
