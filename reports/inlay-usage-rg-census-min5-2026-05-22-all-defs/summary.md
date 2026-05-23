# Fast RG Usage Census

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **115218**
- Elapsed: 12.0s

## Proxy Result

- Exact likely/proxy match: **6808/115218 = 5.9%**
- MAY undercount risk: **312/115218 = 0.3%**
- Likely below proxy but MAY safe: **107733/115218 = 93.5%**
- Proxy overcount: **365/115218 = 0.3%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 8715 | 36.5 | 0.0 | 60.1 | 3.4 |
| field | 93232 | 2.6 | 0.3 | 97.0 | 0.1 |
| function | 3054 | 35.3 | 0.0 | 64.1 | 0.6 |
| method | 10217 | 1.3 | 0.0 | 98.7 | 0.0 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| -74 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_from_payment.py:15` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/document/test_document_view.py:435` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/document/test_document_view.py:474` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/document/test_document_view.py:491` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/meeting/test_meeting_edit.py:778` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/mutations/new_issue_item_edit_mutation.py:72` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/mutations/new_issue_item_edit_mutation.py:105` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/mutations/new_issue_item_edit_mutation.py:30` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/mutations/new_issue_item_institution_edit_mutation.py:98` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/mutations/new_issue_item_institution_edit_mutation.py:135` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/mutations/new_issue_item_institution_edit_mutation.py:55` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/company/meeting/graphql/queries/new_issue_item_query.py:22` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/db/models/meeting_document/new_issue_stock_allocation_document.py:131` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/document/meeting_document/test_new_issue_stock_subscription_document.py:31` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:67` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:71` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:96` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:100` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:125` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:129` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:154` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:158` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:182` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/tests/registration/registration_fee_service/test_new_issue.py:186` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -74 | `zuzu/packages/document/document_types/stock_unissued_confirmation_document.py:22` | `new_issue_item` | field | 0 | 74 | 89 | 74 |
| -69 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_from_conversion.py:16` | `new_issue_item` | field | 5 | 74 | 89 | 74 |
| -65 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:37` | `new_issue_item` | field | 9 | 74 | 89 | 74 |
| -65 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:62` | `new_issue_item` | field | 9 | 74 | 89 | 74 |
| -65 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:69` | `new_issue_item` | field | 9 | 74 | 89 | 74 |
| -62 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:47` | `new_issue_item` | field | 12 | 74 | 89 | 74 |
| -62 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:72` | `new_issue_item` | field | 12 | 74 | 89 | 74 |
| -62 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:79` | `new_issue_item` | field | 12 | 74 | 89 | 74 |
| -53 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:42` | `new_issue_item` | field | 21 | 74 | 89 | 74 |
| -53 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:67` | `new_issue_item` | field | 21 | 74 | 89 | 74 |
| -53 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:74` | `new_issue_item` | field | 21 | 74 | 89 | 74 |
| -52 | `zuzu/db/models/meeting_document/new_issue_stock_subscription_document.py:42` | `new_issue_item` | field | 22 | 74 | 89 | 74 |
| -52 | `zuzu/db/models/meeting_document/new_issue_stock_subscription_document.py:67` | `new_issue_item` | field | 22 | 74 | 89 | 74 |
| -52 | `zuzu/db/models/meeting_document/new_issue_stock_subscription_document.py:74` | `new_issue_item` | field | 22 | 74 | 89 | 74 |
| -41 | `zuzu/packages/company/valuation/graphql/mutations/add_valuation_history_mutation.py:69` | `price_per_share` | field | 0 | 41 | 31 | 41 |
| -41 | `zuzu/common/factory/agenda_new_issue_item_factory.py:70` | `price_per_share` | field | 0 | 41 | 31 | 41 |

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
| +46 | `zuzu/db/models/self_registration.py:17` | `Status` | class | 137 | 91 | 91 | 1343 |
| +45 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:162` | `CapitalSource` | class | 46 | 1 | 1 | 45 |
| +45 | `zuzu/db/models/investment_association/owner/ia_owner.py:56` | `Role` | class | 50 | 5 | 5 | 443 |
| +40 | `zuzu/db/models/captable_request.py:74` | `Status` | class | 131 | 91 | 91 | 1343 |
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
| +20 | `zuzu/db/models/company/create_request/company_create_request.py:120` | `Status` | class | 111 | 91 | 91 | 1343 |
| +20 | `zuzu/db/models/events/option/option_pause_event.py:55` | `Reason` | class | 26 | 6 | 6 | 33 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260522_all_defs/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-22-all-defs/discrepancies.jsonl`
