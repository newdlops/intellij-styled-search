# Inlay Usage Current Graph Check

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- zoek-rs: `target/release/zoek-rs` rebuilt before this check
- Graph: rebuilt with `graph-rebuild /Users/lky/project/captain`
- LSP source: `reports/inlay-usage-census-min5-2026-05-21-simple-value-base-margin-cli/lsp_usage_results_refreshed.jsonl`
- Total cached LSP rows: **25706**
- Present after semantic remap: **25678**
- Strict symbolId matches: **25260**
- Semantic remaps: **418**
- Semantic missing: **28**
- Undercount: **40**
- Missed (usage=0, lsp>0): **10**
- Exact: **2274/25678 = 8.86%**
- Overcount: **23364**
- Usage changed from cached row: **19441**

## Per Kind

| kind | n | exact | under | missed | over | exact% |
|---|---:|---:|---:|---:|---:|---:|
| constant | 16806 | 439 | 24 | 9 | 16343 | 2.61% |
| class | 4900 | 1450 | 11 | 0 | 3439 | 29.59% |
| method | 2823 | 291 | 5 | 1 | 2527 | 10.31% |
| function | 1149 | 94 | 0 | 0 | 1055 | 8.18% |

## Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 12797 | 49.84% |
| inlay_over_no_lsp_refs | 6617 | 25.77% |
| inlay_over_by_1-5 | 2486 | 9.68% |
| exact | 2274 | 8.86% |
| inlay_over_by_50plus | 1464 | 5.70% |
| inlay_under | 30 | 0.12% |
| inlay_missed | 10 | 0.04% |

## Top Under Counts

