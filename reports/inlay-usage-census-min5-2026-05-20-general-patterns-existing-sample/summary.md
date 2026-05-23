# Inlay Usage Accuracy Rerun

- Date: 2026-05-20
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25706**
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25706: +/-0.6%
- Current graph usage refresh: changed=2723, missing=0, errors=0
- Graph usage changed from cached baseline: 8987/25706

## Usage Signal

- Exact match: **4829/25706 = 18.8%**
- Within +/-1: 25.0%
- Within +/-5: 44.2%
- Mean absolute error: 20.45
- Inlay mean: 28.07
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 7.0 | 9.9 | 26.8 | 26.66 | 31.00 | 4.39 |
| class | 4903 | 44.4 | 61.8 | 90.7 | 4.07 | 22.06 | 18.00 |
| method | 2823 | 21.5 | 27.4 | 48.4 | 17.33 | 24.40 | 7.18 |
| function | 1149 | 74.8 | 82.6 | 89.6 | 7.01 | 19.71 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 6865 | 26.7% |
| inlay_over_no_lsp_refs | 6714 | 26.1% |
| inlay_over_by_1-5 | 5599 | 21.8% |
| match | 4829 | 18.8% |
| inlay_over_by_50plus | 1576 | 6.1% |
| inlay_under_by_1-5 | 101 | 0.4% |
| inlay_under_by_6-50 | 19 | 0.1% |
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
| +558 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 559 | 1 |
| +546 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 546 | 0 |
| +497 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 502 | 5 |
| +495 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 495 | 0 |
| +480 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 481 | 1 |
| +476 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 479 | 3 |
| +461 | `zuzu/common/models/protocol.py:11` | `exists` | method | 461 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -32 | `zuzu/db/models/user/user.py:181` | `phone` | method | 99 | 131 |
| -31 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:338` | `get_queryset` | method | 70 | 101 |
| -30 | `zuzu/packages/corporate_registration/xml_parser/types/xml_parser_corporate_registration.py:21` | `XmlParserCorporateRegistration` | constant | 20 | 50 |
| -29 | `zuzu/db/models/stakeholder/stakeholder.py:59` | `registration_number` | constant | 134 | 163 |
| -29 | `zuzu/db/models/stakeholder/stakeholder.py:246` | `registration_number` | constant | 134 | 163 |
| -29 | `zuzu/db/models/stakeholder/stakeholder.py:265` | `registration_number` | constant | 134 | 163 |
| -21 | `zuzu/packages/document/document_types/employment_certificate_document.py:115` | `document_type_name` | constant | 25 | 46 |
| -16 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:25` | `CORPORATION` | constant | 61 | 77 |
| -16 | `zuzu/db/models/hrm/emp/affiliation/hrm_emp_affiliation_dept.py:27` | `get_queryset` | method | 14 | 30 |
| -15 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 6 | 21 |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:88` | `COMPLETED` | constant | 5 | 19 |
| -12 | `zuzu/db/models/hrm/approval/hrm_approval_line.py:205` | `approver` | constant | 20 | 32 |
| -11 | `zuzu/db/models/subscription/subscription_perk.py:227` | `quantity` | method | 5 | 16 |
| -10 | `zuzu/db/models/hrm/emp/hrm_emp.py:549` | `email` | constant | 9 | 19 |
| -9 | `zuzu/db/models/venture_capital/quarterly_report/venture_capital_quarterly_report_item.py:85` | `get_queryset` | method | 17 | 26 |
| -8 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:357` | `type` | constant | 9 | 17 |
| -8 | `zuzu/db/models/registration_form_text/registration_form_text_new_issue.py:80` | `items` | method | 3 | 11 |
| -7 | `zuzu/db/models/option/option.py:96` | `grantee` | constant | 78 | 85 |
| -7 | `zuzu/db/models/phantom_stock/phantom_stock_vesting/phantom_stock_vesting_traceable.py:171` | `get_queryset` | method | 20 | 27 |
| -6 | `zuzu/packages/alimtalk/alimtalk_template.py:42` | `DIRECTOR_EXPIRATION_UNKNOWN_TERM_END_DATE` | constant | 0 | 6 |
| -5 | `zuzu/common/requests/api.py:46` | `post` | constant | 17 | 22 |
| -5 | `zuzu/db/models/investment_association/partner/investment_association_partner.py:263` | `email` | constant | 13 | 18 |
| -5 | `zuzu/db/models/investment_association/partner/individual/investment_association_individual_partner_legal_representative.py:51` | `email` | constant | 6 | 11 |
| -5 | `zuzu/packages/alimtalk/alimtalk_template.py:5` | `GENERAL_HELP_ANSWERED` | constant | 0 | 5 |
| -5 | `zuzu/packages/pipedrive/services/pipedrive_client.py:202` | `update_user` | method | 0 | 5 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/electronic_signature/ia_consent_form_or_meeting_electronic_signature_required_document.py:145` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_meeting_minutes_document.py:55` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_meeting_notice_document.py:55` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_meeting_shorten_period_document.py:67` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_written_resolution_document.py:63` | `investment_association_id` | constant | 6 | 10 |

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-general-patterns-existing-sample/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-general-patterns-existing-sample/discrepancies.jsonl`
