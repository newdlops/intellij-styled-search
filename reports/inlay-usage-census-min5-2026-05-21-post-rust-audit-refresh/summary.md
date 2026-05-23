# Inlay Usage Current Graph Check

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- zoek-rs: `target/release/zoek-rs` rebuilt before this check
- Graph: rebuilt with `graph-rebuild /Users/lky/project/captain`
- LSP source: `reports/inlay-usage-census-min5-2026-05-21-simple-value-base-margin-cli/lsp_usage_results_refreshed.jsonl`
- Total cached LSP rows: **25706**
- Present after semantic remap: **25673**
- Strict symbolId matches: **25260**
- Semantic remaps: **413**
- Semantic missing: **33**
- Undercount: **129**
- Missed (usage=0, lsp>0): **33**
- Exact: **3171/25673 = 12.35%**
- Overcount: **22373**
- Usage changed from cached row: **18775**

## Top Under Counts

| diff | file:line | current line | name | kind | usage | lsp | previous |
|---:|---|---:|---|---|---:|---:|---:|
| -22 | `zuzu/common/factory/agenda_new_issue_item_factory.py:65` | 65 | `AgendaNewIssueItemFactory` | class | 8 | 30 | 30 |
| -18 | `zuzu/db/models/hrm/emp/hrm_emp.py:1000` | 1000 | `ongoing_attendance` | method | 0 | 18 | 18 |
| -18 | `zuzu/db/models/investment_association/partner/individual/investment_association_individual_partner.py:108` | 108 | `legal_representative` | method | 2 | 20 | 20 |
| -13 | `zuzu/db/models/investment_association/partner/individual/investment_association_individual_partner.py:94` | 94 | `is_legal_minor` | method | 0 | 13 | 13 |
| -13 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:422` | 422 | `granted_quantity` | method | 4 | 17 | 29 |
| -13 | `zuzu/db/models/user/user.py:276` | 276 | `email_with_name` | method | 29 | 42 | 67 |
| -12 | `zuzu/packages/ms_word/services/utils/types.py:21` | 21 | `size` | constant | 6 | 18 | 96 |
| -11 | `zuzu/db/models/agenda/base/directors_or_shareholders_meeting_agenda_child_base.py:37` | 37 | `directors_meeting` | method | 29 | 40 | 66 |
| -11 | `zuzu/db/models/subscription/subscription_perk.py:227` | 227 | `quantity` | method | 5 | 16 | 15 |
| -8 | `zuzu/common/models/purchasable.py:171` | 171 | `current_purchase` | method | 145 | 153 | 161 |
| -8 | `zuzu/db/models/events/director/director_appointment_event.py:439` | 439 | `term_end_event` | method | 7 | 15 | 23 |
| -8 | `zuzu/db/models/stakeholder/director/director_term.py:175` | 175 | `calculated_expected_end_date` | method | 15 | 23 | 25 |
| -7 | `zuzu/common/factory/question_thread_factory.py:10` | 10 | `QuestionThreadFactory` | class | 10 | 17 | 18 |
| -7 | `zuzu/db/models/events/stock/stock_transfer_event.py:131` | 131 | `purchaser` | method | 4 | 11 | 15 |
| -7 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:418` | 418 | `exercise_price` | method | 5 | 12 | 51 |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:22` | 22 | `color` | constant | 1 | 7 | 43 |
| -6 | `zuzu/db/models/invitation/user_invitation.py:119` | 119 | `invitee` | method | 8 | 14 | 15 |
| -5 | `zuzu/common/graphql/typed_graphene/typed_validation_errors.py:25` | 25 | `not_empty` | method | 14 | 19 | 20 |
| -5 | `zuzu/db/models/company/investment_simulation/investment_simulation_option_exercise_round.py:48` | 48 | `new_share_capital` | method | 0 | 5 | 6 |
| -5 | `zuzu/db/models/company/investment_simulation/investment_simulation_option_exercise_round.py:60` | 60 | `new_shares` | method | 0 | 5 | 7 |
| -5 | `zuzu/db/models/meeting_document/written_statement_document.py:141` | 141 | `resolution` | method | 0 | 5 | 10 |
| -5 | `zuzu/db/models/shareholders_meeting_director_attendance.py:127` | 127 | `director_type_after_meeting` | method | 0 | 5 | 10 |
| -4 | `zuzu/db/models/agenda/director_compensation/agenda_director_compensation.py:91` | 91 | `is_auditor_agenda` | method | 5 | 9 | 9 |
| -4 | `zuzu/db/models/company/investment_simulation/investment_simulation_new_issue_round.py:48` | 48 | `new_share_capital` | method | 1 | 5 | 7 |
| -4 | `zuzu/db/models/company/investment_simulation/investment_simulation_new_issue_round.py:52` | 52 | `new_shares` | method | 1 | 5 | 8 |
| -4 | `zuzu/db/models/directors_meeting.py:199` | 199 | `meeting_type_name` | method | 2 | 6 | 6 |
| -4 | `zuzu/db/models/directors_meeting_director_attendance.py:139` | 139 | `director_type_after_meeting` | method | 0 | 4 | 10 |
| -4 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:411` | 411 | `quantity_ratio` | method | 3 | 7 | 35 |
| -4 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:460` | 460 | `quantity_ratio` | method | 3 | 7 | 35 |
| -4 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:467` | 467 | `granted_quantity` | method | 3 | 7 | 28 |

