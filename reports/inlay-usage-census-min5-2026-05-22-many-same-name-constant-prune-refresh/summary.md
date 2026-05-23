# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: many-same-name-constant-prune-refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25640**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **37**
- Missed (usage=0, lsp>0): **5**
- Exact: **2885/25640 = 11.25%**
- Overcount: **22718**
- Usage changed from previous report: **6720**
- Annotation base check without structural margin: exact **3126/7688 = 40.66%**, under **211**, missed **40**, over **4311**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16782 | 1523 | 37 | 5 | 15222 | 9.08% |
| class | 4900 | 961 | 0 | 0 | 3939 | 19.61% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 306 | 0 | 0 | 843 | 26.63% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 10010 | 39.04% |
| inlay_over_no_lsp_refs | 5799 | 22.62% |
| inlay_over_by_50plus | 4750 | 18.53% |
| exact | 2885 | 11.25% |
| inlay_over_by_1-5 | 2159 | 8.42% |
| inlay_under_by_6-50 | 29 | 0.11% |
| inlay_missed | 5 | 0.02% |
| inlay_under_by_1-5 | 3 | 0.01% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_director_compensation_service.py:46` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_director_compensation_service.py:96` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/authorized_shares_change.py:23` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/borrow_capital.py:17` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/cash_dividends.py:17` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/change_of_articles_of_incorporation.py:45` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/custom.py:22` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/director_compensation_rule.py:17` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/financial_statements.py:24` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/head_office_relocation.py:30` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/head_office_relocation.py:74` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/option_cancel.py:21` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/option_grant.py:16` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/rsu_grant.py:20` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/shareholders_meeting_convocation.py:16` | `agenda_type` | constant | 68 | 87 | 100 |
| -19 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/subsidiary_establishment.py:22` | `agenda_type` | constant | 68 | 87 | 100 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/bonus_issue.py:23` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/branch_change.py:42` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/ceo_address_change.py:20` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/co_ceo_system_change.py:21` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/company_name_change.py:22` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/director_change.py:58` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/method_of_giving_public_notice_change.py:22` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/new_issue.py:27` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/new_options_rule.py:17` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/new_or_change_rsu_rule.py:25` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/option_exercise.py:28` | `agenda_type` | constant | 69 | 87 | 101 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agendas/purpose_change.py:20` | `agenda_type` | constant | 69 | 87 | 101 |
| -6 | `zuzu/packages/company/meeting/types/meeting_service_types.py:577` | `agendas` | constant | 79 | 85 | 157 |
| -3 | `zuzu/db/models/modusign/modusign_document_action_history.py:124` | `COMPLETED` | constant | 20 | 23 | 25 |
| -1 | `zuzu/app/graphql/types/director_input.py:5` | `director_id` | constant | 0 | 1 | 43 |
| -1 | `zuzu/common/factory/modusign/modusign_document_participant_factory.py:28` | `modusign_document` | constant | 0 | 1 | 43 |
| -1 | `zuzu/packages/company/meeting/errors.py:113` | `code` | constant | 0 | 1 | 51 |
| -1 | `zuzu/packages/company/stakeholder/director/graphql/mutations/add_director_term_mutation.py:28` | `term_end_type` | constant | 0 | 1 | 42 |
| -1 | `zuzu/packages/company/stakeholder/director/graphql/mutations/edit_director_term_mutation.py:53` | `term_end_type` | constant | 0 | 1 | 42 |
| -1 | `zuzu/packages/corporate_registration/services/content_extract_service/client/codef_client.py:50` | `_client` | constant | 5 | 6 | 6 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/mixins/fi_sta_validation_mixin.py:51` | `phone_number` | constant | 4 | 5 | 8 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 846 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 847 | 1 | 848 |
| 664 | `zuzu/common/factory/base.py:132` | `fake` | function | 670 | 6 | 669 |
| 527 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 528 | 1 | 527 |
| 382 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 391 | 9 | 481 |
| 358 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 367 | 9 | 384 |
| 352 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 511 | 159 | 512 |
| 329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 | 334 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 593 |
| 294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 294 |
| 268 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 316 | 48 | 368 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 255 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 212 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 344 | 132 | 346 |
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |
| 211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 | 234 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 199 | `zuzu/common/models/protocol.py:13` | `annotate` | method | 396 | 197 | 394 |
| 197 | `zuzu/packages/user/types/staff_user_details_type.py:36` | `is_staff` | constant | 197 | 0 | 197 |
| 194 | `zuzu/db/models/announcement/announcement.py:136` | `objects` | constant | 221 | 27 | 221 |
| 192 | `zuzu/packages/user_activity/types.py:13` | `RSU` | constant | 195 | 3 | 195 |
| 192 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 193 | 1 | 334 |
| 184 | `zuzu/staff/pages.py:14` | `get_staff_page_path` | function | 184 | 0 | 184 |
| 175 | `zuzu/packages/ms_word/services/utils/types.py:8` | `append` | constant | 179 | 4 | 177 |
| 173 | `zuzu/common/models/registration_number_queryset_mixin.py:9` | `registration_number` | method | 186 | 13 | 85 |
| 173 | `zuzu/common/factory/app_user_factory.py:30` | `is_staff` | constant | 173 | 0 | 173 |
| 173 | `zuzu/common/factory/user_factory.py:41` | `is_staff` | constant | 173 | 0 | 173 |
| 173 | `zuzu/packages/user/types/user_list_filter_input_type.py:8` | `is_staff` | constant | 173 | 0 | 173 |
| 172 | `zuzu/db/models/stock.py:25` | `bulk_create` | method | 172 | 0 | 172 |
| 167 | `zuzu/packages/vcm/alimtalk/types.py:88` | `template_parameter` | constant | 171 | 4 | 171 |
| 166 | `zuzu/packages/mode/mode_middleware.py:25` | `mode` | constant | 169 | 3 | 179 |
| 166 | `zuzu/packages/vcm/alimtalk/types.py:87` | `contact` | constant | 171 | 5 | 176 |
| 165 | `zuzu/db/models/purchase/payment_link/payment_link.py:145` | `venture_capital` | method | 166 | 1 | 12 |
| 164 | `zuzu/common/factory/director_factory.py:24` | `director_type` | method | 164 | 0 | 177 |
| 154 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 185 | 31 | 270 |
| 152 | `zuzu/common/factory/company_user_relation_factory.py:13` | `CompanyUserRelationFactory` | class | 153 | 1 | 153 |
| 151 | `zuzu/db/models/meeting_document/base/meeting_document.py:83` | `directors_meeting` | constant | 176 | 25 | 208 |
| 147 | `zuzu/common/factory/company_factory.py:129` | `address` | method | 147 | 0 | 33 |
| 147 | `zuzu/common/factory/prepared_company_factory.py:74` | `address` | method | 147 | 0 | 33 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-many-same-name-constant-prune-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-many-same-name-constant-prune-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-many-same-name-constant-prune-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-many-same-name-constant-prune-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-many-same-name-constant-prune-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **38.77**
