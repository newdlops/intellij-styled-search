# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: current refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-positional-constructor-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25638**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Dropped stale cached rows no longer present in the corrected graph: **0**
- Undercount: **1**
- Missed (usage=0, lsp>0): **0**
- Exact: **2401/25638 = 9.37%**
- Overcount: **23236**
- Usage changed from previous report: **9700**
- Annotation base check without structural margin: exact **3325/7687 = 43.25%**, under **130**, missed **3893**, over **339**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1029 | 1 | 0 | 15750 | 6.13% |
| class | 4900 | 973 | 0 | 0 | 3927 | 19.86% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 304 | 0 | 0 | 845 | 26.46% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 13567 | 52.92% |
| inlay_over_no_lsp_refs | 6274 | 24.47% |
| exact | 2401 | 9.37% |
| inlay_over_by_1-5 | 2128 | 8.30% |
| inlay_over_by_50plus | 1267 | 4.94% |
| inlay_under | 1 | 0.00% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -1 | `zuzu/packages/ms_word/services/utils/types.py:62` | `paragraph_format` | constant | 98 | 99 | 131 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 | 334 |
| 307 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 597 | 290 | 593 |
| 264 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 312 | 48 | 368 |
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 346 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 196 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | `meeting` | constant | 203 | 7 | 202 |
| 196 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:34` | `meeting` | constant | 203 | 7 | 202 |
| 195 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:20` | `meeting` | constant | 197 | 2 | 205 |
| 195 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:20` | `meeting` | constant | 197 | 2 | 205 |
| 195 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:33` | `meeting` | constant | 202 | 7 | 201 |
| 194 | `zuzu/db/models/announcement/announcement.py:136` | `objects` | constant | 221 | 27 | 221 |
| 194 | `zuzu/packages/company/meeting/actions/send_new_issue_notice_email_action.py:18` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/company/meeting/notifications/change_articles_of_incorporation_complete_notification.py:14` | `meeting` | constant | 197 | 3 | 205 |
| 194 | `zuzu/packages/company/meeting/notifications/meeting_edit_notification.py:23` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/company/meeting/notifications/registration_form_captable_edit_notification.py:14` | `meeting` | constant | 195 | 1 | 203 |
| 194 | `zuzu/packages/company/meeting/registration_fee/notifications/heavy_tax_edit_notification.py:16` | `meeting` | constant | 195 | 1 | 203 |
| 194 | `zuzu/packages/investment_association/consent_form_or_meeting/actions/ia_meeting_notice_email_send_action.py:19` | `meeting` | constant | 197 | 3 | 205 |
| 194 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_canceled_slack_notification.py:15` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/registration/notification/unpaid_registration_assistance_request_slack_notification.py:13` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_note_edit_notification.py:25` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_progress_status_update_notification.py:27` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_status_update_notification.py:27` | `meeting` | constant | 196 | 2 | 204 |
| 194 | `zuzu/packages/registration_assistance/notifications/legal_registration_assistance_tax_and_fee_payment_status_update_notification.py:29` | `meeting` | constant | 196 | 2 | 204 |
| 193 | `zuzu/common/factory/registration_assistance_factory.py:11` | `meeting` | constant | 193 | 0 | 201 |
| 192 | `zuzu/common/factory/directors_meeting_agenda_factory.py:11` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/directors_meeting_director_attendance_factory.py:38` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/directors_meeting_factory.py:15` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/registration_factory.py:11` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/self_registration_factory.py:11` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/shareholders_meeting_agenda_factory.py:23` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/shareholders_meeting_director_attendance_factory.py:38` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/shareholders_meeting_factory.py:62` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/common/factory/shareholders_meeting_shareholder_attendance_factory.py:20` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/db/models/shareholders_meeting_shareholder_attendance.py:185` | `meeting` | constant | 201 | 9 | 209 |
| 192 | `zuzu/db/models/tests/test_notarization_poa_model.py:36` | `meeting` | constant | 193 | 1 | 201 |
| 192 | `zuzu/packages/company/meeting/document/services/builder/ceo_confirmation_document_builder.py:51` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/packages/company/meeting/document/services/builder/notarization_poa_document_builder.py:53` | `meeting` | constant | 198 | 6 | 206 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-structural-margin30-protocol-filter-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-structural-margin30-protocol-filter-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-structural-margin30-protocol-filter-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-structural-margin30-protocol-filter-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-structural-margin30-protocol-filter-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **31.80**
