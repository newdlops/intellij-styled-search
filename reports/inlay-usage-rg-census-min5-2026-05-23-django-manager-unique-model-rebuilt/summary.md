# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158547**
- Elapsed: 11.0s

## Proxy Result

- Exact likely/proxy match: **36075/158547 = 22.8%**
- MAY undercount risk: **0/158547 = 0.0%**
- Likely below proxy but MAY safe: **122005/158547 = 77.0%**
- Proxy overcount: **467/158547 = 0.3%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10244 | 36.9 | 0.0 | 59.4 | 3.7 |
| field | 131054 | 22.6 | 0.0 | 77.4 | 0.1 |
| function | 4113 | 38.4 | 0.0 | 61.3 | 0.3 |
| method | 13136 | 8.4 | 0.0 | 91.5 | 0.0 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +292 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 297 | 5 | 5 | 443 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +138 | `zuzu/db/models/purchase/purchase_status_history.py:189` | `Status` | class | 229 | 91 | 91 | 1343 |
| +137 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 143 | 6 | 6 | 149 |
| +117 | `zuzu/fi_sta/models/fi_sta_user.py:43` | `Role` | class | 122 | 5 | 5 | 443 |
| +115 | `zuzu/db/models/subscription/subscription_perk.py:159` | `PerkType` | class | 116 | 1 | 1 | 107 |
| +114 | `zuzu/db/models/modusign/modusign_document_action_history.py:119` | `Status` | class | 205 | 91 | 91 | 1343 |
| +93 | `zuzu/db/models/subscription/subscription.py:915` | `Status` | class | 184 | 91 | 91 | 1343 |
| +91 | `zuzu/db/models/subscription/subscription_perk.py:172` | `PerkMethod` | class | 92 | 1 | 1 | 85 |
| +82 | `zuzu/db/models/question_thread/question_thread_message_profile.py:13` | `ProfileType` | class | 84 | 2 | 2 | 81 |
| +81 | `zuzu/db/models/events/option/option_exercise_event.py:116` | `ExerciseType` | class | 83 | 2 | 2 | 79 |
| +65 | `zuzu/db/models/incorporation_request/incorporation_request.py:232` | `Status` | class | 156 | 91 | 91 | 1343 |
| +62 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:82` | `Status` | class | 153 | 91 | 91 | 1343 |
| +54 | `zuzu/packages/document/base.py:51` | `NextAction` | class | 55 | 1 | 1 | 54 |
| +51 | `zuzu/db/models/purchase/payment/credit_card_payment/payment_status_history.py:21` | `Status` | class | 142 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/stakeholder/employee/employment_status.py:58` | `Status` | class | 141 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/registration_assistance.py:31` | `Status` | class | 141 | 91 | 91 | 1343 |
| +49 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:129` | `Method` | class | 54 | 5 | 5 | 133 |
| +47 | `zuzu/db/models/share_class.py:52` | `COMMON_STOCK` | field | 51 | 4 | 50 | 4 |
| +46 | `zuzu/db/models/self_registration.py:17` | `Status` | class | 137 | 91 | 91 | 1343 |
| +45 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:162` | `CapitalSource` | class | 46 | 1 | 1 | 45 |
| +45 | `zuzu/db/models/investment_association/owner/ia_owner.py:56` | `Role` | class | 50 | 5 | 5 | 443 |
| +40 | `zuzu/db/models/captable_request.py:74` | `Status` | class | 131 | 91 | 91 | 1343 |
| +40 | `zuzu/db/models/share_class.py:53` | `CLASS_STOCK` | field | 41 | 1 | 41 | 1 |
| +37 | `zuzu/db/models/events/stock/stock_transfer_event.py:94` | `Method` | class | 42 | 5 | 5 | 133 |
| +36 | `zuzu/db/models/stock_unissued_confirmation_request.py:77` | `Status` | class | 127 | 91 | 91 | 1343 |
| +36 | `zuzu/db/models/subscription/subscription_payment_request.py:57` | `Status` | class | 127 | 91 | 91 | 1343 |
| +35 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:26` | `DEDUCTION` | field | 43 | 8 | 0 | 8 |
| +35 | `zuzu/db/models/subscription/subscription_plan.py:72` | `RenewType` | class | 36 | 1 | 1 | 33 |
| +34 | `zuzu/db/models/meeting/meeting.py:919` | `RegistrationStatus` | class | 35 | 1 | 1 | 34 |
| +33 | `zuzu/packages/document/base.py:57` | `Kind` | class | 39 | 6 | 6 | 60 |
| +33 | `zuzu/db/models/company/electronic_certificate/electronic_certificate.py:57` | `MediaHolderChoices` | class | 37 | 4 | 4 | 36 |
| +31 | `zuzu/db/models/investment_association/ia_founding_progress_status.py:39` | `Status` | class | 122 | 91 | 91 | 1343 |
| +29 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:35` | `SALARY` | field | 35 | 6 | 0 | 6 |
| +29 | `zuzu/db/models/company/payroll/payroll_ledger.py:56` | `SALARY` | field | 35 | 6 | 0 | 6 |
| +28 | `zuzu/db/models/corporate_registration/corporate_registration_issue_log.py:38` | `IssuanceStatus` | class | 29 | 1 | 1 | 26 |
| +27 | `zuzu/db/models/investment_association/rule/ia_rule_compensation.py:41` | `ManagementCompensationMethodId` | class | 27 | 0 | 0 | 25 |
| +23 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_item.py:76` | `CombineType` | class | 25 | 2 | 2 | 21 |
| +22 | `zuzu/packages/document/base.py:75` | `Kind` | class | 28 | 6 | 6 | 60 |
| +21 | `zuzu/db/models/company/payroll/payroll_ledger.py:55` | `PaymentType` | class | 26 | 5 | 5 | 23 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_django_manager_unique_model_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-django-manager-unique-model-rebuilt/discrepancies.jsonl`
