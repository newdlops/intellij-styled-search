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
- Exact: **2396/25638 = 9.35%**
- Overcount: **23242**
- Usage changed from previous report: **1318**
- Annotation base check without structural margin: exact **2600/7687 = 33.82%**, under **109**, missed **11**, over **4967**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16780 | 1030 | 0 | 0 | 15750 | 6.14% |
| class | 4900 | 965 | 0 | 0 | 3935 | 19.69% |
| method | 2809 | 95 | 0 | 0 | 2714 | 3.38% |
| function | 1149 | 306 | 0 | 0 | 843 | 26.63% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9572 | 37.34% |
| inlay_over_no_lsp_refs | 6273 | 24.47% |
| inlay_over_by_50plus | 5231 | 20.40% |
| exact | 2396 | 9.35% |
| inlay_over_by_1-5 | 2166 | 8.45% |

## Top Under Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|

## Top Over Counts

| diff | file:line | name | kind | usage | lsp | previous |
|---:|---|---|---|---:|---:|---:|
| 1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 846 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 847 | 1 | 848 |
| 664 | `zuzu/common/factory/base.py:132` | `fake` | function | 670 | 6 | 669 |
| 527 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 528 | 1 | 528 |
| 382 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 391 | 9 | 481 |
| 352 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 511 | 159 | 512 |
| 344 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 353 | 9 | 367 |
| 329 | `zuzu/common/celery/celery.py:8` | `app` | constant | 333 | 4 | 334 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 593 |
| 291 | `zuzu/common/models/protocol.py:11` | `exists` | method | 291 | 0 | 294 |
| 264 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 312 | 48 | 368 |
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
| 217 | `zuzu/packages/corporate_registration/auto_updater/types/director_event.py:28` | `director_type` | constant | 232 | 15 | 204 |
| 217 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:520` | `meeting` | constant | 219 | 2 | 226 |
| 216 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:422` | `meeting` | constant | 217 | 1 | 225 |
| 212 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 344 | 132 | 346 |
| 211 | `zuzu/common/models/protocol.py:9` | `update` | method | 212 | 1 | 211 |
| 211 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 230 | 19 | 234 |
| 208 | `zuzu/app/services/stock_factory_service.py:22` | `registration_number` | constant | 222 | 14 | 136 |
| 208 | `zuzu/common/graphql/paginator.py:26` | `per_page` | constant | 208 | 0 | 64 |
| 203 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 216 | 13 | 216 |
| 197 | `zuzu/packages/user/types/staff_user_details_type.py:36` | `is_staff` | constant | 197 | 0 | 197 |
| 196 | `zuzu/packages/document/base.py:36` | `director_type` | constant | 203 | 7 | 222 |
| 196 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | `meeting` | constant | 203 | 7 | 202 |
| 196 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:34` | `meeting` | constant | 203 | 7 | 202 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-22-conservative-line-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-22-conservative-line-refresh/discrepancies.jsonl`
- Current-id missing: `reports/inlay-usage-census-min5-2026-05-22-conservative-line-refresh/current_id_missing.jsonl`
- Stale cached rows: `reports/inlay-usage-census-min5-2026-05-22-conservative-line-refresh/stale_cached_rows.jsonl`
- Annotation base-under patterns: `reports/inlay-usage-census-min5-2026-05-22-conservative-line-refresh/annotation_base_under_patterns.md`
- Mean absolute diff: **42.18**