| diff | file:line | current line | name | kind | usage | lsp | previous |
|---:|---|---:|---|---|---:|---:|---:|
| -46 | `zuzu/packages/ms_word/services/utils/types.py:62` | 62 | `paragraph_format` | constant | 53 | 99 | 109 |
| -33 | `zuzu/packages/investment_association/owner/graphql/decorators/investment_association_owner_required.py:15` | 15 | `investment_association` | constant | 117 | 150 | 194 |
| -25 | `zuzu/packages/ms_word/services/utils/types.py:68` | 68 | `paragraphs` | constant | 27 | 52 | 80 |
| -25 | `zuzu/packages/vcm/investor/contexts.py:12` | 12 | `investor_gp` | constant | 33 | 58 | 61 |
| -23 | `zuzu/packages/vcm/investor/contexts.py:8` | 8 | `investor` | constant | 69 | 92 | 121 |
| -22 | `zuzu/common/factory/agenda_new_issue_item_factory.py:65` | 65 | `AgendaNewIssueItemFactory` | class | 8 | 30 | 30 |
| -21 | `zuzu/packages/ms_word/services/utils/types.py:60` | 60 | `add_run` | constant | 43 | 64 | 73 |
| -18 | `zuzu/packages/hrm/portal/contexts.py:6` | 6 | `emp` | constant | 69 | 87 | 123 |
| -17 | `zuzu/db/models/directors_meeting_agenda.py:366` | 366 | `child` | method | 48 | 65 | 74 |
| -17 | `zuzu/db/models/shareholders_meeting_agenda.py:581` | 581 | `child` | method | 50 | 67 | 75 |
| -15 | `zuzu/db/models/registration_agenda.py:116` | 116 | `child` | method | 34 | 49 | 69 |
| -7 | `zuzu/common/factory/question_thread_factory.py:10` | 10 | `QuestionThreadFactory` | class | 10 | 17 | 18 |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:84` | 84 | `cells` | constant | 25 | 31 | 48 |
| -4 | `zuzu/packages/ms_word/services/utils/types.py:98` | 98 | `rows` | constant | 27 | 31 | 42 |
| -3 | `zuzu/packages/ms_word/services/utils/types.py:29` | 29 | `font` | constant | 22 | 25 | 37 |
| -3 | `zuzu/packages/unlisted_stock_management/graphql/mutations/mixins/individual_investor_company_validation_mixin.py:50` | 50 | `IndividualInvestorCompanyInfoCeoInputErrors` | class | 6 | 9 | 9 |
| -2 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:83` | 83 | `ceo_set` | constant | 26 | 28 | 36 |
| -2 | `zuzu/db/models/stakeholder/stakeholder.py:59` | 59 | `registration_number` | constant | 161 | 163 | 145 |
| -2 | `zuzu/db/models/stakeholder/stakeholder.py:246` | 246 | `registration_number` | constant | 161 | 163 | 145 |
| -2 | `zuzu/db/models/stakeholder/stakeholder.py:265` | 265 | `registration_number` | constant | 161 | 163 | 145 |
| -2 | `zuzu/packages/corporate_registration/auto_updater/types/branch_change.py:9` | 9 | `note` | constant | 43 | 45 | 63 |
| -2 | `zuzu/packages/address_information/address_information_service.py:152` | 152 | `is_overpopulated_area` | method | 5 | 7 | 8 |
| -2 | `zuzu/packages/unlisted_stock_management/graphql/mutations/mixins/individual_investor_company_validation_mixin.py:36` | 36 | `IndividualInvestorCompanyShareStockInputErrors` | class | 6 | 8 | 8 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/base/fi_sta_document_base_mutation.py:26` | 26 | `document_class` | constant | 0 | 1 | 21 |
| -1 | `zuzu/packages/tbk/types.py:73` | 37 | `payment_date` | constant | 0 | 1 | 17 |
| -1 | `zuzu/packages/tbk/types.py:74` | 38 | `seat_count` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:75` | 39 | `average_bookkeeping_price` | constant | 0 | 1 | 8 |
| -1 | `zuzu/packages/tbk/types.py:77` | 41 | `monthly_subscription_price` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:86` | 48 | `start_date` | constant | 0 | 1 | 10 |
| -1 | `zuzu/packages/tbk/types.py:90` | 57 | `average_bookkeeping_price` | constant | 0 | 1 | 8 |
| -1 | `zuzu/packages/tbk/types.py:87` | 49 | `end_date` | constant | 0 | 1 | 14 |
| -1 | `zuzu/packages/tbk/types.py:92` | 59 | `monthly_subscription_price` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/option/services/option_list_export_service/option_grant_status_detail_excel_writer.py:559` | 559 | `sort_key` | method | 0 | 1 | 11 |
| -1 | `zuzu/db/models/meeting_document/directors_meeting_skip_notice_document.py:29` | 29 | `DirectorsMeetingSkipNoticeDocument` | class | 18 | 19 | 18 |
| -1 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:26` | 26 | `NewIssueStockAcceptanceDocument` | class | 11 | 12 | 11 |
| -1 | `zuzu/db/models/meeting_document/new_issue_stock_allocation_document.py:30` | 30 | `NewIssueStockAllocationDocument` | class | 16 | 17 | 16 |
| -1 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:21` | 21 | `NewIssueStockUnissuedConfirmationDocument` | class | 11 | 12 | 11 |
| -1 | `zuzu/db/models/meeting_document/new_issue_stock_subscription_document.py:28` | 28 | `NewIssueStockSubscriptionDocument` | class | 23 | 24 | 25 |
| -1 | `zuzu/packages/document/document_types/electronic_certificate_application_form_company_document.py:16` | 16 | `ElectronicCertificateApplicationFormCompanyDocument` | class | 6 | 7 | 6 |
| -1 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/consent_form_or_meeting_validation_mixin.py:28` | 28 | `IaConsentFormOrMeetingInputErrors` | class | 9 | 10 | 10 |

## Top Over Counts

| diff | file:line | current line | name | kind | usage | lsp | previous |
|---:|---|---:|---|---|---:|---:|---:|
| 1311 | `zuzu/db/models/user/api_key/user_api_key.py:43` | 43 | `user` | method | 1311 | 0 | 27 |
| 1300 | `zuzu/staff/admin/user.py:139` | 139 | `user` | method | 1300 | 0 | 27 |
| 1149 | `zuzu/app/pages.py:14` | 14 | `get_app_page_path` | function | 1149 | 0 | 1149 |
| 847 | `zuzu/common/factory/base.py:53` | 53 | `DjangoModelFactory` | class | 848 | 1 | 848 |
| 663 | `zuzu/common/factory/base.py:132` | 132 | `fake` | function | 669 | 6 | 669 |
| 527 | `zuzu/common/models/big_number_field.py:6` | 6 | `BigNumberField` | class | 528 | 1 | 654 |
| 472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | 4 | `Template` | class | 481 | 9 | 144 |
| 375 | `zuzu/common/models/fixed_inheritance.py:22` | 22 | `annotate` | method | 384 | 9 | 377 |
| 353 | `zuzu/packages/notification/email/email_template.py:6` | 6 | `Template` | class | 512 | 159 | 179 |
| 336 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | 570 | `director_type` | function | 337 | 1 | 556 |
| 333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | 178 | `Manager` | class | 334 | 1 | 481 |
| 325 | `zuzu/common/celery/celery.py:8` | 8 | `app` | constant | 329 | 4 | 291 |
| 318 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | 40 | `add` | method | 320 | 2 | 302 |
| 315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | 100 | `shareholders_meeting` | constant | 363 | 48 | 175 |
| 303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | 67 | `Role` | class | 593 | 290 | 596 |
| 294 | `zuzu/common/models/protocol.py:11` | 11 | `exists` | method | 294 | 0 | 468 |
| 266 | `zuzu/db/models/meeting_document/base/meeting_document.py:92` | 92 | `meeting` | constant | 579 | 313 | 492 |
| 264 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:31` | 31 | `value` | method | 266 | 2 | 289 |
| 254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | 226 | `replace` | method | 255 | 1 | 270 |
| 242 | `zuzu/packages/company/meeting/services/meeting_execution_service/__init__.py:227` | 227 | `meeting` | constant | 273 | 31 | 160 |
| 242 | `zuzu/db/models/investor_relations/deprecated/secondary_deal/value_with_visibility/value_with_visibility.py:35` | 35 | `value` | method | 244 | 2 | 289 |
| 227 | `zuzu/common/models/purchasable.py:122` | 122 | `get_queryset` | method | 227 | 0 | 91 |
| 215 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | 53 | `Type` | class | 234 | 19 | 300 |
| 214 | `zuzu/db/models/subscription/subscription_plan.py:64` | 64 | `Name` | class | 346 | 132 | 349 |
| 210 | `zuzu/common/models/protocol.py:9` | 9 | `update` | method | 211 | 1 | 236 |
| 208 | `zuzu/db/models/company/registration_case_report/registration_case_report_update_log.py:64` | 64 | `error` | constant | 208 | 0 | 182 |
| 208 | `zuzu/packages/articles_of_incorporation/services/aoi_audit_dump_service.py:153` | 153 | `error` | constant | 210 | 2 | 184 |
| 208 | `zuzu/packages/bigquery/notifications/bigquery_error_notification.py:11` | 11 | `error` | constant | 209 | 1 | 183 |
| 207 | `zuzu/db/models/meeting_document/iros_otp_issue_meeting_document.py:66` | 66 | `meeting` | constant | 209 | 2 | 135 |
| 206 | `zuzu/packages/company/payroll/year_end_tax_settlement/types/bulk_send_yets_help_types.py:11` | 11 | `error` | constant | 209 | 3 | 183 |
| 202 | `zuzu/tests/meeting/test_meeting_query.py:46` | 46 | `meeting` | constant | 204 | 2 | 101 |
| 202 | `zuzu/tests/meeting/test_meeting_query.py:133` | 133 | `meeting` | constant | 204 | 2 | 101 |
| 201 | `zuzu/tests/meeting/test_meeting_query.py:84` | 84 | `meeting` | constant | 204 | 3 | 101 |
| 200 | `zuzu/db/models/registration.py:36` | 36 | `meeting` | constant | 211 | 11 | 109 |
| 199 | `zuzu/common/factory/company_factory.py:84` | 84 | `name` | method | 199 | 0 | 26 |
| 199 | `zuzu/packages/company/meeting/services/meeting_shareholder_service.py:89` | 89 | `meeting` | constant | 201 | 2 | 99 |
| 198 | `zuzu/packages/company/meeting/notifications/meeting_execution_notification.py:20` | 20 | `meeting` | constant | 200 | 2 | 97 |
| 198 | `zuzu/packages/company/meeting/notifications/meeting_revert_execution_notification.py:20` | 20 | `meeting` | constant | 200 | 2 | 97 |
| 198 | `zuzu/packages/payment/actions/payment_cancel_and_repay_registration_assistance_action.py:34` | 34 | `meeting` | constant | 205 | 7 | 103 |
| 198 | `zuzu/packages/registration_assistance/actions/legal_registration_assistance_paid_action.py:34` | 34 | `meeting` | constant | 205 | 7 | 102 |

