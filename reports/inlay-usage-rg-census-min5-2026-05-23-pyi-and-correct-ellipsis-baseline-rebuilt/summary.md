# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158367**
- Elapsed: 11.8s

## Proxy Result

- Exact likely/proxy match: **148896/158367 = 94.0%**
- MAY undercount risk: **0/158367 = 0.0%**
- Likely below proxy but MAY safe: **9069/158367 = 5.7%**
- Proxy overcount: **402/158367 = 0.3%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10179 | 96.9 | 0.0 | 0.0 | 3.1 |
| field | 130961 | 93.0 | 0.0 | 6.9 | 0.1 |
| function | 4102 | 99.8 | 0.0 | 0.0 | 0.2 |
| method | 13125 | 99.8 | 0.0 | 0.2 | 0.0 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +284 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 289 | 5 | 5 | 443 |
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
| +132 | `zuzu/packages/option/services/option_grant_contract_template_service.py:410` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/option/services/vesting_traceable_create_service.py:52` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/payment/services/credit_input_validation_service.py:157` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/unlisted_stock_management/individual_stock_option/graphql/mutations/staff_create_individual_stock_option_mutation.py:102` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +132 | `zuzu/packages/unlisted_stock_management/individual_stock_option/graphql/mutations/staff_create_individual_stock_option_mutation.py:158` | `_` | field | 8400 | 8268 | 8268 | 2376 |
| +115 | `zuzu/db/models/subscription/subscription_perk.py:159` | `PerkType` | class | 116 | 1 | 1 | 107 |
| +109 | `zuzu/fi_sta/models/fi_sta_user.py:43` | `Role` | class | 114 | 5 | 5 | 443 |
| +91 | `zuzu/db/models/subscription/subscription_perk.py:172` | `PerkMethod` | class | 92 | 1 | 1 | 85 |
| +82 | `zuzu/db/models/question_thread/question_thread_message_profile.py:13` | `ProfileType` | class | 84 | 2 | 2 | 81 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_pyi_and_correct_ellipsis_baseline_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-pyi-and-correct-ellipsis-baseline-rebuilt/discrepancies.jsonl`
