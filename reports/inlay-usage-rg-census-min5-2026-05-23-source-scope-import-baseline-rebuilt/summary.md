# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158547**
- Elapsed: 11.9s

## Proxy Result

- Exact likely/proxy match: **114130/158547 = 72.0%**
- MAY undercount risk: **0/158547 = 0.0%**
- Likely below proxy but MAY safe: **764/158547 = 0.5%**
- Proxy overcount: **43653/158547 = 27.5%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10244 | 54.1 | 0.0 | 0.0 | 45.9 |
| field | 131054 | 73.1 | 0.0 | 0.5 | 26.3 |
| function | 4113 | 81.1 | 0.0 | 1.3 | 17.7 |
| method | 13136 | 71.8 | 0.0 | 0.1 | 28.2 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +311 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_agreement_document_update_or_create_mutation.py:75` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_agreement_document_update_or_create_mutation.py:102` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_notice_poa_document_update_or_create_mutation.py:57` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_transfer_notice_poa_document_update_or_create_mutation.py:77` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_unissued_confirmation_poa_document_update_or_create_mutation.py:59` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/fi_sta/graphql/mutations/fi_sta_stock_unissued_confirmation_poa_document_update_or_create_mutation.py:81` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:78` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/investment_association/consent_form_or_meeting/graphql/mutations/create_consent_form_or_meeting_mutation.py:121` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_history_mutation.py:105` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_history_mutation.py:170` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_mutation.py:105` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_create_non_unified_share_management_mutation.py:165` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_company_mutation.py:75` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_company_mutation.py:107` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_history_mutation.py:79` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/non_unified_share_management/graphql/mutations/staff_edit_non_unified_share_management_history_mutation.py:115` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_cancel_confirm_mutation.py:50` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_cancel_confirm_mutation.py:82` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_confirm_mutation.py:53` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_confirm_mutation.py:77` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_delete_mutation.py:49` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_delete_mutation.py:72` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_claimed_mutation.py:49` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_claimed_mutation.py:66` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_payment_check_requested_mutation.py:51` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_not_payment_check_requested_mutation.py:70` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_refuse_mutation.py:49` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/option_exercise_management/graphql/mutations/option_exercise_claim_candidates_refuse_mutation.py:66` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/services/option_grant_contract_template_service.py:410` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/option/services/vesting_traceable_create_service.py:52` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/payment/services/credit_input_validation_service.py:157` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/unlisted_stock_management/individual_stock_option/graphql/mutations/staff_create_individual_stock_option_mutation.py:102` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +311 | `zuzu/packages/unlisted_stock_management/individual_stock_option/graphql/mutations/staff_create_individual_stock_option_mutation.py:158` | `_` | field | 8579 | 8268 | 8268 | 2376 |
| +284 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 289 | 5 | 5 | 443 |
| +202 | `zuzu/packages/question_thread/types/general_question_thread_list_type.py:18` | `types` | field | 4544 | 4342 | 323 | 4342 |
| +202 | `zuzu/packages/credit/types.py:76` | `types` | field | 4544 | 4342 | 323 | 4342 |
| +202 | `zuzu/app/graphql/types/__init__.py:318` | `types` | field | 4544 | 4342 | 323 | 4342 |
| +202 | `zuzu/packages/company/event/graphql/queries/first_event_query.py:28` | `types` | field | 4544 | 4342 | 323 | 4342 |
| +202 | `zuzu/packages/investment_simulation/tests/base.py:32` | `types` | field | 4544 | 4342 | 323 | 4342 |
| +202 | `zuzu/common/personal_information/personal_information_logging.py:82` | `types` | field | 4544 | 4342 | 323 | 4342 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_source_scope_import_baseline_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-source-scope-import-baseline-rebuilt/discrepancies.jsonl`
