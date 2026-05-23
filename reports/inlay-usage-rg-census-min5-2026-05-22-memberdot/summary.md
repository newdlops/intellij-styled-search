# Fast RG Usage Census

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **115218**
- Elapsed: 10.3s

## Proxy Result

- Exact likely/proxy match: **6709/115218 = 5.8%**
- MAY undercount risk: **580/115218 = 0.5%**
- Likely below proxy but MAY safe: **107565/115218 = 93.4%**
- Proxy overcount: **364/115218 = 0.3%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 8715 | 36.5 | 0.0 | 60.1 | 3.4 |
| field | 93232 | 2.6 | 0.4 | 97.0 | 0.1 |
| function | 3054 | 32.1 | 7.3 | 60.1 | 0.6 |
| method | 10217 | 1.3 | 0.0 | 98.7 | 0.0 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| -1080 | `zuzu/db/models/agenda/director_compensation_rule/agenda_director_compensation_rule.py:65` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/payroll_ledger_attachment.py:49` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/payroll_ledger_file.py:54` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/statement/payroll_statement_document.py:56` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_book.py:172` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_book_without_date.py:133` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_certificate.py:164` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_receipt.py:101` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/investor_relations/deprecated/mna_buyer_attachment.py:35` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/investor_relations/im_attachment/im_attachment.py:88` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/investor_relations/ir_fund_raising/ir_fund_raising.py:91` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/meeting_document/base/meeting_document_cache.py:88` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/option/employee_option/exercise_management/employee_option_exercise_candidate_file.py:58` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1078 | `zuzu/db/models/company/company.py:1866` | `company_id` | function | 2 | 1080 | 1080 | 158 |
| -737 | `zuzu/packages/captable/actions/download_shareholder_register_excel_for_samsung_securities_action.py:19` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/corporate_registration/notifications/corporate_registration_issue_coupon_use_request_notification.py:25` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/corporate_registration/notifications/corporate_registration_issue_coupon_use_request_slack_notification.py:36` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/corporate_registration/notifications/corporate_registration_paid_issue_issue_failed_notification.py:26` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/corporate_registration/notifications/corporate_registration_paid_issue_purchased_notification.py:33` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/corporate_registration/notifications/corporate_registration_paid_issue_refunded_notification.py:33` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/document/actions/download_stock_unissued_confirmation_with_transfer_consent_action.py:24` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/employee_stock/employee_option/notifications/employee_option_not_claimed_slack_notification.py:29` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/employee_stock/employee_option/notifications/employee_option_refuse_slack_notification.py:29` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_association/consent_form_or_meeting/actions/bulk_download_ia_consent_form_or_meeting_esig_complete_documents_action.py:46` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_association/helpdesk/notifications/new_notice_ia_question_thread_notification.py:42` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_association/partner/actions/bulk_download_ia_partner_certificate_of_investment_documents_action.py:25` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_association/user_invitation/notifications/ia_user_invitation_accept_notification.py:75` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_simulation/notifications/investment_simulation_name_edit_notification.py:28` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_simulation/notifications/investment_simulation_round_add_notification.py:33` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_simulation/notifications/investment_simulation_round_delete_notification.py:25` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_simulation/notifications/investment_simulation_round_edit_notification.py:33` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/investment_simulation/notifications/investmnet_simulation_delete_notification.py:25` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/modusign/notifications/modusign_ia_document_request_canceled_notification.py:45` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/notification/stock_unissued_confirmation_request_cancel_notification.py:24` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/notification/stock_unissued_confirmation_request_notification.py:24` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/option/option_contract_template_permission/notifications/pay_option_contract_template_permission_slack_notification.py:37` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/option/option_exercise_management/notifications/option_exercise_claim_candidate_cancel_confirm_slack_notification.py:24` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/option/option_exercise_management/notifications/option_exercise_claim_candidate_confirm_slack_notification.py:24` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/option/option_exercise_management/notifications/option_exercise_claim_candidate_delete_slack_notification.py:25` | `action_message` | function | 0 | 737 | 737 | 2 |
| -737 | `zuzu/packages/option/option_exercise_management/notifications/option_exercise_claim_candidate_refuse_slack_notification.py:24` | `action_message` | function | 0 | 737 | 737 | 2 |

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

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260522_memberdot/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-22-memberdot/discrepancies.jsonl`
