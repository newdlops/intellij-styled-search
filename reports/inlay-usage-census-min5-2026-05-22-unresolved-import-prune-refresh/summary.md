# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: unresolved-import-prune-refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-function-scoped-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25640**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **3**
- Missed (usage=0, lsp>0): **0**
- Exact: **2378/25640 = 9.27%**
- Overcount: **23259**
- Usage changed from previous report: **4241**
- Annotation base check without structural margin: exact **2765/7688 = 35.97%**, under **127**, missed **30**, over **4766**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16782 | 1012 | 0 | 0 | 15770 | 6.03% |
| class | 4900 | 965 | 3 | 0 | 3932 | 19.69% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 306 | 0 | 0 | 843 | 26.63% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9547 | 37.23% |
| inlay_over_no_lsp_refs | 6291 | 24.54% |
| inlay_over_by_50plus | 5261 | 20.52% |
| exact | 2378 | 9.27% |
| inlay_over_by_1-5 | 2160 | 8.42% |
| inlay_under_by_1-5 | 3 | 0.01% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -5 | `zuzu/common/factory/agenda_new_issue_item_factory.py:65` | `AgendaNewIssueItemFactory` | class | 25 | 30 | 30 |
| -1 | `zuzu/packages/document/base.py:57` | `Kind` | class | 28 | 29 | 31 |
| -1 | `zuzu/packages/document/base.py:75` | `Kind` | class | 28 | 29 | 31 |

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
| 327 | `zuzu/common/celery/celery.py:8` | `app` | constant | 331 | 4 | 334 |
| 299 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 589 | 290 | 593 |
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
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |
| 211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 | 234 |
| 210 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 342 | 132 | 346 |
| 206 | `zuzu/packages/company/meeting/types/meeting_plan_director_attendance_for_edit.py:23` | `director_type` | constant | 206 | 0 | 203 |
| 204 | `zuzu/db/models/incorporation_request/incorporation_request_director.py:25` | `director_type` | constant | 209 | 5 | 222 |
| 204 | `zuzu/packages/company/meeting/types/meeting_plan_agenda_director_change_for_edit.py:22` | `director_type` | constant | 204 | 0 | 203 |
| 204 | `zuzu/packages/corporate_registration/services/content_extract_service/corporate_registration_extraction_result_service.py:274` | `director_type` | constant | 208 | 4 | 207 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 203 | `zuzu/packages/company/graphql/types/company_list_item_type.py:48` | `director_type` | constant | 203 | 0 | 216 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-unresolved-import-prune-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-unresolved-import-prune-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-unresolved-import-prune-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-unresolved-import-prune-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-unresolved-import-prune-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **42.66**
