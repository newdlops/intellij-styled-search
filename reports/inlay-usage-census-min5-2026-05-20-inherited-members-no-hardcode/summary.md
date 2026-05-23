# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Census mode: full population
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25706**
- Skipped/unknown LSP candidates: 0
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25706: +/-0.6%
- Current graph usage refresh: changed=161, missing=0, errors=0
- Graph usage changed from cached baseline: 3868/25706

## Usage Signal

- Exact match: **4795/25706 = 18.7%**
- Within +/-1: 24.7%
- Within +/-5: 43.7%
- Mean absolute error: 20.95
- Inlay mean: 28.56
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 7.0 | 9.7 | 26.4 | 27.24 | 31.57 | 4.39 |
| class | 4903 | 44.4 | 61.8 | 90.7 | 4.07 | 22.06 | 18.00 |
| method | 2823 | 20.8 | 25.9 | 47.0 | 18.47 | 25.53 | 7.18 |
| function | 1149 | 74.8 | 82.6 | 89.6 | 7.07 | 19.76 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 6838 | 26.6% |
| inlay_over_no_lsp_refs | 6717 | 26.1% |
| inlay_over_by_1-5 | 5597 | 21.8% |
| match | 4795 | 18.7% |
| inlay_over_by_50plus | 1621 | 6.3% |
| inlay_under_by_1-5 | 105 | 0.4% |
| inlay_under_by_6-50 | 30 | 0.1% |
| inlay_missed | 3 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4063 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4068 | 5 |
| +4058 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4058 | 0 |
| +3348 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3353 | 5 |
| +1505 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 1506 | 1 |
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 |
| +877 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 904 | 27 |
| +877 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 878 | 1 |
| +877 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 878 | 1 |
| +877 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 891 | 14 |
| +877 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 883 | 6 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 |
| +653 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 654 | 1 |
| +628 | `zuzu/common/graphql/scalars/positive_decimal.py:9` | `PositiveDecimal` | class | 779 | 151 |
| +619 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 625 | 6 |
| +611 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 611 | 0 |
| +611 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 611 | 0 |
| +610 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 610 | 0 |
| +610 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 610 | 0 |
| +610 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 610 | 0 |
| +610 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 610 | 0 |
| +610 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:62` | `output_field` | constant | 610 | 0 |
| +610 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:85` | `output_field` | constant | 610 | 0 |
| +555 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 556 | 1 |
| +549 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 549 | 0 |
| +497 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 502 | 5 |
| +495 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 495 | 0 |
| +480 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 481 | 1 |
| +476 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 479 | 3 |
| +467 | `zuzu/common/models/protocol.py:11` | `exists` | method | 467 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -43 | `zuzu/packages/pipedrive/types.py:160` | `error_message` | constant | 39 | 82 |
| -34 | `zuzu/packages/subscription/types/subscription_payment_types.py:356` | `items` | constant | 14 | 48 |
| -33 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:338` | `get_queryset` | method | 68 | 101 |
| -31 | `zuzu/db/models/user/user.py:181` | `phone` | method | 100 | 131 |
| -30 | `zuzu/packages/corporate_registration/xml_parser/types/xml_parser_corporate_registration.py:21` | `XmlParserCorporateRegistration` | constant | 20 | 50 |
| -24 | `zuzu/packages/subscription/types/subscription_payment_types.py:344` | `quantity` | constant | 10 | 34 |
| -21 | `zuzu/packages/document/document_types/employment_certificate_document.py:115` | `document_type_name` | constant | 25 | 46 |
| -18 | `zuzu/db/models/stakeholder/stakeholder.py:59` | `registration_number` | constant | 145 | 163 |
| -18 | `zuzu/db/models/stakeholder/stakeholder.py:246` | `registration_number` | constant | 145 | 163 |
| -18 | `zuzu/db/models/stakeholder/stakeholder.py:265` | `registration_number` | constant | 145 | 163 |
| -18 | `zuzu/db/models/hrm/emp/affiliation/hrm_emp_affiliation_dept.py:27` | `get_queryset` | method | 12 | 30 |
| -16 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:25` | `CORPORATION` | constant | 61 | 77 |
| -16 | `zuzu/packages/company/meeting/types/service_fee_types.py:25` | `items` | constant | 10 | 26 |
| -15 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 6 | 21 |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:88` | `COMPLETED` | constant | 5 | 19 |
| -12 | `zuzu/db/models/hrm/approval/hrm_approval_line.py:205` | `approver` | constant | 20 | 32 |
| -11 | `zuzu/db/models/option/option.py:96` | `grantee` | constant | 74 | 85 |
| -11 | `zuzu/db/models/question_thread/company_question_thread.py:383` | `message_set` | constant | 29 | 40 |
| -11 | `zuzu/db/models/subscription/subscription_perk.py:227` | `quantity` | method | 5 | 16 |
| -10 | `zuzu/db/models/hrm/emp/hrm_emp.py:549` | `email` | constant | 9 | 19 |
| -10 | `zuzu/db/models/question_thread/question_thread_message.py:215` | `content` | constant | 24 | 34 |
| -10 | `zuzu/db/models/registration_form_text/base.py:25` | `content` | constant | 29 | 39 |
| -10 | `zuzu/db/models/venture_capital/quarterly_report/venture_capital_quarterly_report_item.py:85` | `get_queryset` | method | 16 | 26 |
| -9 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:374` | `get_queryset` | method | 37 | 46 |
| -8 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:357` | `type` | constant | 9 | 17 |
| -8 | `zuzu/db/models/phantom_stock/phantom_stock_vesting/phantom_stock_vesting_traceable.py:171` | `get_queryset` | method | 19 | 27 |
| -7 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:471` | `quantity` | method | 19 | 26 |
| -6 | `zuzu/db/models/investment_association/partner/investment_association_partner.py:263` | `email` | constant | 12 | 18 |
| -6 | `zuzu/packages/alimtalk/alimtalk_template.py:42` | `DIRECTOR_EXPIRATION_UNKNOWN_TERM_END_DATE` | constant | 0 | 6 |
| -6 | `zuzu/db/models/company/user_relation/company_user_relation.py:61` | `get_queryset` | method | 25 | 31 |

## Artifacts

- Population: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/population.jsonl`
- Candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_skipped.jsonl`
- Timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-inherited-members-no-hardcode/discrepancies.jsonl`
