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
- Exact: **2420/25638 = 9.44%**
- Overcount: **23218**
- Usage changed from previous report: **19185**
- Annotation base check without structural margin: exact **3320/7687 = 43.19%**, under **143**, missed **3878**, over **346**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1040 | 0 | 0 | 15740 | 6.20% |
| class | 4900 | 973 | 0 | 0 | 3927 | 19.86% |
| method | 2809 | 103 | 0 | 0 | 2706 | 3.67% |
| function | 1149 | 304 | 0 | 0 | 845 | 26.46% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 13851 | 54.03% |
| inlay_over_no_lsp_refs | 6274 | 24.47% |
| exact | 2420 | 9.44% |
| inlay_over_by_1-5 | 2141 | 8.35% |
| inlay_over_by_50plus | 952 | 3.71% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 324 | `zuzu/common/celery/celery.py:8` | `app` | constant | 328 | 4 | 334 |
| 307 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 597 | 290 | 593 |
| 259 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 307 | 48 | 368 |
| 234 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 265 | 31 | 278 |
| 232 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 545 | 313 | 584 |
| 226 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 226 | 0 | 227 |
| 214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 346 |
| 199 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 212 | 13 | 216 |
| 192 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 193 | 1 | 334 |
| 191 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | `meeting` | constant | 198 | 7 | 202 |
| 191 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:34` | `meeting` | constant | 198 | 7 | 202 |
| 190 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:20` | `meeting` | constant | 192 | 2 | 205 |
| 190 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:20` | `meeting` | constant | 192 | 2 | 205 |
| 190 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:33` | `meeting` | constant | 197 | 7 | 201 |
| 189 | `zuzu/db/models/announcement/announcement.py:136` | `objects` | constant | 216 | 27 | 221 |
| 189 | `zuzu/packages/company/meeting/actions/send_new_issue_notice_email_action.py:18` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/company/meeting/notifications/change_articles_of_incorporation_complete_notification.py:14` | `meeting` | constant | 192 | 3 | 205 |
| 189 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:23` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/company/meeting/notifications/registration_form_captable_edit_notification.py:14` | `meeting` | constant | 190 | 1 | 203 |
| 189 | `zuzu/packages/company/meeting/registration_fee/notifications/heavy_tax_edit_notification.py:16` | `meeting` | constant | 190 | 1 | 203 |
| 189 | `zuzu/packages/investment_association/consent_form_or_meeting/actions/ia_meeting_notice_email_send_action.py:19` | `meeting` | constant | 192 | 3 | 205 |
| 189 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:15` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:13` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:25` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:27` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:27` | `meeting` | constant | 191 | 2 | 204 |
| 189 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:29` | `meeting` | constant | 191 | 2 | 204 |
| 188 | `zuzu/common/factory/registration_assistance_factory.py:11` | `meeting` | constant | 188 | 0 | 201 |
| 187 | `zuzu/common/factory/directors_meeting_agenda_factory.py:11` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/directors_meeting_director_attendance_factory.py:38` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/directors_meeting_factory.py:15` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/registration_factory.py:11` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/self_registration_factory.py:11` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/shareholders_meeting_agenda_factory.py:23` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/shareholders_meeting_director_attendance_factory.py:38` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/shareholders_meeting_factory.py:62` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/common/factory/shareholders_meeting_shareholder_attendance_factory.py:20` | `meeting` | constant | 187 | 0 | 200 |
| 187 | `zuzu/db/models/shareholders_meeting_shareholder_attendance.py:185` | `meeting` | constant | 196 | 9 | 209 |
| 187 | `zuzu/db/models/tests/test_notarization_poa_model.py:36` | `meeting` | constant | 188 | 1 | 201 |
| 187 | `zuzu/packages/company/meeting/document/services/builder/ceo_confirmation_document_builder.py:51` | `meeting` | constant | 187 | 0 | 200 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-method10-constant35-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-method10-constant35-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-method10-constant35-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-method10-constant35-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-method10-constant35-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **30.32**
