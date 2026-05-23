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
- Current graph usage refresh: changed=0, missing=0, errors=0

## Usage Signal

- Exact match: **4753/25706 = 18.5%**
- Within +/-1: 24.3%
- Within +/-5: 43.0%
- Mean absolute error: 22.31
- Inlay mean: 29.91
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 6.6 | 9.2 | 25.4 | 29.18 | 33.49 | 4.39 |
| class | 4903 | 44.4 | 61.8 | 91.0 | 4.04 | 22.03 | 18.00 |
| method | 2823 | 21.1 | 25.7 | 46.5 | 18.91 | 25.96 | 7.18 |
| function | 1149 | 75.0 | 82.5 | 88.5 | 8.06 | 20.77 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 6886 | 26.8% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_1-5 | 5609 | 21.8% |
| match | 4753 | 18.5% |
| inlay_over_by_50plus | 1629 | 6.3% |
| inlay_under_by_1-5 | 61 | 0.2% |
| inlay_under_by_6-50 | 40 | 0.2% |
| inlay_under_by_50plus | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +21805 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 21810 | 5 |
| +12775 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | constant | 12777 | 2 |
| +4061 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4066 | 5 |
| +4056 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4056 | 0 |
| +1505 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 1506 | 1 |
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 |
| +910 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 937 | 27 |
| +910 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 911 | 1 |
| +910 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 911 | 1 |
| +910 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 924 | 14 |
| +910 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 916 | 6 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 |
| +682 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 685 | 3 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 |
| +653 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 654 | 1 |
| +628 | `zuzu/common/graphql/scalars/positive_decimal.py:9` | `PositiveDecimal` | class | 779 | 151 |
| +619 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 625 | 6 |
| +609 | `zuzu/common/requests/api.py:48` | `patch` | constant | 612 | 3 |
| +574 | `zuzu/common/tests/time_machine.py:22` | `now` | function | 583 | 9 |
| +570 | `zuzu/packages/product/tests/services/test_product_conversion_service.py:21` | `now` | constant | 578 | 8 |
| +555 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 556 | 1 |
| +548 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 548 | 0 |
| +506 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 511 | 5 |
| +504 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 504 | 0 |
| +484 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 484 | 0 |
| +484 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 484 | 0 |
| +483 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 483 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 483 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 483 | 0 |
| +483 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 483 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -52 | `zuzu/packages/payment/services/payple_client.py:80` | `receipt_url` | constant | 7 | 59 |
| -50 | `zuzu/packages/payment/services/payple_client.py:81` | `paid_at` | constant | 9 | 59 |
| -47 | `zuzu/packages/pipedrive/types.py:160` | `error_message` | constant | 35 | 82 |
| -38 | `zuzu/packages/document/base.py:111` | `document_type_name` | constant | 8 | 46 |
| -34 | `zuzu/packages/subscription/types/subscription_payment_types.py:356` | `items` | constant | 14 | 48 |
| -33 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:338` | `get_queryset` | method | 68 | 101 |
| -31 | `zuzu/db/models/user/user.py:181` | `phone` | method | 100 | 131 |
| -30 | `zuzu/packages/corporate_registration/xml_parser/types/xml_parser_corporate_registration.py:21` | `XmlParserCorporateRegistration` | constant | 20 | 50 |
| -24 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:19` | `deadline_date` | constant | 16 | 40 |
| -24 | `zuzu/packages/subscription/types/subscription_payment_types.py:344` | `quantity` | constant | 10 | 34 |
| -21 | `zuzu/packages/document/document_types/employment_certificate_document.py:115` | `document_type_name` | constant | 25 | 46 |
| -18 | `zuzu/db/models/stakeholder/stakeholder.py:59` | `registration_number` | constant | 145 | 163 |
| -18 | `zuzu/db/models/stakeholder/stakeholder.py:246` | `registration_number` | constant | 145 | 163 |
| -18 | `zuzu/db/models/stakeholder/stakeholder.py:265` | `registration_number` | constant | 145 | 163 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:16` | `agenda_type` | constant | 69 | 87 |
| -18 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:20` | `require_registration` | constant | 12 | 30 |
| -18 | `zuzu/db/models/hrm/emp/affiliation/hrm_emp_affiliation_dept.py:27` | `get_queryset` | method | 12 | 30 |
| -16 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:25` | `CORPORATION` | constant | 61 | 77 |
| -16 | `zuzu/packages/company/meeting/types/service_fee_types.py:25` | `items` | constant | 10 | 26 |
| -15 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 6 | 21 |
| -15 | `zuzu/db/models/question_thread/question_thread.py:583` | `help_type` | method | 17 | 32 |
| -14 | `zuzu/db/models/question_thread/company_question_thread.py:383` | `message_set` | constant | 26 | 40 |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:88` | `COMPLETED` | constant | 5 | 19 |
| -12 | `zuzu/db/models/hrm/approval/hrm_approval_line.py:205` | `approver` | constant | 20 | 32 |
| -11 | `zuzu/db/models/option/option.py:96` | `grantee` | constant | 74 | 85 |
| -11 | `zuzu/db/models/subscription/subscription_perk.py:227` | `quantity` | method | 5 | 16 |
| -10 | `zuzu/db/models/hrm/emp/hrm_emp.py:549` | `email` | constant | 9 | 19 |
| -10 | `zuzu/db/models/meeting_document/base/meeting_document.py:53` | `style_required` | constant | 22 | 32 |
| -10 | `zuzu/db/models/question_thread/question_thread_message.py:215` | `content` | constant | 24 | 34 |
| -10 | `zuzu/db/models/registration_form_text/base.py:25` | `content` | constant | 29 | 39 |

## Artifacts

- Population: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/population.jsonl`
- Candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_skipped.jsonl`
- Timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-datepruned/discrepancies.jsonl`
