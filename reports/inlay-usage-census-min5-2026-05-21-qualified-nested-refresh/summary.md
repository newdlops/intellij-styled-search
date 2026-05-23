# Inlay Usage Current Graph Check

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Graph: rebuilt after qualified imported nested type resolution and scoped TypedDict/Unpack loop receiver inference; checked by `graph-symbol-query` JSON join plus `rg` spot verification
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-21-underzero-v2-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25678**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Undercount: **0**
- Missed (usage=0, lsp>0): **0**
- Exact: **1871/25678 = 7.29%**
- Overcount: **23807**
- Usage changed from previous report: **2857**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16806 | 499 | 0 | 0 | 16307 | 2.97% |
| class | 4900 | 979 | 0 | 0 | 3921 | 19.98% |
| method | 2823 | 94 | 0 | 0 | 2729 | 3.33% |
| function | 1149 | 299 | 0 | 0 | 850 | 26.02% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9171 | 35.72% |
| inlay_over_no_lsp_refs | 6622 | 25.79% |
| inlay_over_by_50plus | 5986 | 23.31% |
| inlay_over_by_1-5 | 2028 | 7.90% |
| exact | 1871 | 7.29% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| 663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| 526 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 527 | 1 | 527 |
| 472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 | 481 |
| 375 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 384 | 9 | 384 |
| 353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 512 |
| 333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 334 |
| 331 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 332 | 1 | 337 |
| 330 | `zuzu/common/celery/celery.py:8` | `app` | constant | 334 | 4 | 334 |
| 320 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 368 | 48 | 368 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 593 |
| 294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 294 |
| 286 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | `value` | method | 288 | 2 | 288 |
| 271 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 584 | 313 | 584 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 255 |
| 242 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | `value` | method | 244 | 2 | 244 |
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 220 | `zuzu/packages/company/payroll/services/payroll_statement_excel_writer.py:63` | `value` | constant | 220 | 0 | 220 |
| 219 | `zuzu/db/models/incorporation_request/incorporation_request_director.py:25` | `director_type` | constant | 224 | 5 | 221 |
| 219 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:10` | `meeting` | constant | 221 | 2 | 229 |
| 219 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:10` | `meeting` | constant | 221 | 2 | 229 |
| 219 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:23` | `meeting` | constant | 226 | 7 | 234 |
| 219 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:23` | `meeting` | constant | 226 | 7 | 234 |
| 218 | `zuzu/packages/company/graphql/types/company_list_item_type.py:48` | `director_type` | constant | 218 | 0 | 215 |
| 218 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:11` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/company/meeting/types/meeting_plan_agenda_director_change_for_edit.py:22` | `director_type` | constant | 218 | 0 | 215 |
| 218 | `zuzu/packages/company/meeting/types/meeting_plan_director_attendance_for_edit.py:23` | `director_type` | constant | 218 | 0 | 215 |
| 218 | `zuzu/packages/company/stakeholder/director/types/director_compensation_type.py:71` | `director_type` | constant | 219 | 1 | 216 |
| 218 | `zuzu/packages/company/stakeholder/director/types/director_compensation_type.py:111` | `director_type` | constant | 219 | 1 | 216 |
| 218 | `zuzu/packages/company/stakeholder/director/types/director_term_list_item.py:13` | `director_type` | constant | 219 | 1 | 216 |
| 218 | `zuzu/packages/corporate_registration/auto_updater/types/director_event.py:97` | `director_type` | constant | 222 | 4 | 219 |
| 218 | `zuzu/packages/corporate_registration/graphql/types.py:415` | `director_type` | constant | 219 | 1 | 216 |
| 218 | `zuzu/packages/corporate_registration/services/content_extract_service/corporate_registration_extraction_result_service.py:274` | `director_type` | constant | 222 | 4 | 219 |
| 218 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:9` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:11` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:10` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |
| 218 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:12` | `meeting` | constant | 220 | 2 | 228 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-21-qualified-nested-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-21-qualified-nested-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-21-qualified-nested-refresh/current_id_missing.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-21-qualified-nested-refresh/annotation_base_under_patterns.md`
