# Inlay Usage Accuracy Rerun

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **24083**
- Dropped cached LSP symbols missing from current graph: 1623
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=24083: +/-0.6%
- Current graph usage refresh: changed=12088, missing=1623, errors=0

## Usage Signal

- Exact match: **2438/24083 = 10.1%**
- Missing: **1623**
- Undercount: **333**
- Overcount: 21312
- Within +/-1: 13.2%
- Within +/-5: 22.0%
- Mean absolute error: 39.97
- Inlay mean: 47.59
- Pyright mean: 7.82

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4665 | 32.7 | 211 | 43.2 | 60.3 | 9.98 | 27.53 | 18.32 |
| constant | 15608 | 2.5 | 40 | 3.0 | 3.9 | 54.90 | 59.31 | 4.42 |
| function | 1071 | 6.9 | 46 | 10.0 | 85.7 | 7.91 | 20.23 | 13.04 |
| method | 2739 | 16.4 | 36 | 21.6 | 34.8 | 18.53 | 25.69 | 7.23 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 7768 | 32.3% |
| inlay_over_no_lsp_refs | 6232 | 25.9% |
| inlay_over_by_50plus | 4784 | 19.9% |
| inlay_over_by_1-5 | 2528 | 10.5% |
| match | 2438 | 10.1% |
| inlay_under_by_1-5 | 241 | 1.0% |
| inlay_under_by_6-50 | 79 | 0.3% |
| inlay_under_by_50plus | 8 | 0.0% |
| inlay_missed | 5 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +1042 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1042 | 0 | 1149 |
| +849 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 850 | 1 | 848 |
| +665 | `zuzu/common/factory/base.py:132` | `fake` | function | 671 | 6 | 669 |
| +507 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 508 | 1 | 654 |
| +471 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 480 | 9 | 144 |
| +348 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 507 | 159 | 179 |
| +325 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 326 | 1 | 481 |
| +315 | `zuzu/common/celery/celery.py:8` | `app` | constant | 319 | 4 | 291 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 | 175 |
| +297 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 298 | 1 | 556 |
| +295 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 585 | 290 | 596 |
| +290 | `zuzu/common/models/protocol.py:11` | `exists` | method | 290 | 0 | 468 |
| +263 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 576 | 313 | 492 |
| +262 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 275 | 13 | 186 |
| +246 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 257 | 11 | 218 |
| +239 | `zuzu/packages/company/graphql/types/company_list_item_type.py:123` | `establishment_date` | constant | 239 | 0 | 423 |
| +229 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 229 | 0 | 91 |
| +229 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 230 | 1 | 270 |
| +222 | `zuzu/packages/company/types.py:12` | `establishment_date` | constant | 224 | 2 | 425 |
| +220 | `zuzu/packages/payment/graphql/mutations/register_credit_card_mutation.py:43` | `venture_capital` | constant | 224 | 4 | 176 |
| +220 | `zuzu/packages/user/mutations/edit_venture_capital_relation_mutation.py:24` | `venture_capital` | constant | 222 | 2 | 177 |
| +220 | `zuzu/packages/venture_capital/graphql/mutations/staff_edit_venture_capital_mutation.py:27` | `venture_capital` | constant | 222 | 2 | 176 |
| +219 | `zuzu/common/models/protocol.py:9` | `update` | method | 220 | 1 | 236 |
| +219 | `zuzu/packages/venture_capital/vc_user_relation/graphql/mutations/staff_create_vc_user_relation_mutation.py:35` | `venture_capital` | constant | 221 | 2 | 175 |
| +218 | `zuzu/packages/investor_relations/graphql/mutations/staff_create_ir_alert_mutation.py:23` | `venture_capital` | constant | 220 | 2 | 175 |
| +218 | `zuzu/packages/investor_relations/graphql/mutations/staff_edit_ir_alert_mutation.py:26` | `venture_capital` | constant | 220 | 2 | 175 |
| +218 | `zuzu/packages/payment/payment_link/graphql/mutations/staff_create_vc_payment_link_mutation.py:21` | `venture_capital` | constant | 220 | 2 | 174 |
| +218 | `zuzu/packages/venture_capital/vc_subscription/graphql/mutations/staff_add_venture_capital_subscription_trial_plan_mutation.py:22` | `venture_capital` | constant | 220 | 2 | 175 |
| +218 | `zuzu/packages/venture_capital/vc_subscription/graphql/mutations/staff_cancel_venture_capital_current_subscription_if_trial_plan_mutation.py:22` | `venture_capital` | constant | 220 | 2 | 175 |
| +218 | `zuzu/packages/venture_capital/vc_subscription/graphql/mutations/staff_extend_vc_subscription_mutation.py:42` | `venture_capital` | constant | 220 | 2 | 176 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| -156 | `zuzu/vcm/models/user/vcm_user.py:46` | `VcmUser` | class | 99 | 255 | 259 |
| -144 | `zuzu/packages/vcm/company/decorators.py:19` | `vcm_company_permission_required` | function | 4 | 148 | 148 |
| -139 | `zuzu/vcm/models/investor/vcm_investor.py:77` | `VcmInvestor` | class | 72 | 211 | 217 |
| -130 | `zuzu/packages/vcm/company/contexts.py:5` | `VcmCompanyContext` | class | 24 | 154 | 154 |
| -104 | `zuzu/db/models/events/option/option_exercise_event.py:98` | `OptionExerciseEvent` | class | 85 | 189 | 192 |
| -100 | `zuzu/packages/vcm/investor/contexts.py:7` | `VcmInvestorContext` | class | 71 | 171 | 171 |
| -97 | `zuzu/vcm/models/company/vcm_company.py:62` | `VcmCompany` | class | 39 | 136 | 139 |
| -94 | `zuzu/packages/vcm/investor/decorators.py:27` | `vcm_investor_permission_required` | function | 60 | 154 | 154 |
| -42 | `zuzu/common/graphql/types.py:137` | `TimestampedObjectType` | class | 141 | 183 | 183 |
| -33 | `zuzu/common/models/dynamic_choice_text_field.py:8` | `DynamicChoiceTextField` | class | 136 | 169 | 300 |
| -28 | `zuzu/packages/vcm/investor/types.py:61` | `VcmInvestorType` | class | 7 | 35 | 37 |
| -26 | `zuzu/db/models/shareholders_meeting_agenda.py:347` | `ShareholdersMeetingAgenda` | class | 155 | 181 | 185 |
| -26 | `zuzu/packages/notification/base/abstract_hrm_slack_notification.py:7` | `AbstractHrmSlackNotification` | class | 242 | 268 | 268 |
| -25 | `zuzu/db/models/directors_meeting_agenda.py:210` | `DirectorsMeetingAgenda` | class | 113 | 138 | 143 |
| -23 | `zuzu/common/graphql/types.py:84` | `FieldFileType` | class | 165 | 188 | 190 |
| -23 | `zuzu/packages/vcm/common/graphql/context.py:19` | `VcmBaseContext` | class | 19 | 42 | 42 |
| -22 | `zuzu/db/models/hrm/approval/hrm_approval.py:75` | `HrmApproval` | class | 99 | 121 | 124 |
| -21 | `zuzu/db/models/hrm/attendance/work/hrm_work_base.py:43` | `HrmWorkBase` | class | 51 | 72 | 75 |
| -21 | `zuzu/db/models/hrm/document/form/hrm_document_form.py:31` | `HrmDocumentForm` | class | 68 | 89 | 91 |
| -19 | `zuzu/db/models/hrm/leave/hrm_leave_base.py:66` | `HrmLeaveBase` | class | 91 | 110 | 114 |
| -18 | `zuzu/packages/vcm/company/types.py:20` | `VcmCompanyType` | class | 4 | 22 | 22 |
| -15 | `zuzu/db/models/stakeholder/rsu_grantee.py:218` | `RsuGrantee` | class | 74 | 89 | 92 |
| -15 | `zuzu/packages/vcm/user/types.py:9` | `VcmUserType` | class | 4 | 19 | 20 |
| -14 | `zuzu/packages/vcm/common/decorators.py:9` | `vcm_login_required` | function | 8 | 22 | 22 |
| -14 | `zuzu/packages/modusign/services/modusign_client/modusign_client.py:23` | `ModusignClientError` | class | 30 | 44 | 44 |
| -13 | `zuzu/db/models/rsu/rsu.py:49` | `Rsu` | class | 210 | 223 | 230 |
| -13 | `zuzu/db/models/subscription/subscription_package.py:29` | `SubscriptionPackage` | class | 32 | 45 | 47 |
| -13 | `zuzu/packages/company/meeting/types/meeting_plan_agenda_for_edit.py:55` | `MeetingPlanAgendaForEdit` | class | 21 | 34 | 35 |
| -13 | `zuzu/vcm/types.py:23` | `VcmInvestmentRoundCategoryType` | class | 11 | 24 | 24 |
| -12 | `zuzu/common/utils/field_file.py:22` | `convert_blank_field_file_to_none` | function | 72 | 84 | 84 |

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-structural-field-margin-cli/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-structural-field-margin-cli/discrepancies.jsonl`
