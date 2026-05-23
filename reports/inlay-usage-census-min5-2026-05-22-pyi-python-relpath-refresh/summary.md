# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: current refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-positional-constructor-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25638**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Dropped stale cached rows no longer present in the corrected graph: **0**
- Undercount: **0**
- Missed (usage=0, lsp>0): **0**
- Exact: **2405/25638 = 9.38%**
- Overcount: **23233**
- Usage changed from previous report: **2878**
- Annotation base check without structural margin: exact **2614/7687 = 34.01%**, under **108**, missed **11**, over **4954**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1041 | 0 | 0 | 15739 | 6.20% |
| class | 4900 | 965 | 0 | 0 | 3935 | 19.69% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 304 | 0 | 0 | 845 | 26.46% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9627 | 37.55% |
| inlay_over_no_lsp_refs | 6262 | 24.42% |
| inlay_over_by_50plus | 5222 | 20.37% |
| exact | 2405 | 9.38% |
| inlay_over_by_1-5 | 2122 | 8.28% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 382 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 391 | 9 | 481 |
| 352 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 511 | 159 | 512 |
| 329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 | 334 |
| 307 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 597 | 290 | 593 |
| 274 | `zuzu/common/models/protocol.py:11` | `exists` | method | 274 | 0 | 294 |
| 264 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 312 | 48 | 368 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 255 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 217 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 248 | 31 | 278 |
| 214 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 223 | 9 | 367 |
| 214 | `zuzu/packages/corporate_registration/auto_updater/types/director_event.py:28` | `director_type` | constant | 229 | 15 | 204 |
| 213 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 345 | 132 | 346 |
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |
| 211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 | 234 |
| 208 | `zuzu/common/graphql/paginator.py:26` | `per_page` | constant | 208 | 0 | 64 |
| 204 | `zuzu/app/services/stock_factory_service.py:22` | `registration_number` | constant | 218 | 14 | 136 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 198 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:23` | `meeting` | constant | 205 | 7 | 226 |
| 198 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:23` | `meeting` | constant | 205 | 7 | 226 |
| 197 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:10` | `meeting` | constant | 199 | 2 | 229 |
| 197 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:10` | `meeting` | constant | 199 | 2 | 229 |
| 197 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:23` | `meeting` | constant | 204 | 7 | 225 |
| 197 | `zuzu/packages/user/types/staff_user_details_type.py:36` | `is_staff` | constant | 197 | 0 | 197 |
| 196 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:11` | `meeting` | constant | 198 | 2 | 228 |
| 196 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:9` | `meeting` | constant | 198 | 2 | 228 |
| 196 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:11` | `meeting` | constant | 198 | 2 | 228 |
| 196 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:10` | `meeting` | constant | 198 | 2 | 228 |
| 196 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:12` | `meeting` | constant | 198 | 2 | 228 |
| 196 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:12` | `meeting` | constant | 198 | 2 | 228 |
| 196 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:12` | `meeting` | constant | 198 | 2 | 228 |
| 195 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:520` | `meeting` | constant | 197 | 2 | 226 |
| 194 | `zuzu/db/models/announcement/announcement.py:136` | `objects` | constant | 221 | 27 | 221 |
| 194 | `zuzu/packages/document/base.py:36` | `director_type` | constant | 201 | 7 | 222 |
| 194 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:422` | `meeting` | constant | 195 | 1 | 225 |
| 192 | `zuzu/packages/user_activity/types.py:13` | `RSU` | constant | 195 | 3 | 195 |
| 190 | `zuzu/packages/option/tests/services/test_vesting_traceable_create_service_data.py:19` | `quantity` | constant | 198 | 8 | 199 |
| 186 | `zuzu/packages/company/meeting/types/meeting_plan_director_attendance_for_edit.py:23` | `director_type` | constant | 186 | 0 | 203 |
| 186 | `zuzu/packages/corporate_registration/services/content_extract_service/corporate_registration_extraction_result_service.py:274` | `director_type` | constant | 190 | 4 | 207 |
| 186 | `zuzu/packages/ibk/views/api/response/bad_request.py:5` | `status_code` | constant | 186 | 0 | 186 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-pyi-python-relpath-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-pyi-python-relpath-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-pyi-python-relpath-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-pyi-python-relpath-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-pyi-python-relpath-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **41.79**
