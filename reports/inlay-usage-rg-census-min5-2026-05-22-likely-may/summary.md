# Fast RG Usage Census

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **114078**
- Elapsed: 13.2s

## Proxy Result

- Exact likely/proxy match: **6661/114078 = 5.8%**
- MAY undercount risk: **9721/114078 = 8.5%**
- Likely below proxy but MAY safe: **97295/114078 = 85.3%**
- Proxy overcount: **401/114078 = 0.4%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 8715 | 36.5 | 0.0 | 60.1 | 3.4 |
| field | 93034 | 2.6 | 6.6 | 90.8 | 0.1 |
| function | 3053 | 31.8 | 8.5 | 58.0 | 1.8 |
| method | 9276 | 1.4 | 35.5 | 63.1 | 0.0 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| -10197 | `zuzu/tests/base.py:57` | `graphql` | method | 0 | 10197 | 18 | 10197 |
| -6560 | `zuzu/packages/hrm/ag_grid_types.py:25` | `filter` | field | 0 | 6560 | 110 | 6560 |
| -6560 | `zuzu/packages/hrm/ag_grid_types.py:7` | `filter` | field | 0 | 6560 | 110 | 6560 |
| -6560 | `zuzu/common/logging.py:16` | `filter` | method | 0 | 6560 | 110 | 6560 |
| -6560 | `zuzu/db/models/product/product.py:23` | `filter` | method | 0 | 6560 | 110 | 6560 |
| -6560 | `zuzu/common/models/protocol.py:5` | `filter` | method | 0 | 6560 | 110 | 6560 |
| -6560 | `zuzu/packages/company/stakeholder/shareholder/graphql/queries/shareholders_query.py:51` | `filter` | field | 0 | 6560 | 110 | 6560 |
| -6353 | `zuzu/packages/document/views/document_docx_view.py:22` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/document/views/document_html_view.py:9` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/document/views/document_image_view.py:19` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/document/views/document_pdf_view.py:29` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/document/views/document_view.py:194` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/fi_sta/views/fi_sta_document_view.py:54` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/fi_sta/views/fi_sta_modusign_document_view.py:75` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/document/views/investment_association_document_view.py:112` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6353 | `zuzu/packages/company/meeting/document/views/meeting_document_view.py:60` | `get` | method | 0 | 6353 | 3 | 6353 |
| -6352 | `zuzu/packages/company/payroll/year_end_tax_settlement/services/parsers/registry.py:62` | `get` | method | 1 | 6353 | 3 | 6353 |
| -4342 | `zuzu/packages/question_thread/types/general_question_thread_list_type.py:18` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/packages/credit/types.py:76` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/app/graphql/types/__init__.py:318` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/packages/company/event/graphql/queries/first_event_query.py:28` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/packages/investment_simulation/tests/base.py:32` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/common/personal_information/personal_information_logging.py:82` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/common/personal_information/personal_information_log_builder.py:44` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/common/personal_information/personal_information_log_builder.py:73` | `types` | field | 0 | 4342 | 329 | 4342 |
| -4342 | `zuzu/packages/question_thread/types/question_thread_message_type.py:57` | `types` | field | 0 | 4342 | 329 | 4342 |
| -1396 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 0 | 1396 | 0 | 1396 |
| -1396 | `zuzu/common/models/protocol.py:13` | `annotate` | method | 0 | 1396 | 0 | 1396 |
| -1235 | `zuzu/db/models/events/event.py:108` | `order_by` | field | 0 | 1235 | 12 | 1235 |
| -1235 | `zuzu/packages/question_thread/types/incorporation_request_list_filter_input_type.py:11` | `order_by` | field | 0 | 1235 | 12 | 1235 |
| -1235 | `zuzu/packages/question_thread/types/meeting_list_filter_input_type.py:15` | `order_by` | field | 0 | 1235 | 12 | 1235 |
| -1235 | `zuzu/packages/venture_capital/quarterly_report/types.py:184` | `order_by` | field | 0 | 1235 | 12 | 1235 |
| -1080 | `zuzu/db/models/agenda/director_compensation_rule/agenda_director_compensation_rule.py:65` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/payroll_ledger_attachment.py:49` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/payroll_ledger_file.py:54` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/statement/payroll_statement_document.py:56` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_book.py:172` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_book_without_date.py:133` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_certificate.py:164` | `company_id` | function | 0 | 1080 | 1080 | 158 |
| -1080 | `zuzu/db/models/company/payroll/wht/wht_receipt.py:101` | `company_id` | function | 0 | 1080 | 1080 | 158 |

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +292 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 297 | 5 | 5 | 443 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +138 | `zuzu/db/models/purchase/purchase_status_history.py:189` | `Status` | class | 229 | 91 | 91 | 1343 |
| +137 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 143 | 6 | 6 | 149 |
| +117 | `zuzu/fi_sta/models/fi_sta_user.py:43` | `Role` | class | 122 | 5 | 5 | 443 |
| +115 | `zuzu/db/models/subscription/subscription_perk.py:159` | `PerkType` | class | 116 | 1 | 1 | 107 |
| +114 | `zuzu/db/models/modusign/modusign_document_action_history.py:119` | `Status` | class | 205 | 91 | 91 | 1343 |
| +93 | `zuzu/db/models/subscription/subscription.py:915` | `Status` | class | 184 | 91 | 91 | 1343 |
| +91 | `zuzu/db/models/subscription/subscription_perk.py:172` | `PerkMethod` | class | 92 | 1 | 1 | 85 |
| +82 | `zuzu/db/models/question_thread/question_thread_message_profile.py:13` | `ProfileType` | class | 84 | 2 | 2 | 81 |
| +81 | `zuzu/db/models/events/option/option_exercise_event.py:116` | `ExerciseType` | class | 83 | 2 | 2 | 79 |
| +65 | `zuzu/db/models/incorporation_request/incorporation_request.py:232` | `Status` | class | 156 | 91 | 91 | 1343 |
| +62 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:82` | `Status` | class | 153 | 91 | 91 | 1343 |
| +54 | `zuzu/packages/document/base.py:51` | `NextAction` | class | 55 | 1 | 1 | 54 |
| +51 | `zuzu/db/models/purchase/payment/credit_card_payment/payment_status_history.py:21` | `Status` | class | 142 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/stakeholder/employee/employment_status.py:58` | `Status` | class | 141 | 91 | 91 | 1343 |
| +50 | `zuzu/db/models/registration_assistance.py:31` | `Status` | class | 141 | 91 | 91 | 1343 |
| +49 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:129` | `Method` | class | 54 | 5 | 5 | 133 |
| +46 | `zuzu/db/models/self_registration.py:17` | `Status` | class | 137 | 91 | 91 | 1343 |
| +45 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:162` | `CapitalSource` | class | 46 | 1 | 1 | 45 |
| +45 | `zuzu/db/models/investment_association/owner/ia_owner.py:56` | `Role` | class | 50 | 5 | 5 | 443 |
| +40 | `zuzu/db/models/captable_request.py:74` | `Status` | class | 131 | 91 | 91 | 1343 |
| +37 | `zuzu/db/models/events/stock/stock_transfer_event.py:94` | `Method` | class | 42 | 5 | 5 | 133 |
| +36 | `zuzu/db/models/stock_unissued_confirmation_request.py:77` | `Status` | class | 127 | 91 | 91 | 1343 |
| +36 | `zuzu/db/models/subscription/subscription_payment_request.py:57` | `Status` | class | 127 | 91 | 91 | 1343 |
| +35 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:26` | `DEDUCTION` | field | 43 | 8 | 0 | 8 |
| +35 | `zuzu/db/models/subscription/subscription_plan.py:72` | `RenewType` | class | 36 | 1 | 1 | 33 |
| +34 | `zuzu/db/models/meeting/meeting.py:919` | `RegistrationStatus` | class | 35 | 1 | 1 | 34 |
| +33 | `zuzu/packages/document/base.py:57` | `Kind` | class | 39 | 6 | 6 | 60 |
| +33 | `zuzu/db/models/company/electronic_certificate/electronic_certificate.py:57` | `MediaHolderChoices` | class | 37 | 4 | 4 | 36 |
| +31 | `zuzu/db/models/investment_association/ia_founding_progress_status.py:39` | `Status` | class | 122 | 91 | 91 | 1343 |
| +29 | `zuzu/db/models/company/payroll/payroll_ledger_item.py:35` | `SALARY` | field | 35 | 6 | 0 | 6 |
| +29 | `zuzu/db/models/company/payroll/payroll_ledger.py:56` | `SALARY` | field | 35 | 6 | 0 | 6 |
| +28 | `zuzu/db/models/corporate_registration/corporate_registration_issue_log.py:38` | `IssuanceStatus` | class | 29 | 1 | 1 | 26 |
| +27 | `zuzu/db/models/investment_association/rule/ia_rule_compensation.py:41` | `ManagementCompensationMethodId` | class | 27 | 0 | 0 | 25 |
| +23 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_item.py:76` | `CombineType` | class | 25 | 2 | 2 | 21 |
| +22 | `zuzu/packages/document/base.py:75` | `Kind` | class | 28 | 6 | 6 | 60 |
| +21 | `zuzu/db/models/company/payroll/payroll_ledger.py:55` | `PaymentType` | class | 26 | 5 | 5 | 23 |
| +20 | `zuzu/db/models/company/create_request/company_create_request.py:120` | `Status` | class | 111 | 91 | 91 | 1343 |
| +20 | `zuzu/db/models/events/option/option_pause_event.py:55` | `Reason` | class | 26 | 6 | 6 | 33 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260522_likely_may/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-22-likely-may/discrepancies.jsonl`
