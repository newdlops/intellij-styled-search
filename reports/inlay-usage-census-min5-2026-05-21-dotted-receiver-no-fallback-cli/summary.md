# Inlay Usage Accuracy Rerun

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25706**
- Dropped cached LSP symbols missing from current graph: 0
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25706: +/-0.6%
- Current graph usage refresh: changed=3392, missing=0, errors=0

## Usage Signal

- Exact match: **2726/25706 = 10.6%**
- Missing: **0**
- Undercount: **29**
- Overcount: 22951
- Within +/-1: 13.2%
- Within +/-5: 21.9%
- Mean absolute error: 31.08
- Inlay mean: 38.73
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4903 | 34.3 | 0 | 43.5 | 61.2 | 9.90 | 27.89 | 18.00 |
| constant | 16831 | 2.7 | 8 | 3.1 | 3.7 | 41.56 | 45.94 | 4.39 |
| function | 1149 | 8.4 | 0 | 9.2 | 86.8 | 7.63 | 20.36 | 12.73 |
| method | 2823 | 17.2 | 21 | 22.1 | 35.8 | 14.96 | 22.01 | 7.18 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 11741 | 45.7% |
| inlay_over_no_lsp_refs | 6577 | 25.6% |
| inlay_over_by_1-5 | 2775 | 10.8% |
| match | 2726 | 10.6% |
| inlay_over_by_50plus | 1858 | 7.2% |
| inlay_under_by_1-5 | 19 | 0.1% |
| inlay_under_by_6-50 | 8 | 0.0% |
| inlay_missed | 1 | 0.0% |
| inlay_under_by_50plus | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| +526 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 527 | 1 | 654 |
| +471 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 480 | 9 | 144 |
| +349 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 508 | 159 | 179 |
| +333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 481 |
| +328 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 329 | 1 | 556 |
| +325 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 334 | 9 | 377 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 | 291 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 596 |
| +300 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 348 | 48 | 175 |
| +265 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 284 | 19 | 300 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 91 |
| +216 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 218 | 2 | 424 |
| +214 | `zuzu/packages/legal_partner/graphql/mutations/staff_ia_legal_partner_assign_mutation.py:35` | `investment_association` | constant | 216 | 2 | 186 |
| +214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 349 |
| +212 | `zuzu/packages/company/stakeholder/director/graphql/mutations/director_appointment_add_mutation.py:39` | `stakeholder` | constant | 214 | 2 | 210 |
| +212 | `zuzu/packages/payment/payment_link/graphql/mutations/staff_create_ia_payment_link_mutation.py:20` | `investment_association` | constant | 214 | 2 | 182 |
| +211 | `zuzu/packages/company/graphql/types/company_list_item_type.py:121` | `establishment_date` | constant | 211 | 0 | 423 |
| +211 | `zuzu/packages/company/stakeholder/graphql/mutations/create_option_grantee_mutation.py:30` | `stakeholder` | constant | 213 | 2 | 205 |
| +211 | `zuzu/packages/company/stakeholder/graphql/mutations/edit_stakeholder_mutation.py:34` | `stakeholder` | constant | 213 | 2 | 207 |
| +211 | `zuzu/packages/company/stakeholder/graphql/mutations/update_or_create_director_mutation.py:30` | `stakeholder` | constant | 213 | 2 | 205 |
| +211 | `zuzu/packages/company/stakeholder/graphql/mutations/update_or_create_employee_mutation.py:30` | `stakeholder` | constant | 213 | 2 | 205 |
| +211 | `zuzu/packages/company/stakeholder/graphql/mutations/update_or_create_option_grantee_mutation.py:30` | `stakeholder` | constant | 213 | 2 | 205 |
| +211 | `zuzu/packages/company/stakeholder/graphql/mutations/update_or_create_shareholder_mutation.py:30` | `stakeholder` | constant | 213 | 2 | 205 |
| +211 | `zuzu/packages/company/types.py:12` | `establishment_date` | constant | 213 | 2 | 425 |
| +211 | `zuzu/packages/user_invitation/graphql/mutations/user_invitation_cancel_at_stakeholder_list_mutation.py:37` | `stakeholder` | constant | 212 | 1 | 204 |
| +211 | `zuzu/vcm/models/company/vcm_company.py:125` | `establishment_date` | constant | 212 | 1 | 423 |
| +210 | `zuzu/packages/company/stakeholder/employee/bulk_upload/graphql/mutations/delete_stakeholder_for_bulk_mutation.py:26` | `stakeholder` | constant | 212 | 2 | 207 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| -104 | `zuzu/db/models/user/app_user.py:128` | `company_by_id` | method | 104 | 208 | 236 |
| -32 | `zuzu/db/models/site_settings.py:58` | `legal_site_url` | constant | 36 | 68 | 69 |
| -27 | `zuzu/db/models/events/option/option_exercise_event.py:117` | `NEW_SHARE` | constant | 38 | 65 | 67 |
| -18 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:409` | `stocks_at` | method | 21 | 39 | 40 |
| -11 | `zuzu/db/models/modusign/modusign_connectible.py:38` | `CONNECTED` | constant | 4 | 15 | 17 |
| -10 | `zuzu/db/models/stakeholder/director/director_term.py:39` | `director_type_at_base_date` | method | 7 | 17 | 23 |
| -8 | `zuzu/db/models/option/option.py:73` | `IN_GRANT_PROCESS` | constant | 1 | 9 | 9 |
| -6 | `zuzu/db/models/invitation/abstract_user_invitation.py:85` | `ACCEPTED` | constant | 1 | 7 | 7 |
| -6 | `zuzu/db/models/option/option.py:82` | `WITHDREW` | constant | 1 | 7 | 7 |
| -5 | `zuzu/db/models/option/option.py:74` | `GRANTED` | constant | 1 | 6 | 6 |
| -5 | `zuzu/db/models/company/company.py:547` | `purpose_change_at` | method | 1 | 6 | 6 |
| -5 | `zuzu/db/models/company/company.py:952` | `use_co_ceo_system_at` | method | 7 | 12 | 12 |
| -5 | `zuzu/db/models/events/stock/stock_transfer_event.py:131` | `purchaser` | method | 6 | 11 | 15 |
| -5 | `zuzu/db/models/meeting_document/written_statement_document.py:141` | `resolution` | method | 0 | 5 | 10 |
| -5 | `zuzu/db/models/stakeholder/director/director_term.py:175` | `calculated_expected_end_date` | method | 18 | 23 | 25 |
| -3 | `zuzu/db/models/company/company.py:818` | `name_at` | method | 3 | 6 | 11 |
| -3 | `zuzu/db/models/directors_meeting.py:249` | `ceos_to_sign_for_notarization` | method | 4 | 7 | 7 |
| -3 | `zuzu/db/models/meeting_document/ceo_confirmation_document.py:154` | `resolution` | method | 5 | 8 | 15 |
| -2 | `zuzu/db/models/modusign/modusign_connectible.py:39` | `UNASSIGNABLE_ACCOUNT` | constant | 3 | 5 | 7 |
| -2 | `zuzu/db/models/company/company.py:634` | `authorized_shares_at` | method | 4 | 6 | 10 |
| -2 | `zuzu/db/models/directors_meeting.py:199` | `meeting_type_name` | method | 4 | 6 | 6 |
| -2 | `zuzu/db/models/meeting_document/notarization_poa_document.py:305` | `resolution` | method | 9 | 11 | 19 |
| -1 | `zuzu/db/models/company/company.py:1337` | `branches` | method | 7 | 8 | 8 |
| -1 | `zuzu/db/models/company/company.py:1804` | `notification_setting` | method | 10 | 11 | 30 |
| -1 | `zuzu/db/models/meeting_document/notarization_poa_document.py:113` | `default_document_date` | method | 4 | 5 | 6 |
| -1 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:158` | `refund_details` | method | 3 | 4 | 5 |
| -1 | `zuzu/db/models/subscription/subscription.py:1096` | `status` | method | 56 | 57 | 62 |
| -1 | `zuzu/db/models/user/user.py:358` | `update_phone` | method | 6 | 7 | 11 |
| -1 | `zuzu/db/models/venture_capital/portfolio_company.py:160` | `subject_to_reminder` | method | 6 | 7 | 7 |

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-dotted-receiver-no-fallback-cli/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-dotted-receiver-no-fallback-cli/discrepancies.jsonl`
