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
- Exact: **2413/25638 = 9.41%**
- Overcount: **23225**
- Usage changed from previous report: **19168**
- Annotation base check without structural margin: exact **3320/7687 = 43.19%**, under **143**, missed **3878**, over **346**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1033 | 0 | 0 | 15747 | 6.16% |
| class | 4900 | 973 | 0 | 0 | 3927 | 19.86% |
| method | 2809 | 103 | 0 | 0 | 2706 | 3.67% |
| function | 1149 | 304 | 0 | 0 | 845 | 26.46% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 13730 | 53.55% |
| inlay_over_no_lsp_refs | 6274 | 24.47% |
| exact | 2413 | 9.41% |
| inlay_over_by_1-5 | 2136 | 8.33% |
| inlay_over_by_50plus | 1085 | 4.23% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 327 | `zuzu/common/celery/celery.py:8` | `app` | constant | 331 | 4 | 334 |
| 307 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 597 | 290 | 593 |
| 262 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 310 | 48 | 368 |
| 237 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 268 | 31 | 278 |
| 235 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 548 | 313 | 584 |
| 226 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 226 | 0 | 227 |
| 214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 346 |
| 199 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 212 | 13 | 216 |
| 194 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | `meeting` | constant | 201 | 7 | 202 |
| 194 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:34` | `meeting` | constant | 201 | 7 | 202 |
| 193 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:20` | `meeting` | constant | 195 | 2 | 205 |
| 193 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:20` | `meeting` | constant | 195 | 2 | 205 |
| 193 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:33` | `meeting` | constant | 200 | 7 | 201 |
| 192 | `zuzu/db/models/announcement/announcement.py:136` | `objects` | constant | 219 | 27 | 221 |
| 192 | `zuzu/packages/company/meeting/actions/send_new_issue_notice_email_action.py:18` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/company/meeting/notifications/change_articles_of_incorporation_complete_notification.py:14` | `meeting` | constant | 195 | 3 | 205 |
| 192 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:23` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/company/meeting/notifications/registration_form_captable_edit_notification.py:14` | `meeting` | constant | 193 | 1 | 203 |
| 192 | `zuzu/packages/company/meeting/registration_fee/notifications/heavy_tax_edit_notification.py:16` | `meeting` | constant | 193 | 1 | 203 |
| 192 | `zuzu/packages/investment_association/consent_form_or_meeting/actions/ia_meeting_notice_email_send_action.py:19` | `meeting` | constant | 195 | 3 | 205 |
| 192 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:15` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:13` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:25` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:27` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:27` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:29` | `meeting` | constant | 194 | 2 | 204 |
| 192 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 193 | 1 | 334 |
| 191 | `zuzu/common/factory/registration_assistance_factory.py:11` | `meeting` | constant | 191 | 0 | 201 |
| 190 | `zuzu/common/factory/directors_meeting_agenda_factory.py:11` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/directors_meeting_director_attendance_factory.py:38` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/directors_meeting_factory.py:15` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/registration_factory.py:11` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/self_registration_factory.py:11` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/shareholders_meeting_agenda_factory.py:23` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/shareholders_meeting_director_attendance_factory.py:38` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/shareholders_meeting_factory.py:62` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/common/factory/shareholders_meeting_shareholder_attendance_factory.py:20` | `meeting` | constant | 190 | 0 | 200 |
| 190 | `zuzu/db/models/shareholders_meeting_shareholder_attendance.py:185` | `meeting` | constant | 199 | 9 | 209 |
| 190 | `zuzu/db/models/tests/test_notarization_poa_model.py:36` | `meeting` | constant | 191 | 1 | 201 |
| 190 | `zuzu/packages/company/meeting/document/services/builder/ceo_confirmation_document_builder.py:51` | `meeting` | constant | 190 | 0 | 200 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-method10-constant38-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-method10-constant38-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-method10-constant38-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-method10-constant38-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-method10-constant38-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **31.24**
