# Inlay Usage Current Graph Check

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Graph: rebuilt after ORM fallback filter and safety margin update
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-21-self-scope-typed-field-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25678**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **8**
- Missed (usage=0, lsp>0): **8**
- Exact: **878/25678 = 3.42%**
- Overcount: **24792**
- Usage changed from previous report: **20164**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16806 | 439 | 8 | 8 | 16359 | 2.61% |
| class | 4900 | 257 | 0 | 0 | 4643 | 5.24% |
| method | 2823 | 88 | 0 | 0 | 2735 | 3.12% |
| function | 1149 | 94 | 0 | 0 | 1055 | 8.18% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 10516 | 40.95% |
| inlay_over_no_lsp_refs | 6622 | 25.79% |
| inlay_over_by_50plus | 6023 | 23.46% |
| inlay_over_by_1-5 | 1631 | 6.35% |
| exact | 878 | 3.42% |
| inlay_missed | 8 | 0.03% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -1 | `zuzu/packages/tbk/types.py:73` | `payment_date` | constant | 0 | 1 | 17 |
| -1 | `zuzu/packages/tbk/types.py:74` | `seat_count` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:75` | `average_bookkeeping_price` | constant | 0 | 1 | 8 |
| -1 | `zuzu/packages/tbk/types.py:77` | `monthly_subscription_price` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:86` | `start_date` | constant | 0 | 1 | 10 |
| -1 | `zuzu/packages/tbk/types.py:90` | `average_bookkeeping_price` | constant | 0 | 1 | 8 |
| -1 | `zuzu/packages/tbk/types.py:87` | `end_date` | constant | 0 | 1 | 14 |
| -1 | `zuzu/packages/tbk/types.py:92` | `monthly_subscription_price` | constant | 0 | 1 | 7 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1300 | `zuzu/staff/admin/user.py:139` | `user` | method | 1300 | 0 | 27 |
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| 663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| 527 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 528 | 1 | 654 |
| 472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 | 144 |
| 375 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 384 | 9 | 377 |
| 353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 179 |
| 336 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 337 | 1 | 556 |
| 333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 481 |
| 330 | `zuzu/common/celery/celery.py:8` | `app` | constant | 334 | 4 | 291 |
| 320 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 368 | 48 | 175 |
| 318 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 320 | 2 | 302 |
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

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-21-orm-fallback-margin-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-21-orm-fallback-margin-refresh/discrepancies.jsonl`
