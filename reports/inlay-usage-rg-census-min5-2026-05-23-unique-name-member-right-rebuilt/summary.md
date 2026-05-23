# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158547**
- Elapsed: 11.8s

## Proxy Result

- Exact likely/proxy match: **39407/158547 = 24.9%**
- MAY undercount risk: **0/158547 = 0.0%**
- Likely below proxy but MAY safe: **116550/158547 = 73.5%**
- Proxy overcount: **2590/158547 = 1.6%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10244 | 55.5 | 0.0 | 26.3 | 18.2 |
| field | 131054 | 23.0 | 0.0 | 76.6 | 0.4 |
| function | 4113 | 56.8 | 0.0 | 39.7 | 3.5 |
| method | 13136 | 9.6 | 0.0 | 90.1 | 0.3 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +7906 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | field | 22501 | 14595 | 8822 | 14595 |
| +292 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 297 | 5 | 5 | 443 |
| +219 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 472 | 253 | 26 | 253 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +180 | `zuzu/common/management/commands/render_test_timing_tree.py:31` | `Node` | class | 184 | 4 | 4 | 0 |
| +149 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:42` | `locale` | field | 149 | 0 | 19 | 0 |
| +147 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:62` | `base` | field | 2765 | 2618 | 90 | 2618 |
| +145 | `zuzu/packages/hrm/emp/types.py:49` | `employeeNumber` | field | 145 | 0 | 0 | 0 |
| +138 | `zuzu/db/models/purchase/purchase_status_history.py:189` | `Status` | class | 229 | 91 | 91 | 1343 |
| +137 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 143 | 6 | 6 | 149 |
| +121 | `zuzu/common/types/env_collection.py:25` | `env` | method | 122 | 1 | 146 | 1 |
| +117 | `zuzu/fi_sta/models/fi_sta_user.py:43` | `Role` | class | 122 | 5 | 5 | 443 |
| +115 | `zuzu/db/models/subscription/subscription_perk.py:159` | `PerkType` | class | 116 | 1 | 1 | 107 |
| +114 | `zuzu/db/models/modusign/modusign_document_action_history.py:119` | `Status` | class | 205 | 91 | 91 | 1343 |
| +113 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | field | 1813 | 1700 | 11705 | 1700 |
| +93 | `zuzu/db/models/subscription/subscription.py:915` | `Status` | class | 184 | 91 | 91 | 1343 |
| +91 | `zuzu/db/models/subscription/subscription_perk.py:172` | `PerkMethod` | class | 92 | 1 | 1 | 85 |
| +88 | `zuzu/packages/sendgrid/views.py:35` | `ZUZU_ENV` | method | 209 | 121 | 18 | 121 |
| +82 | `zuzu/db/models/question_thread/question_thread_message_profile.py:13` | `ProfileType` | class | 84 | 2 | 2 | 81 |
| +81 | `zuzu/db/models/events/option/option_exercise_event.py:116` | `ExerciseType` | class | 83 | 2 | 2 | 79 |
| +71 | `zuzu/packages/corporate_registration/services/infotech_client.py:285` | `api` | field | 80 | 9 | 40 | 9 |
| +71 | `zuzu/db/models/signup_log.py:12` | `Path` | class | 159 | 88 | 88 | 16 |
| +68 | `zuzu/packages/subscription/types/subscription_types.py:433` | `SubscriptionPlanType` | class | 76 | 8 | 8 | 0 |
| +65 | `zuzu/db/models/incorporation_request/incorporation_request.py:232` | `Status` | class | 156 | 91 | 91 | 1343 |
| +62 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:82` | `Status` | class | 153 | 91 | 91 | 1343 |
| +54 | `zuzu/packages/incorporation/tests/mutations/test_create_incorporated_company.py:94` | `establishmentDate` | field | 54 | 0 | 0 | 0 |
| +54 | `zuzu/packages/document/base.py:51` | `NextAction` | class | 55 | 1 | 1 | 54 |
| +54 | `zuzu/db/models/hrm/document/form/hrm_document_form_field_definition.py:27` | `TEXT` | field | 54 | 0 | 0 | 0 |
| +53 | `zuzu/packages/unlisted_stock_management/notification/edit_individual_investor_sales_intent_slack_notification.py:65` | `individual_investor` | method | 65 | 12 | 0 | 12 |
| +53 | `zuzu/packages/captable/excel_writers/shareholder_register_excel_writer.py:21` | `origin` | field | 123 | 70 | 0 | 70 |
| +51 | `zuzu/db/models/purchase/payment/credit_card_payment/payment_status_history.py:21` | `Status` | class | 142 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/stakeholder/employee/employment_status.py:58` | `Status` | class | 141 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/registration_assistance.py:31` | `Status` | class | 141 | 91 | 91 | 1343 |
| +49 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:129` | `Method` | class | 54 | 5 | 5 | 133 |
| +47 | `zuzu/tests/meeting/test_meeting_draft.py:96` | `registrationAssistance` | field | 47 | 0 | 0 | 0 |
| +47 | `zuzu/db/models/owner_role/owner_role.py:81` | `OwnerPermissionType` | class | 1901 | 1854 | 1854 | 0 |
| +47 | `zuzu/db/models/share_class.py:52` | `COMMON_STOCK` | field | 51 | 4 | 50 | 4 |
| +46 | `zuzu/db/models/self_registration.py:17` | `Status` | class | 137 | 91 | 91 | 1343 |
| +45 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:162` | `CapitalSource` | class | 46 | 1 | 1 | 45 |
| +45 | `zuzu/db/models/investment_association/owner/ia_owner.py:56` | `Role` | class | 50 | 5 | 5 | 443 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_unique_name_member_right_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-unique-name-member-right-rebuilt/discrepancies.jsonl`
