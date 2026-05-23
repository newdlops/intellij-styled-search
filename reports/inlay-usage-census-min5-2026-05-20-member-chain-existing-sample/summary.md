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
- Current graph usage refresh: changed=4488, missing=0, errors=0
- Graph usage changed from cached baseline: 9981/25706

## Usage Signal

- Exact match: **4840/25706 = 18.8%**
- Within +/-1: 25.2%
- Within +/-5: 44.9%
- Mean absolute error: 20.08
- Inlay mean: 27.71
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 7.0 | 10.2 | 27.9 | 26.24 | 30.58 | 4.39 |
| class | 4903 | 44.4 | 61.8 | 90.7 | 4.07 | 22.06 | 18.00 |
| method | 2823 | 21.9 | 28.1 | 48.8 | 16.51 | 23.65 | 7.18 |
| function | 1149 | 74.8 | 82.7 | 89.6 | 6.98 | 19.67 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 6794 | 26.4% |
| inlay_over_no_lsp_refs | 6710 | 26.1% |
| inlay_over_by_1-5 | 5673 | 22.1% |
| match | 4840 | 18.8% |
| inlay_over_by_50plus | 1577 | 6.1% |
| inlay_under_by_1-5 | 97 | 0.4% |
| inlay_under_by_6-50 | 12 | 0.0% |
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
| +570 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 571 | 1 |
| +542 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 542 | 0 |
| +497 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 502 | 5 |
| +495 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 495 | 0 |
| +480 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 481 | 1 |
| +476 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 479 | 3 |
| +460 | `zuzu/common/models/protocol.py:11` | `exists` | method | 460 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -44 | `zuzu/db/models/stakeholder/stakeholder.py:59` | `registration_number` | constant | 119 | 163 |
| -44 | `zuzu/db/models/stakeholder/stakeholder.py:246` | `registration_number` | constant | 119 | 163 |
| -44 | `zuzu/db/models/stakeholder/stakeholder.py:265` | `registration_number` | constant | 119 | 163 |
| -30 | `zuzu/packages/corporate_registration/xml_parser/types/xml_parser_corporate_registration.py:21` | `XmlParserCorporateRegistration` | constant | 20 | 50 |
| -21 | `zuzu/packages/document/document_types/employment_certificate_document.py:115` | `document_type_name` | constant | 25 | 46 |
| -16 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:25` | `CORPORATION` | constant | 61 | 77 |
| -15 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 6 | 21 |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement_management.py:88` | `COMPLETED` | constant | 5 | 19 |
| -12 | `zuzu/db/models/hrm/approval/hrm_approval_line.py:205` | `approver` | constant | 20 | 32 |
| -11 | `zuzu/db/models/subscription/subscription_perk.py:227` | `quantity` | method | 5 | 16 |
| -8 | `zuzu/db/models/registration_form_text/registration_form_text_new_issue.py:80` | `items` | method | 3 | 11 |
| -7 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:357` | `type` | constant | 10 | 17 |
| -6 | `zuzu/packages/alimtalk/alimtalk_template.py:42` | `DIRECTOR_EXPIRATION_UNKNOWN_TERM_END_DATE` | constant | 0 | 6 |
| -5 | `zuzu/common/requests/api.py:46` | `post` | constant | 17 | 22 |
| -5 | `zuzu/packages/alimtalk/alimtalk_template.py:5` | `GENERAL_HELP_ANSWERED` | constant | 0 | 5 |
| -5 | `zuzu/packages/pipedrive/services/pipedrive_client.py:202` | `update_user` | method | 0 | 5 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/electronic_signature/ia_consent_form_or_meeting_electronic_signature_required_document.py:145` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_meeting_minutes_document.py:55` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_meeting_notice_document.py:55` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_meeting_shorten_period_document.py:67` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/documents/ia_written_resolution_document.py:63` | `investment_association_id` | constant | 6 | 10 |
| -4 | `zuzu/packages/question_thread/queries/general_question_thread/staff_general_question_thread_list_query.py:71` | `qs` | constant | 7 | 11 |
| -4 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:137` | `get_queryset` | method | 9 | 13 |
| -4 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:471` | `quantity` | method | 22 | 26 |
| -4 | `zuzu/db/models/venture_capital/quarterly_report/venture_capital_quarterly_report_item.py:85` | `get_queryset` | method | 22 | 26 |
| -4 | `zuzu/db/models/venture_capital/quarterly_report/venture_capital_quarterly_report_item_reply.py:52` | `get_queryset` | method | 14 | 18 |
| -4 | `zuzu/packages/investment_association/consent_form_or_meeting/electronic_signature/services/ia_esig_required_document_service.py:13` | `get_or_create_esig_required_document` | function | 3 | 7 |
| -4 | `zuzu/packages/utils/pages.py:33` | `calculate_maps` | function | 5 | 9 |
| -4 | `zuzu/packages/utils/pages.py:66` | `get_page_path` | function | 5 | 9 |
| -3 | `zuzu/common/requests/api.py:39` | `REQUEST_TIMEOUT` | constant | 11 | 14 |

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-member-chain-existing-sample/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-member-chain-existing-sample/discrepancies.jsonl`
