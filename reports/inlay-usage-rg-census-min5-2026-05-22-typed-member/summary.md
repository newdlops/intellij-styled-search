# Fast RG Usage Census

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **17062**
- Elapsed: 11.9s

## Proxy Result

- Exact proxy match: **3562/17062 = 20.9%**
- Proxy undercount risk: **4988/17062 = 29.2%**
- Proxy overcount: **8512/17062 = 49.9%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | proxy_under% | proxy_over% |
|---|---:|---:|---:|---:|
| class | 8686 | 26.9 | 0.0 | 73.1 |
| field | 5802 | 4.4 | 67.2 | 28.4 |
| function | 2329 | 37.0 | 40.9 | 22.1 |
| method | 245 | 44.5 | 55.5 | 0.0 |

## Top Proxy Under

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:68` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:92` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:116` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:142` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/registration/mutations/test_cancel_registration_assistance_request.py:30` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:31` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:38` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:62` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:69` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:120` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/question_thread/company_question_thread.py:389` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/legal/mutation/test_director_delete.py:14` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/phantom_stock/tests/test_get_phantom_stock_vesting_traceable.py:36` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/phantom_stock/tests/test_get_phantom_stock_vesting_traceable.py:45` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_get_rsu_vesting_traceable.py:40` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_get_rsu_vesting_traceable.py:49` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_get_traceable_vesting_service.py:36` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_get_traceable_vesting_service.py:42` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:20` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:45` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:66` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:91` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:115` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:127` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:103` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:223` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:235` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:443` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/events/tests/test_new_issue_event_model.py:50` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/mutations/test_option_cancel.py:28` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/option/tests/test_option_query_set.py:215` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/option/tests/test_option_query_set.py:223` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/option/tests/test_option_query_set.py:264` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_option_grant_status_detail_excel_writer.py:77` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_option_grant_status_detail_excel_writer.py:82` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_option_grant_status_detail_excel_writer.py:105` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/query/test_permission_for_options_admin.py:45` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/query/test_permission_for_options_admin.py:53` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/query/test_permission_for_options_admin.py:58` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/event_time_machine/test/test_option_related_event_time_travel_test_case.py:75` | `company` | field | 5 | 10701 | 12780 | 10701 |

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +11688 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_agreement_document_update_or_create_mutation.py:75` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_agreement_document_update_or_create_mutation.py:102` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_notice_poa_document_update_or_create_mutation.py:57` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_notice_poa_document_update_or_create_mutation.py:77` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_unissued_confirmation_poa_document_update_or_create_mutation.py:59` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_unissued_confirmation_poa_document_update_or_create_mutation.py:81` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:78` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:121` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_history_mutation.py:105` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_history_mutation.py:170` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_mutation.py:105` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_mutation.py:165` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_company_mutation.py:75` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_company_mutation.py:107` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_history_mutation.py:79` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_history_mutation.py:115` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_cancel_confirm_mutation.py:50` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_cancel_confirm_mutation.py:82` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_confirm_mutation.py:53` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_confirm_mutation.py:77` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_delete_mutation.py:49` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_delete_mutation.py:72` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_claimed_mutation.py:49` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_claimed_mutation.py:66` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_payment_check_requested_mutation.py:51` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_payment_check_requested_mutation.py:70` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_refuse_mutation.py:49` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_refuse_mutation.py:66` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/services/option_grant_contract_template_service.py:410` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/option/services/vesting_traceable_create_service.py:52` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/payment/services/credit_input_validation_service.py:157` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/unlisted_stock_management/individual_stock_option/graphql/mutations/staff_create_individual_stock_option_mutation.py:102` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +11688 | `zuzu/packages/unlisted_stock_management/individual_stock_option/graphql/mutations/staff_create_individual_stock_option_mutation.py:158` | `_` | field | 14064 | 2376 | 11768 | 2376 |
| +8883 | `zuzu/db/models/company/company.py:815` | `name` | function | 13100 | 4217 | 4217 | 2189 |
| +7375 | `zuzu/db/models/question_thread/question_thread.py:551` | `content` | function | 8185 | 810 | 810 | 199 |
| +6213 | `zuzu/db/models/agenda/bonus_issue/agenda_bonus_issue.py:226` | `key` | function | 6910 | 697 | 697 | 4 |
| +5806 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:162` | `Paragraph` | class | 5818 | 12 | 12 | 0 |
| +5456 | `zuzu/packages/ms_word/services/utils/types.py:43` | `Format` | class | 5497 | 41 | 41 | 0 |
| +3364 | `zuzu/db/models/agenda/agenda_new_or_change_rsu_rule/agenda_new_or_change_rsu_rule.py:99` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/authorized_shares_change/agenda_authorized_shares_change.py:52` | `title` | function | 4298 | 934 | 934 | 227 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260522_typed_member/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-22-typed-member/discrepancies.jsonl`
