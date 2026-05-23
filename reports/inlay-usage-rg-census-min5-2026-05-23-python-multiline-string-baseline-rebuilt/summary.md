# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158367**
- Elapsed: 12.4s

## Proxy Result

- Exact likely/proxy match: **133651/158367 = 84.4%**
- MAY undercount risk: **0/158367 = 0.0%**
- Likely below proxy but MAY safe: **92/158367 = 0.1%**
- Proxy overcount: **24624/158367 = 15.5%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10179 | 96.7 | 0.0 | 0.0 | 3.3 |
| field | 130961 | 81.8 | 0.0 | 0.0 | 18.2 |
| function | 4102 | 97.7 | 0.0 | 2.2 | 0.1 |
| method | 13125 | 96.6 | 0.0 | 0.0 | 3.4 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +284 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 289 | 5 | 5 | 443 |
| +201 | `zuzu/packages/question_thread/types/general_question_thread_list_type.py:18` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/packages/credit/types.py:76` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/app/graphql/types/__init__.py:318` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/packages/company/event/graphql/queries/first_event_query.py:28` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/packages/investment_simulation/tests/base.py:32` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/common/personal_information/personal_information_logging.py:82` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/common/personal_information/personal_information_log_builder.py:44` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/common/personal_information/personal_information_log_builder.py:73` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +201 | `zuzu/packages/question_thread/types/question_thread_message_type.py:57` | `types` | field | 4543 | 4342 | 323 | 4342 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +133 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 139 | 6 | 6 | 149 |
| +132 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_agreement_document_update_or_create_mutation.py:75` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_agreement_document_update_or_create_mutation.py:102` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_notice_poa_document_update_or_create_mutation.py:57` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_notice_poa_document_update_or_create_mutation.py:77` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_unissued_confirmation_poa_document_update_or_create_mutation.py:59` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_unissued_confirmation_poa_document_update_or_create_mutation.py:81` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:78` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:121` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_history_mutation.py:105` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_history_mutation.py:170` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_mutation.py:105` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_mutation.py:165` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_company_mutation.py:75` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_company_mutation.py:107` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_history_mutation.py:79` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_history_mutation.py:115` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_cancel_confirm_mutation.py:50` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_cancel_confirm_mutation.py:82` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_confirm_mutation.py:53` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_confirm_mutation.py:77` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_delete_mutation.py:49` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_delete_mutation.py:72` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_claimed_mutation.py:49` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_claimed_mutation.py:66` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_payment_check_requested_mutation.py:51` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_payment_check_requested_mutation.py:70` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_refuse_mutation.py:49` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_refuse_mutation.py:66` | `_` | field | 8400 | 8268 | 8268 | 2376 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_python_multiline_string_baseline_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-python-multiline-string-baseline-rebuilt/discrepancies.jsonl`
