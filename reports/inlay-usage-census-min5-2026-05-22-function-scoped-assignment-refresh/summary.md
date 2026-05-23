# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: function-scoped-assignment-refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25640**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **23**
- Missed (usage=0, lsp>0): **0**
- Exact: **2083/25640 = 8.12%**
- Overcount: **23534**
- Usage changed from previous report: **871**
- Annotation base check without structural margin: exact **2837/7688 = 36.90%**, under **112**, missed **31**, over **4708**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16782 | 724 | 23 | 0 | 16035 | 4.31% |
| class | 4900 | 965 | 0 | 0 | 3935 | 19.69% |
| method | 2809 | 94 | 0 | 0 | 2715 | 3.35% |
| function | 1149 | 300 | 0 | 0 | 849 | 26.11% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9027 | 35.21% |
| inlay_over_no_lsp_refs | 6622 | 25.83% |
| inlay_over_by_50plus | 5780 | 22.54% |
| inlay_over_by_1-5 | 2105 | 8.21% |
| exact | 2083 | 8.12% |
| inlay_under_by_1-5 | 21 | 0.08% |
| inlay_under_by_6-50 | 2 | 0.01% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -7 | `zuzu/common/graphql/decorators/company_owner_required.py:260` | `info` | constant | 9 | 16 | 145 |
| -6 | `zuzu/packages/captable/excel_writers/statement_on_a_change_of_shares_excel_writer.py:319` | `data` | constant | 7 | 13 | 53 |
| -5 | `zuzu/packages/question_thread/queries/general_question_thread/staff_general_question_thread_list_query.py:71` | `qs` | constant | 6 | 11 | 46 |
| -4 | `zuzu/packages/option/graphql/mutations/option_grant/option_grant_or_edit_mutation.py:136` | `item_errors` | constant | 11 | 15 | 51 |
| -3 | `zuzu/packages/investment_association/partner/graphql/mutations/edit_ia_partner_mutation.py:85` | `previous_partner_info` | constant | 2 | 5 | 42 |
| -3 | `zuzu/packages/tbk/graphql/queries/tbk_consulting_list_query.py:52` | `order` | constant | 2 | 5 | 47 |
| -2 | `zuzu/common/slack.py:629` | `reply_to` | constant | 22 | 24 | 64 |
| -2 | `zuzu/packages/company/payroll/wht/wht_certificate/services/wht_certificate_excel_writer.py:242` | `tax_amount` | constant | 2 | 4 | 45 |
| -2 | `zuzu/packages/company/payroll/wht/wht_certificate/services/wht_certificate_excel_writer.py:241` | `amount` | constant | 2 | 4 | 101 |
| -2 | `zuzu/packages/tbk/graphql/queries/tax_partner_tbk_seat_usage_list_query.py:57` | `order` | constant | 2 | 4 | 47 |
| -2 | `zuzu/tests/document/base.py:150` | `file_response` | constant | 1 | 3 | 41 |
| -1 | `zuzu/common/slack.py:581` | `on_complete_hooks` | constant | 11 | 12 | 51 |
| -1 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:168` | `ceos` | constant | 2 | 3 | 48 |
| -1 | `zuzu/packages/company/meeting/services/tests/test_meeting_side_effect_service.py:43` | `option` | constant | 3 | 4 | 75 |
| -1 | `zuzu/packages/company/payroll/wht/wht_certificate/services/wht_certificate_excel_writer.py:243` | `payment_date` | constant | 2 | 3 | 62 |
| -1 | `zuzu/packages/corporate_registration/services/content_extract_service/corporate_registration_extraction_result_service.py:406` | `last_item` | constant | 2 | 3 | 42 |
| -1 | `zuzu/packages/option/option_exercise_management/tests/tasks/test_option_exercise_management_reminder_tasks.py:235` | `candidate` | constant | 2 | 3 | 42 |
| -1 | `zuzu/packages/subscription/graphql/mutations/standard/pay_standard_subscription_mutation.py:200` | `subscription_promotion` | constant | 3 | 4 | 43 |
| -1 | `zuzu/packages/subscription/graphql/mutations/standard/pay_standard_subscription_mutation.py:201` | `subscription_contract` | constant | 3 | 4 | 45 |
| -1 | `zuzu/packages/subscription/graphql/mutations/standard/staff_pay_standard_subscription_mutation.py:254` | `subscription_contract` | constant | 3 | 4 | 45 |
| -1 | `zuzu/packages/subscription/graphql/mutations/standard/staff_pay_standard_subscription_mutation.py:253` | `subscription_promotion` | constant | 3 | 4 | 43 |
| -1 | `zuzu/packages/subscription/graphql/mutations/standard/staff_pay_standard_subscription_mutation.py:255` | `subscription_package` | constant | 3 | 4 | 43 |
| -1 | `zuzu/packages/unlisted_stock_management/investment_association/graphql/mutations/staff_create_usm_ia_and_partner_mutation.py:107` | `partner` | constant | 1 | 2 | 70 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| 663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| 527 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 528 | 1 | 527 |
| 472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 | 481 |
| 358 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 367 | 9 | 384 |
| 353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 512 |
| 333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 334 |
| 330 | `zuzu/common/celery/celery.py:8` | `app` | constant | 334 | 4 | 334 |
| 320 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 368 | 48 | 368 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 593 |
| 299 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | `value` | method | 301 | 2 | 288 |
| 294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 294 |
| 271 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 584 | 313 | 584 |
| 255 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | `value` | method | 257 | 2 | 244 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 255 |
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 220 | `zuzu/packages/company/payroll/services/payroll_statement_excel_writer.py:63` | `value` | constant | 220 | 0 | 220 |
| 219 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:10` | `meeting` | constant | 221 | 2 | 229 |
| 219 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:10` | `meeting` | constant | 221 | 2 | 229 |
| 219 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:23` | `meeting` | constant | 226 | 7 | 234 |
| 219 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:23` | `meeting` | constant | 226 | 7 | 234 |
| 218 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:11` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:9` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:11` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:10` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:23` | `meeting` | constant | 225 | 7 | 233 |
| 216 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:422` | `meeting` | constant | 217 | 1 | 225 |
| 216 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:520` | `meeting` | constant | 218 | 2 | 226 |
| 215 | `zuzu/packages/document/base.py:36` | `director_type` | constant | 222 | 7 | 66 |
| 215 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 234 | 19 | 234 |
| 214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 346 |
| 213 | `zuzu/db/models/company/registration_case_report/registration_case_report_update_log.py:64` | `error` | constant | 213 | 0 | 213 |
| 213 | `zuzu/packages/articles_of_incorporation/services/aoi_audit_dump_service.py:153` | `error` | constant | 215 | 2 | 215 |
| 213 | `zuzu/packages/bigquery/notifications/bigquery_error_notification.py:11` | `error` | constant | 214 | 1 | 214 |
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-assignment-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-assignment-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-assignment-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-assignment-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-assignment-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **44.08**
