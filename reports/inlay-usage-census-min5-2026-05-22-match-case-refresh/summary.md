# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: current refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-typeddict-get-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25638**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Dropped stale cached rows no longer present in the corrected graph: **0**
- Undercount: **0**
- Missed (usage=0, lsp>0): **0**
- Exact: **2392/25638 = 9.33%**
- Overcount: **23246**
- Usage changed from previous report: **630**
- Annotation base check without structural margin: exact **2646/7687 = 34.42%**, under **115**, missed **11**, over **4915**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1026 | 0 | 0 | 15754 | 6.11% |
| class | 4900 | 965 | 0 | 0 | 3935 | 19.69% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 306 | 0 | 0 | 843 | 26.63% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9573 | 37.34% |
| inlay_over_no_lsp_refs | 6277 | 24.48% |
| inlay_over_by_50plus | 5242 | 20.45% |
| exact | 2392 | 9.33% |
| inlay_over_by_1-5 | 2154 | 8.40% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 846 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 847 | 1 | 848 |
| 664 | `zuzu/common/factory/base.py:132` | `fake` | function | 670 | 6 | 669 |
| 528 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 529 | 1 | 528 |
| 382 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 391 | 9 | 481 |
| 352 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 511 | 159 | 512 |
| 344 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 353 | 9 | 367 |
| 329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 | 334 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 593 |
| 294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 294 |
| 268 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 316 | 48 | 368 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 255 |
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
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
| 212 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 344 | 132 | 346 |
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |
| 211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 | 234 |
| 210 | `zuzu/app/services/stock_factory_service.py:22` | `registration_number` | constant | 224 | 14 | 136 |
| 208 | `zuzu/common/graphql/paginator.py:26` | `per_page` | constant | 208 | 0 | 64 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 203 | `zuzu/packages/document/base.py:36` | `director_type` | constant | 210 | 7 | 222 |
| 197 | `zuzu/packages/user/types/staff_user_details_type.py:36` | `is_staff` | constant | 197 | 0 | 197 |
| 196 | `zuzu/packages/company/meeting/types/meeting_plan_director_attendance_for_edit.py:23` | `director_type` | constant | 196 | 0 | 203 |
| 196 | `zuzu/packages/corporate_registration/services/content_extract_service/corporate_registration_extraction_result_service.py:274` | `director_type` | constant | 200 | 4 | 207 |
| 196 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | `meeting` | constant | 203 | 7 | 202 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-match-case-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-match-case-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-match-case-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-match-case-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-match-case-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **42.26**
