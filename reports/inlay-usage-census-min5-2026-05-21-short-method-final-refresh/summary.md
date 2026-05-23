# Inlay Usage Current Graph Check

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Graph: rebuilt after short-method fallback update
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-21-self-scope-typed-field-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25678**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **420**
- Missed (usage=0, lsp>0): **8**
- Exact: **2333/25678 = 9.09%**
- Overcount: **22925**
- Usage changed from previous report: **18050**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16806 | 473 | 408 | 8 | 15925 | 2.81% |
| class | 4900 | 1464 | 11 | 0 | 3425 | 29.88% |
| method | 2823 | 302 | 1 | 0 | 2520 | 10.70% |
| function | 1149 | 94 | 0 | 0 | 1055 | 8.18% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 8283 | 32.26% |
| inlay_over_no_lsp_refs | 6622 | 25.79% |
| inlay_over_by_50plus | 5576 | 21.72% |
| inlay_over_by_1-5 | 2444 | 9.52% |
| exact | 2333 | 9.09% |
| inlay_under | 412 | 1.60% |
| inlay_missed | 8 | 0.03% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -22 | `zuzu/common/factory/agenda_new_issue_item_factory.py:65` | `AgendaNewIssueItemFactory` | class | 8 | 30 | 30 |
| -10 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:442` | `traceable_type` | constant | 1 | 11 | 33 |
| -9 | `zuzu/packages/ms_word/services/utils/types.py:85` | `height` | constant | 1 | 10 | 28 |
| -7 | `zuzu/common/factory/question_thread_factory.py:10` | `QuestionThreadFactory` | class | 10 | 17 | 18 |
| -5 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:481` | `traceable_type` | constant | 1 | 6 | 33 |
| -4 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:297` | `traceable_type` | constant | 1 | 5 | 33 |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:26` | `subscription_plans` | constant | 1 | 5 | 11 |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:27` | `companies` | constant | 1 | 5 | 17 |
| -4 | `zuzu/packages/company/meeting/graphql/mutations/edit_agenda_custom_title_mutation.py:40` | `agenda` | constant | 1 | 5 | 12 |
| -4 | `zuzu/packages/company/meeting/graphql/mutations/edit_agenda_details_in_meeting_notice_mutation.py:40` | `resolution_meeting` | constant | 1 | 5 | 8 |
| -4 | `zuzu/packages/investment_association/helpdesk/graphql/queries/staff_ia_question_thread_list_query.py:22` | `where` | constant | 1 | 5 | 41 |
| -4 | `zuzu/packages/unlisted_stock_management/investment_association/graphql/mutations/staff_create_usm_ia_and_partner_mutation.py:51` | `investment_association` | constant | 1 | 5 | 186 |
| -4 | `zuzu/tests/legal/background_tasks/test_send_help_reminder.py:146` | `elapsed` | constant | 1 | 5 | 15 |
| -3 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:30` | `pin_start_at` | constant | 1 | 4 | 24 |
| -3 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:29` | `attachments` | constant | 1 | 4 | 50 |
| -3 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:31` | `pin_end_at` | constant | 1 | 4 | 19 |
| -3 | `zuzu/packages/safe/graphql/mutations/delete_contract_file_mutation.py:30` | `safe` | constant | 1 | 4 | 16 |
| -3 | `zuzu/packages/safe/graphql/mutations/upload_contract_file_mutation.py:31` | `safe` | constant | 1 | 4 | 16 |
| -3 | `zuzu/packages/unlisted_stock_management/investment_association/graphql/mutations/staff_create_usm_ia_and_partner_mutation.py:50` | `registration_request` | constant | 1 | 4 | 14 |
| -3 | `zuzu/packages/venture_capital/quarterly_report/graphql/mutations/send_quarterly_report_request_mutation.py:54` | `quarterly_report` | constant | 1 | 4 | 133 |
| -3 | `zuzu/tests/legal/background_tasks/test_send_help_reminder.py:151` | `legal_partner` | constant | 1 | 4 | 29 |
| -3 | `zuzu/packages/unlisted_stock_management/graphql/mutations/mixins/individual_investor_company_validation_mixin.py:50` | `IndividualInvestorCompanyInfoCeoInputErrors` | class | 6 | 9 | 9 |
| -2 | `zuzu/app/graphql/types/__init__.py:365` | `total_price` | constant | 1 | 3 | 13 |
| -2 | `zuzu/db/models/company/investment_simulation/interfaces.py:22` | `share_class_identifier` | constant | 1 | 3 | 10 |
| -2 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:28` | `profile` | constant | 1 | 3 | 21 |
| -2 | `zuzu/packages/company/company_investment_contract_info/graphql/mutations/base_authorized_options_soft_limit_mutation.py:35` | `authorized_options_method` | constant | 1 | 3 | 18 |
| -2 | `zuzu/packages/company/company_investment_contract_info/graphql/mutations/base_authorized_options_soft_limit_mutation.py:37` | `authorized_options_fixed_value` | constant | 1 | 3 | 10 |
| -2 | `zuzu/packages/company/company_investment_contract_info/graphql/mutations/base_authorized_options_soft_limit_mutation.py:38` | `authorized_options_soft_limit_detailed_clause` | constant | 1 | 3 | 6 |
| -2 | `zuzu/packages/company/company_investment_contract_info/graphql/mutations/delete_authorized_options_soft_limit_mutation.py:26` | `company_investment_contract_info` | constant | 1 | 3 | 10 |
| -2 | `zuzu/packages/company/right_to_consent_or_consult/graphql/mutations/send_rtcc_email_mutation.py:37` | `test_email_data` | constant | 1 | 3 | 12 |
| -2 | `zuzu/packages/company/stakeholder/employee/graphql/mutations/confirm_employment_certificate_document_request_mutation.py:54` | `seal_stamp` | constant | 1 | 3 | 80 |
| -2 | `zuzu/packages/financial_account/graphql/mutations/staff_edit_financial_institution_mutation.py:23` | `financial_institution` | constant | 1 | 3 | 9 |
| -2 | `zuzu/packages/investment_round/graphql/mutations/base/investment_round_validation_mutation.py:34` | `new_issue_events` | constant | 1 | 3 | 6 |
| -2 | `zuzu/packages/legal_partner/graphql/mutations/select_incorporation_assistance_partner_mutation.py:38` | `tax_partner` | constant | 1 | 3 | 13 |
| -2 | `zuzu/packages/payment/payment_link/graphql/mutations/pay_company_payment_link_mutation.py:38` | `credit_use_inputs` | constant | 1 | 3 | 146 |
| -2 | `zuzu/packages/payment/payment_link/graphql/mutations/refund_company_payment_link_mutation.py:37` | `credit_refund_inputs` | constant | 1 | 3 | 83 |
| -2 | `zuzu/packages/safe/graphql/mutations/edit_safe_mutation.py:35` | `safe` | constant | 1 | 3 | 17 |
| -2 | `zuzu/packages/stock/stock_transfer_service.py:180` | `quantities_to_transfer` | constant | 1 | 3 | 19 |
| -2 | `zuzu/packages/stock/stock_transfer_service.py:182` | `transfer_method` | constant | 1 | 3 | 42 |
| -2 | `zuzu/packages/stock_transfer_agreement/mutations/v2/add_related_tax_advice_to_stock_transfer_agreement_management_mutation.py:23` | `question_thread` | constant | 1 | 3 | 231 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| 663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| 526 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 527 | 1 | 654 |
| 472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 | 144 |
| 375 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 384 | 9 | 377 |
| 353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 179 |
| 336 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 337 | 1 | 556 |
| 333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 481 |
| 330 | `zuzu/common/celery/celery.py:8` | `app` | constant | 334 | 4 | 291 |
| 320 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 368 | 48 | 175 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 596 |
| 294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 468 |
| 286 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | `value` | method | 288 | 2 | 289 |
| 271 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 584 | 313 | 492 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 270 |
| 249 | `zuzu/app/services/stock_factory_service.py:22` | `registration_number` | constant | 263 | 14 | 107 |
| 247 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 278 | 31 | 160 |
| 242 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | `value` | method | 244 | 2 | 289 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 91 |
| 227 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:10` | `meeting` | constant | 229 | 2 | 97 |
| 227 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:10` | `meeting` | constant | 229 | 2 | 97 |
| 227 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:23` | `meeting` | constant | 234 | 7 | 103 |
| 227 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:23` | `meeting` | constant | 234 | 7 | 102 |
| 226 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:11` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:9` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:11` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:10` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:12` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:12` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:12` | `meeting` | constant | 228 | 2 | 97 |
| 226 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:23` | `meeting` | constant | 233 | 7 | 102 |
| 224 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:422` | `meeting` | constant | 225 | 1 | 94 |
| 224 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:520` | `meeting` | constant | 226 | 2 | 97 |
| 223 | `zuzu/packages/company/meeting/graphql/mutations/agenda_option_cancel_edit_mutation.py:33` | `meeting` | constant | 224 | 1 | 136 |
| 220 | `zuzu/packages/company/payroll/services/payroll_statement_excel_writer.py:63` | `value` | constant | 220 | 0 | 310 |
| 216 | `zuzu/db/models/incorporation_request/incorporation_request_director.py:25` | `director_type` | constant | 221 | 5 | 174 |
| 215 | `zuzu/packages/company/graphql/types/company_list_item_type.py:48` | `director_type` | constant | 215 | 0 | 168 |
| 215 | `zuzu/packages/company/meeting/types/meeting_plan_agenda_director_change_for_edit.py:22` | `director_type` | constant | 215 | 0 | 168 |
| 215 | `zuzu/packages/company/meeting/types/meeting_plan_director_attendance_for_edit.py:23` | `director_type` | constant | 215 | 0 | 168 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-21-short-method-final-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-21-short-method-final-refresh/discrepancies.jsonl`
