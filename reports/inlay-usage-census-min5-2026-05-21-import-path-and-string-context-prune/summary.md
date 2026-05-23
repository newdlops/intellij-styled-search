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
- Current graph usage refresh: changed=3170, missing=0, errors=0
- Graph usage changed from cached baseline: 25686/25706

## Usage Signal

- Exact match: **2541/25706 = 9.9%**
- Missing: **1**
- Undercount: **538**
- Overcount: 22627
- Within +/-1: 14.5%
- Within +/-5: 21.8%
- Mean absolute error: 31.94
- Inlay mean: 39.55
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 2.9 | 4 | 3.3 | 3.7 | 42.36 | 46.75 | 4.39 |
| class | 4903 | 30.9 | 529 | 50.9 | 61.8 | 9.52 | 27.27 | 18.00 |
| method | 2823 | 15.7 | 0 | 20.0 | 33.2 | 18.85 | 26.03 | 7.18 |
| function | 1149 | 8.8 | 5 | 9.7 | 89.1 | 7.02 | 19.74 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 11584 | 45.1% |
| inlay_over_no_lsp_refs | 6573 | 25.6% |
| match | 2541 | 9.9% |
| inlay_over_by_1-5 | 2461 | 9.6% |
| inlay_over_by_50plus | 2009 | 7.8% |
| inlay_under_by_1-5 | 536 | 2.1% |
| inlay_missed | 1 | 0.0% |
| inlay_under_by_6-50 | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| +846 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 847 | 1 | 848 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| +525 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 526 | 1 | 654 |
| +471 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 480 | 9 | 144 |
| +378 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 387 | 9 | 377 |
| +349 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 508 | 159 | 179 |
| +331 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 332 | 1 | 481 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 | 291 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 | 175 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 596 |
| +299 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 301 | 2 | 302 |
| +289 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 302 | 13 | 186 |
| +265 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 284 | 19 | 300 |
| +263 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 274 | 11 | 218 |
| +253 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 254 | 1 | 270 |
| +242 | `zuzu/db/models/agenda/base/directors_meeting_agenda_child_base.py:24` | `meeting` | method | 243 | 1 | 124 |
| +229 | `zuzu/db/models/investment_association/rule/ia_rule.py:293` | `meeting` | method | 234 | 5 | 100 |
| +228 | `zuzu/db/models/option/option_management.py:142` | `meeting` | method | 229 | 1 | 95 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 91 |
| +227 | `zuzu/packages/legal_partner/graphql/mutations/staff_ia_legal_partner_assign_mutation.py:35` | `investment_association` | constant | 229 | 2 | 186 |
| +227 | `zuzu/packages/company/meeting/actions/send_directors_meeting_notice_email_action.py:22` | `meeting` | method | 228 | 1 | 94 |
| +227 | `zuzu/packages/company/meeting/actions/send_shareholders_meeting_convocation_notice_email_action.py:23` | `meeting` | method | 228 | 1 | 94 |
| +225 | `zuzu/packages/payment/payment_link/graphql/mutations/staff_create_ia_payment_link_mutation.py:20` | `investment_association` | constant | 227 | 2 | 182 |
| +223 | `zuzu/packages/payment/graphql/mutations/register_credit_card_mutation.py:47` | `investment_association` | constant | 227 | 4 | 184 |
| +223 | `zuzu/packages/company/meeting/types/meeting_service_types.py:443` | `director_type` | method | 231 | 8 | 226 |
| +222 | `zuzu/packages/unlisted_stock_management/investment_association/graphql/mutations/staff_create_usm_ia_and_partner_mutation.py:51` | `investment_association` | constant | 227 | 5 | 186 |
| +217 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 219 | 2 | 424 |
| +213 | `zuzu/packages/company/stakeholder/director/graphql/mutations/director_appointment_add_mutation.py:39` | `stakeholder` | constant | 215 | 2 | 210 |
| +212 | `zuzu/packages/company/graphql/types/company_list_item_type.py:121` | `establishment_date` | constant | 212 | 0 | 423 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| -12 | `zuzu/packages/company/meeting/types/service_fee_types.py:16` | `ServiceFeeItem` | class | 173 | 185 | 223 |
| -4 | `zuzu/db/models/events/director/co_ceo_system_change_event.py:32` | `CoCeoSystemChangeEvent` | class | 55 | 59 | 61 |
| -4 | `zuzu/db/models/venture_capital/portfolio_company_manager.py:49` | `PortfolioCompanyManager` | class | 30 | 34 | 41 |
| -4 | `zuzu/packages/corporate_registration/auto_updater/types/director_event.py:26` | `_TermEvent` | class | 47 | 51 | 51 |
| -3 | `zuzu/db/models/events/stock/bonus_issue_event.py:45` | `BonusIssueEvent` | class | 73 | 76 | 79 |
| -3 | `zuzu/db/models/events/stock/stock_consolidation_event.py:37` | `StockConsolidationEvent` | class | 68 | 71 | 74 |
| -3 | `zuzu/db/models/events/stock/stock_split_event.py:37` | `StockSplitEvent` | class | 69 | 72 | 75 |
| -3 | `zuzu/db/models/investment_association/document/investment_association_document.py:81` | `InvestmentAssociationDocument` | class | 108 | 111 | 113 |
| -3 | `zuzu/db/models/option/option_exercise/option_exercise_claim_option.py:33` | `OptionExerciseClaimOption` | class | 35 | 38 | 39 |
| -3 | `zuzu/fi_sta/models/document/fi_sta_abstract_document.py:40` | `FiStaAbstractDocument` | class | 44 | 47 | 47 |
| -2 | `zuzu/common/models/purchasable.py:126` | `Purchasable` | class | 58 | 60 | 63 |
| -2 | `zuzu/db/models/bulk_email/bulk_email_recipient.py:106` | `BulkEmailRecipient` | class | 57 | 59 | 60 |
| -2 | `zuzu/db/models/company/employee_stock/employee_stock_withdraw_request.py:60` | `EmployeeStockWithdrawRequest` | class | 68 | 70 | 71 |
| -2 | `zuzu/db/models/company/investment_simulation/investment_simulation_new_issue_round.py:41` | `InvestmentSimulationNewIssueRound` | class | 19 | 21 | 22 |
| -2 | `zuzu/db/models/company/investment_simulation/investment_simulation_option_exercise_round.py:40` | `InvestmentSimulationOptionExerciseRound` | class | 13 | 15 | 16 |
| -2 | `zuzu/db/models/company/payroll/statement/email/payroll_statement_email.py:46` | `PayrollStatementEmail` | class | 35 | 37 | 39 |
| -2 | `zuzu/db/models/company/payroll/statement/email/payroll_statement_email_recipient.py:46` | `PayrollStatementEmailRecipient` | class | 9 | 11 | 13 |
| -2 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:72` | `CompanyManagingEntity` | class | 98 | 100 | 102 |
| -2 | `zuzu/db/models/consent_form/consent_form.py:102` | `ConsentForm` | class | 42 | 44 | 45 |
| -2 | `zuzu/db/models/consent_form/consent_form_option_item.py:29` | `ConsentFormOptionItem` | class | 17 | 19 | 21 |
| -2 | `zuzu/db/models/events/director/ceo_address_change_event.py:32` | `CeoAddressChangeEvent` | class | 31 | 33 | 36 |
| -2 | `zuzu/db/models/events/director/director_appointment_event.py:400` | `DirectorAppointmentEvent` | class | 124 | 126 | 135 |
| -2 | `zuzu/db/models/events/director/director_compensation_decision_event.py:80` | `DirectorCompensationDecisionEvent` | class | 39 | 41 | 44 |
| -2 | `zuzu/db/models/events/director/director_compensation_limit_event.py:78` | `DirectorCompensationLimitEvent` | class | 35 | 37 | 40 |
| -2 | `zuzu/db/models/events/director/director_term_end_event.py:32` | `DirectorTermEndEvent` | class | 130 | 132 | 135 |
| -2 | `zuzu/db/models/events/event.py:591` | `Event` | class | 262 | 264 | 276 |
| -2 | `zuzu/db/models/events/rsu/rsu_adjust_event.py:41` | `RsuAdjustEvent` | class | 11 | 13 | 15 |
| -2 | `zuzu/db/models/events/rsu/rsu_performance_achievement_event.py:61` | `RsuPerformanceAchievementEvent` | class | 18 | 20 | 23 |
| -2 | `zuzu/db/models/events/stock/capital_reduction_event.py:40` | `CapitalReductionEvent` | class | 43 | 45 | 48 |
| -2 | `zuzu/db/models/events/stock/investment_round.py:27` | `InvestmentRoundQuerySet` | class | 8 | 10 | 11 |

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-pattern-margin-10pct/lsp_usage_results_refreshed.jsonl`
- Bulk graph symbols: `/private/tmp/captain_symbols_current.json`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-path-and-string-context-prune/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-path-and-string-context-prune/discrepancies.jsonl`
