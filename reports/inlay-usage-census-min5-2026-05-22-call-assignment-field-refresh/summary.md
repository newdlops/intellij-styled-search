# Inlay Usage Current Graph Check

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Graph: current refresh; checked by `graph-symbol-query` JSON join and source-file `rg` spot checks
- Source refreshed rows: `reports/inlay-usage-census-min5-2026-05-22-positional-constructor-refresh/lsp_usage_results_refreshed.jsonl`
- Present rows: **25638**
- Semantic missing carried from source remap: **28**
- Current-id missing during refresh: **0**
- Dropped stale cached rows no longer present in the corrected graph: **0**
- Undercount: **32**
- Missed (usage=0, lsp>0): **2**
- Exact: **2985/25638 = 11.64%**
- Overcount: **22621**
- Usage changed from previous report: **10728**
- Annotation base check without structural margin: exact **3318/7687 = 43.16%**, under **149**, missed **3867**, over **353**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1613 | 32 | 2 | 15135 | 9.61% |
| class | 4900 | 973 | 0 | 0 | 3927 | 19.86% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 304 | 0 | 0 | 845 | 26.46% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 13222 | 51.57% |
| inlay_over_no_lsp_refs | 5910 | 23.05% |
| exact | 2985 | 11.64% |
| inlay_over_by_1-5 | 2261 | 8.82% |
| inlay_over_by_50plus | 1228 | 4.79% |
| inlay_under | 30 | 0.12% |
| inlay_missed | 2 | 0.01% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| -30 | `zuzu/packages/corporate_registration/xml_parser/types/xml_parser_corporate_registration.py:21` | `XmlParserCorporateRegistration` | constant | 20 | 50 | 60 |
| -19 | `zuzu/common/requests/api.py:46` | `post` | constant | 3 | 22 | 60 |
| -10 | `zuzu/common/factory/subscription/subscription_plan_factory.py:24` | `perk` | constant | 11 | 21 | 78 |
| -3 | `zuzu/common/requests/api.py:42` | `request` | constant | 3 | 6 | 82 |
| -2 | `zuzu/db/models/agenda/financial_statements/agenda_financial_statements.py:51` | `end_date` | constant | 3 | 5 | 53 |
| -2 | `zuzu/packages/convocation/graphql/types.py:22` | `referrer_emails` | constant | 2 | 4 | 45 |
| -2 | `zuzu/packages/investment_simulation/services/types.py:45` | `purchases` | constant | 4 | 6 | 48 |
| -1 | `zuzu/app/graphql/types/director_input.py:5` | `director_id` | constant | 0 | 1 | 43 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:7` | `share_class_id` | constant | 3 | 4 | 49 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:8` | `kind` | constant | 4 | 5 | 48 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:11` | `is_redeemable` | constant | 4 | 5 | 50 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:10` | `voting_rights` | constant | 4 | 5 | 46 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:12` | `redemption_start_date` | constant | 4 | 5 | 46 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:13` | `redemption_end_date` | constant | 4 | 5 | 47 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:15` | `redemption_interest_rate` | constant | 4 | 5 | 45 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:14` | `redemption_method` | constant | 4 | 5 | 47 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:16` | `fixed_redemption_value` | constant | 4 | 5 | 47 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:18` | `conversion_start_date` | constant | 4 | 5 | 47 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:19` | `conversion_end_date` | constant | 4 | 5 | 46 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:20` | `conversion_price` | constant | 4 | 5 | 46 |
| -1 | `zuzu/app/graphql/types/share_class_input.py:21` | `conversion_ratio` | constant | 4 | 5 | 44 |
| -1 | `zuzu/app/settings.py:26` | `ZUZU_SERVICE` | constant | 1 | 2 | 41 |
| -1 | `zuzu/common/factory/modusign/modusign_document_participant_factory.py:28` | `modusign_document` | constant | 0 | 1 | 43 |
| -1 | `zuzu/common/management/commands/generate_pages_stub.py:30` | `T` | constant | 5 | 6 | 46 |
| -1 | `zuzu/common/requests/api.py:45` | `head` | constant | 3 | 4 | 43 |
| -1 | `zuzu/common/settings/alpha.py:41` | `PIPEDRIVE_ZUZU_DOMAIN` | constant | 7 | 8 | 47 |
| -1 | `zuzu/common/settings/production.py:41` | `PIPEDRIVE_ZUZU_DOMAIN` | constant | 7 | 8 | 47 |
| -1 | `zuzu/db/models/captable.py:55` | `total_shares` | constant | 1 | 2 | 43 |
| -1 | `zuzu/db/models/captable.py:56` | `common_shares` | constant | 1 | 2 | 43 |
| -1 | `zuzu/db/models/captable.py:54` | `stocks_by_class` | constant | 3 | 4 | 44 |
| -1 | `zuzu/packages/investment_simulation/services/types.py:42` | `new_issues` | constant | 12 | 13 | 54 |
| -1 | `zuzu/staff/settings.py:27` | `ZUZU_SERVICE` | constant | 1 | 2 | 41 |

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 307 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 597 | 290 | 593 |
| 289 | `zuzu/common/celery/celery.py:8` | `app` | constant | 293 | 4 | 334 |
| 280 | `zuzu/common/models/protocol.py:11` | `exists` | method | 280 | 0 | 294 |
| 264 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 312 | 48 | 368 |
| 239 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | `meeting` | constant | 270 | 31 | 278 |
| 237 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | `meeting` | constant | 550 | 313 | 584 |
| 227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 227 |
| 214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 346 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 200 | `zuzu/common/models/protocol.py:9` | `update` | method | 201 | 1 | 211 |
| 196 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | `meeting` | constant | 203 | 7 | 202 |
| 196 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:34` | `meeting` | constant | 203 | 7 | 202 |
| 195 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:20` | `meeting` | constant | 197 | 2 | 205 |
| 195 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:20` | `meeting` | constant | 197 | 2 | 205 |
| 195 | `zuzu/packages/self_registration/actions/self_registration_paid_action.py:33` | `meeting` | constant | 202 | 7 | 201 |
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
| 192 | `zuzu/db/models/shareholders_meeting_shareholder_attendance.py:185` | `meeting` | constant | 201 | 9 | 209 |
| 192 | `zuzu/db/models/tests/test_notarization_poa_model.py:36` | `meeting` | constant | 193 | 1 | 201 |
| 192 | `zuzu/packages/company/meeting/document/services/builder/ceo_confirmation_document_builder.py:51` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/packages/company/meeting/document/services/builder/notarization_poa_document_builder.py:53` | `meeting` | constant | 198 | 6 | 206 |
| 192 | `zuzu/packages/company/meeting/document/services/builder/written_statement_document_builder.py:41` | `meeting` | constant | 192 | 0 | 200 |
| 192 | `zuzu/packages/convocation/tests/fixtures.py:35` | `meeting` | constant | 198 | 6 | 206 |
| 192 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:52` | `meeting` | constant | 193 | 1 | 201 |
| 192 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/edit_consent_form_or_meeting_mutation.py:38` | `meeting` | constant | 193 | 1 | 201 |
| 192 | `zuzu/packages/user_activity/types.py:13` | `RSU` | constant | 195 | 3 | 195 |
| 192 | `zuzu/tests/document/meeting_document/test_meeting_document_view.py:43` | `meeting` | constant | 197 | 5 | 205 |
| 192 | `zuzu/tests/document/meeting_document/test_shareholders_meeting_power_of_attorney_individual_document.py:106` | `meeting` | constant | 197 | 5 | 205 |
| 192 | `zuzu/tests/document/test_meeting_document_options_edit_mutation.py:36` | `meeting` | constant | 195 | 3 | 203 |
| 192 | `zuzu/tests/meeting/mutations/test_shareholders_meeting_minutes_edit.py:130` | `meeting` | constant | 196 | 4 | 204 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-call-assignment-field-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-call-assignment-field-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-call-assignment-field-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-call-assignment-field-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-call-assignment-field-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **29.87**
