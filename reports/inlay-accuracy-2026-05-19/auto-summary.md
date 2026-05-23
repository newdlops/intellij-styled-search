# Inlay Accuracy Measurement

- Sample size: **1359**
- Ground truth: Pyright (`pyright-langserver` via LSP) — Pylance proxy
- Scope: `zuzu/` Python files, excluding migrations

## Signal: `usage`

- Effective sample: 512 (skipped 847 no-LSP-resp)
- Exact match: **296/512 = 57.8%**
- Within ±1: 73.6%
- Within ±5: 85.0%
- Mean Absolute Error: 50.66
- Inlay mean: 51.63  |  Pyright mean: 5.77

### Per-kind accuracy

| kind | n | exact% | ±1% | ±5% | MAE | inlaȳ | pyright̄ |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 230 | 47.8 | 63.9 | 73.0 | 108.53 | 107.57 | 6.93 |
| class | 100 | 68.0 | 91.0 | 96.0 | 5.23 | 9.92 | 5.45 |
| constant | 93 | 43.0 | 61.3 | 89.2 | 4.54 | 3.66 | 5.12 |
| function | 89 | 87.6 | 92.1 | 98.9 | 0.35 | 4.03 | 3.80 |

### Error pattern distribution

| tag | n | % |
|---|---:|---:|
| match | 296 | 57.8% |
| inlay_over_by_1-5 | 69 | 13.5% |
| inlay_over_no_lsp_refs | 48 | 9.4% |
| inlay_under_by_1-5 | 33 | 6.4% |
| inlay_over_by_6-50 | 30 | 5.9% |
| inlay_over_by_50plus | 17 | 3.3% |
| inlay_missed | 11 | 2.1% |
| inlay_under_by_6-50 | 7 | 1.4% |
| inlay_under_by_50plus | 1 | 0.2% |

### Sample discrepancies

**inlay_missed**

- `zuzu/packages/notification/base/ia_owner_slack_notification.py:45` `link_url` (method) — inlay usage=0, pyright=1
- `zuzu/db/models/email_activity/email_activity_recipient_status_history.py:30` `ault` (method) — inlay usage=0, pyright=290
- `zuzu/db/models/agenda/head_office_relocation_aoi_change/agenda_head_office_relocation_aoi_change.py:52` `title` (method) — inlay usage=0, pyright=3

**inlay_over_no_lsp_refs**

- `zuzu/packages/document/document_types/incorporation_stock_acceptance_document.py:86` `remarks` (method) — inlay usage=55, pyright=0
- `zuzu/common/auth/backends/axes_backend.py:10` `authenticate` (method) — inlay usage=8, pyright=0
- `zuzu/packages/question_thread/mutations/question_message_publish_mutation.py:48` `message` (constant) — inlay usage=11, pyright=0

**inlay_under_by_6-50**

- `zuzu/packages/user_activity/types.py:7` `UserActivityKind` (class) — inlay usage=22, pyright=39
- `zuzu/db/models/stakeholder/director/director_term.py:136` `_aoi` (method) — inlay usage=6, pyright=13
- `zuzu/db/models/investment_association/rule/ia_rule_compensation.py:41` `ManagementCompensationMethodId` (class) — inlay usage=19, pyright=25

**inlay_over_by_1-5**

- `zuzu/db/models/tan_table_view/company_tan_table_view.py:27` `CompanyTanTableView` (class) — inlay usage=11, pyright=9
- `zuzu/db/models/investment_association/investment_association.py:427` `account_info` (method) — inlay usage=4, pyright=3
- `zuzu/packages/vcm/pfc/graphql/mutations/vcm_edit_pfc_mutation.py:51` `investor` (constant) — inlay usage=4, pyright=1

**inlay_under_by_1-5**

- `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:65` `address` (constant) — inlay usage=1, pyright=6
- `zuzu/packages/stock/graphql/mutations/bonus_issue_mutation.py:31` `BonusIssueErrors` (class) — inlay usage=3, pyright=4
- `zuzu/packages/corporate_registration/graphql/types.py:536` `CorporateRegistrationComparisonResultType` (class) — inlay usage=4, pyright=5

**inlay_over_by_6-50**

- `zuzu/common/models/tests/test_purchasable_queryset_annotate_failed.py:27` `create_purchase` (method) — inlay usage=23, pyright=9
- `zuzu/db/models/rsu/rsu_query_set_mixin/rsu_quantity_query_set_mixin.py:149` `annotate_canceled_quantity_at` (method) — inlay usage=20, pyright=7
- `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:60` `canceled` (method) — inlay usage=11, pyright=3

**inlay_over_by_50plus**

- `zuzu/common/personal_information/personal_information_log_builder.py:40` `append` (method) — inlay usage=1547, pyright=21
- `zuzu/packages/document/document_types/option_exercise_claim_document/option_exercise_claim_document.py:274` `payment_date` (method) — inlay usage=110, pyright=1
- `zuzu/db/models/investment_association/consent_form_or_meeting/ia_consent_form_or_meeting.py:95` `Type` (class) — inlay usage=474, pyright=17

**inlay_under_by_50plus**

- `zuzu/db/models/company/company.py:1860` `output_field` (constant) — inlay usage=1, pyright=199

## Signal: `impl`

- Effective sample: 421 (skipped 938 no-LSP-resp)
- Exact match: **339/421 = 80.5%**
- Within ±1: 93.3%
- Within ±5: 96.2%
- Mean Absolute Error: 31.24
- Inlay mean: 31.24  |  Pyright mean: 0.00

### Per-kind accuracy

| kind | n | exact% | ±1% | ±5% | MAE | inlaȳ | pyright̄ |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 230 | 77.8 | 94.8 | 98.7 | 0.59 | 0.59 | 0.00 |
| class | 100 | 72.0 | 84.0 | 87.0 | 130.13 | 130.13 | 0.00 |
| function | 91 | 96.7 | 100.0 | 100.0 | 0.03 | 0.03 | 0.00 |

### Error pattern distribution

| tag | n | % |
|---|---:|---:|
| match | 339 | 80.5% |
| inlay_over_no_lsp_refs | 82 | 19.5% |

### Sample discrepancies

**inlay_over_no_lsp_refs**

- `zuzu/packages/notification/base/ia_owner_slack_notification.py:45` `link_url` (method) — inlay impl=36, pyright=0
- `zuzu/packages/vcm/notification/base/abstract_vcm_investor_users_notification.py:43` `alimtalk_template_parameter` (method) — inlay impl=1, pyright=0
- `zuzu/common/models/fixed_inheritance.py:71` `FixedInheritanceManagerMixin` (class) — inlay impl=10, pyright=0
