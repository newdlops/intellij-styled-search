# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: import-alias-all-refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25640**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **0**
- Missed (usage=0, lsp>0): **0**
- Exact: **2374/25640 = 9.26%**
- Overcount: **23266**
- Usage changed from previous report: **4182**
- Annotation base check without structural margin: exact **2765/7688 = 35.97%**, under **127**, missed **30**, over **4766**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16782 | 1012 | 0 | 0 | 15770 | 6.03% |
| class | 4900 | 961 | 0 | 0 | 3939 | 19.61% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 306 | 0 | 0 | 843 | 26.63% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9545 | 37.23% |
| inlay_over_no_lsp_refs | 6291 | 24.54% |
| inlay_over_by_50plus | 5260 | 20.51% |
| exact | 2374 | 9.26% |
| inlay_over_by_1-5 | 2170 | 8.46% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

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
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 222 | `zuzu/app/services/stock_factory_service.py:22` | `registration_number` | constant | 236 | 14 | 136 |
| 220 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:23` | `meeting` | constant | 227 | 7 | 226 |
| 220 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:23` | `meeting` | constant | 227 | 7 | 226 |
| 219 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:10` | `meeting` | constant | 221 | 2 | 229 |
| 219 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:10` | `meeting` | constant | 221 | 2 | 229 |
| 219 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:23` | `meeting` | constant | 226 | 7 | 225 |
| 218 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:11` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:9` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:11` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:10` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 216 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:422` | `meeting` | constant | 217 | 1 | 225 |
| 216 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:520` | `meeting` | constant | 218 | 2 | 226 |
| 215 | `zuzu/packages/document/base.py:36` | `director_type` | constant | 222 | 7 | 66 |
| 212 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 344 | 132 | 346 |
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |
| 211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 | 234 |
| 206 | `zuzu/packages/company/meeting/types/meeting_plan_director_attendance_for_edit.py:23` | `director_type` | constant | 206 | 0 | 203 |
| 204 | `zuzu/db/models/incorporation_request/incorporation_request_director.py:25` | `director_type` | constant | 209 | 5 | 222 |
| 204 | `zuzu/packages/company/meeting/types/meeting_plan_agenda_director_change_for_edit.py:22` | `director_type` | constant | 204 | 0 | 203 |
| 204 | `zuzu/packages/corporate_registration/services/content_extract_service/corporate_registration_extraction_result_service.py:274` | `director_type` | constant | 208 | 4 | 207 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 203 | `zuzu/packages/company/graphql/types/company_list_item_type.py:48` | `director_type` | constant | 203 | 0 | 216 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-import-alias-all-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-import-alias-all-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-import-alias-all-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-import-alias-all-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-import-alias-all-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **42.65**