## Semantic Missing Examples

| file:line | name | kind | qualifiedName | lsp |
|---|---|---|---|---:|
| `zuzu/db/models/captable.py:101` | `exclude` | constant | `Captable.exclude` | 4 |
| `zuzu/db/models/captable.py:118` | `qs` | constant | `Captable.qs` | 3 |
| `zuzu/db/models/captable.py:157` | `qs` | constant | `Captable.qs` | 3 |
| `zuzu/db/models/captable.py:236` | `items` | constant | `Captable.items` | 11 |
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
| `zuzu/packages/company/payroll/wht/wht_certificate/services/wht_certificate_document_service.py:256` | `details` | constant | `details` | 2 |
| `zuzu/packages/company/payroll/wht/wht_certificate/services/wht_certificate_document_service.py:315` | `details` | constant | `details` | 2 |
| `zuzu/packages/hrm/emp/contract/graphql/mutations/hrm_request_emp_contract_esig_mutation.py:45` | `emp_contract_ids` | constant | `HrmRequestEmpContractEsig.TypedArguments.emp_contract_ids` | 0 |
| `zuzu/packages/tbk/graphql/queries/annual_tax_partner_tbk_summary_list_query.py:21` | `where` | constant | `AnnualTaxPartnerTbkSummaryListQuery.AnnualTaxPartnerTbkSummaryListArguments.where` | 0 |
| `zuzu/packages/tbk/services/tax_partner_tbk_contract_service.py:148` | `summaries` | constant | `summaries` | 2 |
| `zuzu/packages/tbk/services/tax_partner_tbk_contract_service.py:206` | `summaries` | constant | `summaries` | 2 |
| `zuzu/packages/tbk/services/tax_partner_tbk_contract_service.py:280` | `result` | constant | `result` | 2 |
| `zuzu/packages/tbk/types.py:25` | `tax_partner` | constant | `AnnualTaxPartnerTbkSummaryType.tax_partner` | 1 |
| `zuzu/packages/tbk/types.py:38` | `tax_partner` | constant | `MonthlyTaxPartnerTbkSummaryType.tax_partner` | 1 |
| `zuzu/packages/tbk/types.py:51` | `AnnualTaxPartnerTbkSummaryListType` | class | `AnnualTaxPartnerTbkSummaryListType` | 6 |
| `zuzu/packages/tbk/types.py:56` | `year` | constant | `AnnualTaxPartnerTbkSummaryListFilterDict.year` | 0 |
| `zuzu/packages/tbk/types.py:60` | `MonthlyTaxPartnerTbkSummaryListType` | class | `MonthlyTaxPartnerTbkSummaryListType` | 6 |
| `zuzu/packages/tbk/types.py:93` | `created_at` | constant | `TaxPartnerTbkContractType.created_at` | 1 |
| `zuzu/packages/venture_capital/vc_search/rules/meta_filters.py:58` | `matched` | constant | `matched` | 5 |

- Discrepancies: `reports/inlay-usage-census-min5-2026-05-21-post-rust-audit-refresh/discrepancies.jsonl`
