# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: rebuilt after one-line Python header terminal-colon parsing; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-callable-field-return-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25654**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Dropped stale cached rows no longer present in the corrected graph: **24**
- Undercount: **0**
- Missed (usage=0, lsp>0): **0**
- Exact: **1870/25654 = 7.29%**
- Overcount: **23784**
- Usage changed from previous report: **217**
- Annotation base check without structural margin: exact **2835/7684 = 36.89%**, under **107**, missed **31**, over **4711**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16782 | 498 | 0 | 0 | 16284 | 2.97% |
| class | 4900 | 979 | 0 | 0 | 3921 | 19.98% |
| method | 2823 | 94 | 0 | 0 | 2729 | 3.33% |
| function | 1149 | 299 | 0 | 0 | 850 | 26.02% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9149 | 35.66% |
| inlay_over_no_lsp_refs | 6622 | 25.81% |
| inlay_over_by_50plus | 5984 | 23.33% |
| inlay_over_by_1-5 | 2029 | 7.91% |
| exact | 1870 | 7.29% |

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
| 358 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 367 | 9 | 384 |
| 353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 512 |
| 333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 334 |
| 330 | `zuzu/common/celery/celery.py:8` | `app` | constant | 334 | 4 | 334 |
| 320 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 368 | 48 | 368 |
| 316 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 317 | 1 | 330 |
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

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-oneline-header-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-oneline-header-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-oneline-header-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-oneline-header-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-oneline-header-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **44.89**
