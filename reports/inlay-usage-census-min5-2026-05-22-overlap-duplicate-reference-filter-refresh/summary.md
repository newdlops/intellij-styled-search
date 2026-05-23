# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: current refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-positional-constructor-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25638**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Dropped stale cached rows no longer present in the corrected graph: **0**
- Undercount: **12**
- Missed (usage=0, lsp>0): **0**
- Exact: **2427/25638 = 9.47%**
- Overcount: **23199**
- Usage changed from previous report: **9743**
- Annotation base check without structural margin: exact **3320/7687 = 43.19%**, under **143**, missed **3878**, over **346**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1030 | 0 | 0 | 15750 | 6.14% |
| class | 4900 | 998 | 12 | 0 | 3890 | 20.37% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 304 | 0 | 0 | 845 | 26.46% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 13506 | 52.68% |
| inlay_over_no_lsp_refs | 6274 | 24.47% |
| exact | 2427 | 9.47% |
| inlay_over_by_1-5 | 2142 | 8.35% |
| inlay_over_by_50plus | 1277 | 4.98% |
| inlay_under | 12 | 0.05% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -271 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 19 | 290 | 593 |
| -121 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 11 | 132 | 346 |
| -60 | `zuzu/db/models/subscription/subscription_perk.py:172` | `PerkMethod` | class | 28 | 88 | 181 |
| -12 | `zuzu/db/models/meeting/meeting.py:919` | `RegistrationStatus` | class | 23 | 35 | 67 |
| -10 | `zuzu/db/models/corporate_registration/corporate_registration_change_detection_parse_result.py:36` | `DocumentUploadStatus` | class | 19 | 29 | 62 |
| -7 | `zuzu/packages/document/base.py:51` | `NextAction` | class | 48 | 55 | 82 |
| -4 | `zuzu/db/models/subscription/subscription_plan.py:72` | `RenewType` | class | 30 | 34 | 99 |
| -3 | `zuzu/db/models/company/electronic_certificate/electronic_certificate.py:57` | `MediaHolderChoices` | class | 31 | 34 | 65 |
| -1 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:162` | `CapitalSource` | class | 45 | 46 | 90 |
| -1 | `zuzu/db/models/bulk_email/bulk_email_recipient.py:107` | `Status` | class | 16 | 17 | 23 |
| -1 | `zuzu/db/models/meeting/meeting.py:813` | `Status` | class | 25 | 26 | 38 |
| -1 | `zuzu/db/models/modusign/modusign_document_action_history.py:119` | `Status` | class | 117 | 118 | 137 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 | 334 |
| 264 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 312 | 48 | 368 |
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
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
| 192 | `zuzu/packages/company/meeting/document/services/builder/written_statement_document_builder.py:41` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/packages/convocation/tests/fixtures.py:35` | `meeting` | constant | 198 | 6 | 206 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-overlap-duplicate-reference-filter-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-overlap-duplicate-reference-filter-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-overlap-duplicate-reference-filter-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-overlap-duplicate-reference-filter-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-overlap-duplicate-reference-filter-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **32.06**
