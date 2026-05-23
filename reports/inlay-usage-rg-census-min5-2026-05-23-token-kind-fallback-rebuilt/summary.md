# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **113870**
- Elapsed: 10.7s

## Proxy Result

- Exact likely/proxy match: **6029/113870 = 5.3%**
- MAY undercount risk: **313/113870 = 0.3%**
- Likely below proxy but MAY safe: **107241/113870 = 94.2%**
- Proxy overcount: **287/113870 = 0.3%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 8625 | 36.7 | 0.0 | 60.7 | 2.6 |
| field | 93198 | 2.6 | 0.3 | 97.0 | 0.1 |
| function | 1817 | 16.0 | 0.1 | 83.4 | 0.6 |
| method | 10230 | 1.4 | 0.0 | 98.6 | 0.0 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| -157 | `zuzu/db/models/company/company.py:730` | `articles_of_incorporation` | function | 0 | 157 | 157 | 218 |
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

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +292 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 297 | 5 | 5 | 443 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +138 | `zuzu/db/models/purchase/purchase_status_history.py:189` | `Status` | class | 229 | 91 | 91 | 1343 |
| +137 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 143 | 6 | 6 | 149 |
| +117 | `zuzu/fi_sta/models/fi_sta_user.py:43` | `Role` | class | 122 | 5 | 5 | 443 |
| +114 | `zuzu/db/models/modusign/modusign_document_action_history.py:119` | `Status` | class | 205 | 91 | 91 | 1343 |
| +93 | `zuzu/db/models/subscription/subscription.py:915` | `Status` | class | 184 | 91 | 91 | 1343 |
| +82 | `zuzu/db/models/question_thread/question_thread_message_profile.py:13` | `ProfileType` | class | 84 | 2 | 2 | 81 |
| +65 | `zuzu/db/models/incorporation_request/incorporation_request.py:232` | `Status` | class | 156 | 91 | 91 | 1343 |
| +62 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:82` | `Status` | class | 153 | 91 | 91 | 1343 |
| +51 | `zuzu/db/models/purchase/payment/credit_card_payment/payment_status_history.py:21` | `Status` | class | 142 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/stakeholder/employee/employment_status.py:58` | `Status` | class | 141 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/registration_assistance.py:31` | `Status` | class | 141 | 91 | 91 | 1343 |
| +49 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:129` | `Method` | class | 54 | 5 | 5 | 133 |
| +46 | `zuzu/db/models/self_registration.py:17` | `Status` | class | 137 | 91 | 91 | 1343 |
| +45 | `zuzu/db/models/investment_association/owner/ia_owner.py:56` | `Role` | class | 50 | 5 | 5 | 443 |
| +40 | `zuzu/db/models/captable_request.py:74` | `Status` | class | 131 | 91 | 91 | 1343 |
| +37 | `zuzu/db/models/events/stock/stock_transfer_event.py:94` | `Method` | class | 42 | 5 | 5 | 133 |
| +36 | `zuzu/db/models/stock_unissued_confirmation_request.py:77` | `Status` | class | 127 | 91 | 91 | 1343 |
| +36 | `zuzu/db/models/subscription/subscription_payment_request.py:57` | `Status` | class | 127 | 91 | 91 | 1343 |
| +35 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:26` | `DEDUCTION` | field | 43 | 8 | 0 | 8 |
| +33 | `zuzu/packages/document/base.py:57` | `Kind` | class | 39 | 6 | 6 | 60 |
| +33 | `zuzu/db/models/company/electronic_certificate/electronic_certificate.py:57` | `MediaHolderChoices` | class | 37 | 4 | 4 | 36 |
| +31 | `zuzu/db/models/investment_association/ia_founding_progress_status.py:39` | `Status` | class | 122 | 91 | 91 | 1343 |
| +29 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:35` | `SALARY` | field | 35 | 6 | 0 | 6 |
| +29 | `zuzu/db/models/company/payroll/payroll_ledger.py:56` | `SALARY` | field | 35 | 6 | 0 | 6 |
| +22 | `zuzu/packages/document/base.py:75` | `Kind` | class | 28 | 6 | 6 | 60 |
| +21 | `zuzu/db/models/company/payroll/payroll_ledger.py:55` | `PaymentType` | class | 26 | 5 | 5 | 23 |
| +20 | `zuzu/db/models/company/create_request/company_create_request.py:120` | `Status` | class | 111 | 91 | 91 | 1343 |
| +20 | `zuzu/db/models/events/option/option_pause_event.py:55` | `Reason` | class | 26 | 6 | 6 | 33 |
| +20 | `zuzu/db/models/shareholders_agreement/shareholders_agreement.py:91` | `Status` | class | 111 | 91 | 91 | 1343 |
| +20 | `zuzu/db/models/tbk/tbk_consulting/tbk_consulting_status_log.py:27` | `Status` | class | 111 | 91 | 91 | 1343 |
| +19 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:41` | `SOCIAL_INSURANCE` | field | 19 | 0 | 0 | 0 |
| +19 | `zuzu/db/models/email_activity/email_activity_recipient_status_history.py:48` | `Status` | class | 110 | 91 | 91 | 1343 |
| +19 | `zuzu/vcm/models/alimtalk/vcm_alimtalk_activity_recipient_status_history.py:88` | `Status` | class | 110 | 91 | 91 | 1343 |
| +18 | `zuzu/db/models/company/payroll/payroll_ledger_item_setting_relation.py:64` | `StatementInclusionType` | class | 24 | 6 | 6 | 16 |
| +17 | `zuzu/db/models/alimtalk_activity/alimtalk_activity_recipient_status_history.py:36` | `Status` | class | 108 | 91 | 91 | 1343 |
| +17 | `zuzu/db/models/corporate_registration/corporate_registration_change_detection_parse_result.py:36` | `DocumentUploadStatus` | class | 31 | 14 | 14 | 25 |
| +17 | `zuzu/db/models/stakeholder/stakeholder.py:563` | `NameDoesNotMatch` | class | 17 | 0 | 0 | 18 |
| +16 | `zuzu/db/models/investment_association/investment_association.py:359` | `ServiceStatus` | class | 24 | 8 | 8 | 14 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_token_kind_fallback_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-token-kind-fallback-rebuilt/discrepancies.jsonl`