## Semantic Missing Examples

| file:line | name | kind | qualifiedName | lsp |
|---|---|---|---|---:|
| `zuzu/db/models/captable.py:101` | `exclude` | constant | `Captable.exclude` | 4 |
| `zuzu/db/models/captable.py:118` | `qs` | constant | `Captable.qs` | 3 |
| `zuzu/db/models/captable.py:236` | `items` | constant | `Captable.items` | 11 |
| `zuzu/db/models/captable.py:157` | `qs` | constant | `Captable.qs` | 3 |
| `zuzu/db/models/captable.py:277` | `issued_shares` | constant | `Captable.issued_shares` | 1 |
| `zuzu/db/models/captable.py:317` | `items` | constant | `Captable.items` | 11 |
| `zuzu/db/models/events/option/abstract_option_event.py:122` | `option_grantee_id` | constant | `AbstractOptionEvent.option_grantee_id` | 2 |
| `zuzu/db/models/option/option_management.py:109` | `purchase` | constant | `OptionManagement.purchase` | 3 |
| `zuzu/db/models/registration_form_text/registration_form_text_aoi_change.py:18` | `registration_form_text` | constant | `RegistrationFormTextAoiChange.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_authorized_shares_change.py:14` | `registration_form_text` | constant | `RegistrationFormTextAuthorizedSharesChange.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_bonus_issue.py:20` | `registration_form_text` | constant | `RegistrationFormTextBonusIssue.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_branch_change.py:17` | `registration_form_text` | constant | `RegistrationFormTextBranchChange.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_director_change.py:38` | `registration_form_text` | constant | `RegistrationFormTextDirectorChange.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_head_office_inside_relocation.py:14` | `registration_form_text` | constant | `RegistrationFormTextHeadOfficeInsideRelocation.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_new_issue.py:18` | `registration_form_text` | constant | `RegistrationFormTextNewIssue.registration_form_text` | 2 |
| `zuzu/db/models/registration_form_text/registration_form_text_option_exercise.py:46` | `registration_form_text` | constant | `RegistrationFormTextOptionExercise.registration_form_text` | 2 |
| `zuzu/packages/hrm/emp/contract/graphql/mutations/hrm_request_emp_contract_esig_mutation.py:45` | `emp_contract_ids` | constant | `HrmRequestEmpContractEsig.TypedArguments.emp_contract_ids` | 0 |
| `zuzu/packages/tbk/graphql/queries/annual_tax_partner_tbk_summary_list_query.py:21` | `where` | constant | `AnnualTaxPartnerTbkSummaryListQuery.AnnualTaxPartnerTbkSummaryListArguments.where` | 0 |
| `zuzu/packages/tbk/services/tax_partner_tbk_contract_service.py:148` | `summaries` | constant | `summaries` | 2 |
| `zuzu/packages/tbk/services/tax_partner_tbk_contract_service.py:206` | `summaries` | constant | `summaries` | 2 |
| `zuzu/packages/tbk/services/tax_partner_tbk_contract_service.py:280` | `result` | constant | `result` | 2 |
| `zuzu/packages/tbk/types.py:93` | `created_at` | constant | `TaxPartnerTbkContractType.created_at` | 1 |
| `zuzu/packages/venture_capital/vc_search/rules/meta_filters.py:58` | `matched` | constant | `matched` | 5 |
| `zuzu/packages/venture_capital/vc_search/rules/post_filters.py:14` | `years` | constant | `FoundingAgeRule.years` | 3 |
| `zuzu/packages/venture_capital/vc_search/types.py:32` | `meta_filter` | constant | `VcIrSearchPlan.meta_filter` | 2 |
| `zuzu/packages/tbk/types.py:60` | `MonthlyTaxPartnerTbkSummaryListType` | class | `MonthlyTaxPartnerTbkSummaryListType` | 6 |
| `zuzu/packages/tbk/types.py:51` | `AnnualTaxPartnerTbkSummaryListType` | class | `AnnualTaxPartnerTbkSummaryListType` | 6 |
| `zuzu/packages/venture_capital/vc_search/rules/post_filters.py:11` | `FoundingAgeRule` | class | `FoundingAgeRule` | 5 |

## Artifacts

- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-21-self-scope-typed-field-refresh/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-21-self-scope-typed-field-refresh/discrepancies.jsonl`
