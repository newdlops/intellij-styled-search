# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 14
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=88, missing=0, errors=0
- Graph usage changed from cached baseline: 8000/10000

## Usage Signal

- Exact match: **6167/10000 = 61.7%**
- Within +/-1: 71.8%
- Within +/-5: 83.4%
- Mean absolute error: 8.51
- Inlay mean: 12.03
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 60.8 | 70.4 | 84.8 | 9.05 | 11.79 | 2.77 |
| class | 2000 | 75.8 | 92.6 | 98.0 | 0.87 | 6.96 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.84 | 4.55 | 3.71 |
| constant | 2000 | 19.2 | 29.5 | 51.3 | 22.73 | 25.04 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 6167 | 61.7% |
| inlay_over_no_lsp_refs | 1634 | 16.3% |
| inlay_over_by_1-5 | 1236 | 12.4% |
| inlay_over_by_6-50 | 743 | 7.4% |
| inlay_over_by_50plus | 195 | 1.9% |
| inlay_under_by_1-5 | 18 | 0.2% |
| inlay_missed | 6 | 0.1% |
| inlay_under_by_6-50 | 1 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4870 | `zuzu/common/factory/base.py:73` | `create` | method | 4870 | 0 |
| +4058 | `zuzu/packages/company/payroll/ai_payroll_ledger/graphql/mutations/staff_create_payroll_ledger_ai_analysis_mutation.py:49` | `model_name` | constant | 4058 | 0 |
| +1851 | `zuzu/common/logging.py:16` | `filter` | method | 1851 | 0 |
| +992 | `zuzu/cms/admin/portal_academy_guide/portal_academy_guide.py:14` | `model` | constant | 992 | 0 |
| +569 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 571 | 2 |
| +513 | `zuzu/packages/question_thread/types/question_thread_message_reviewer_type.py:26` | `full_name` | method | 513 | 0 |
| +511 | `zuzu/packages/user/types/visit_user_type.py:14` | `full_name` | constant | 511 | 0 |
| +510 | `zuzu/packages/unlisted_stock_management/graphql/types.py:55` | `full_name` | constant | 510 | 0 |
| +476 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 485 | 9 |
| +425 | `zuzu/packages/company/capital/capital_service.py:86` | `date` | method | 425 | 0 |
| +405 | `zuzu/db/models/meeting_document/shareholders_meeting_audit_report_document.py:65` | `date` | method | 408 | 3 |
| +404 | `zuzu/db/models/meeting_document/shareholders_written_resolution_document.py:67` | `date` | method | 406 | 2 |
| +404 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_document.py:63` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/new_issue_stock_acceptance_document.py:79` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/debt_confirmation_and_offset_contract_document.py:84` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/new_issue_stock_unissued_confirmation_document.py:74` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/shareholders_meeting_power_of_attorney_individual_document.py:85` | `date` | method | 404 | 0 |
| +404 | `zuzu/db/models/meeting_document/shareholders_meeting_minutes_document.py:96` | `date` | method | 404 | 0 |
| +395 | `zuzu/app/graphql/types/co_ceo_system_change_input.py:5` | `date` | constant | 396 | 1 |
| +393 | `zuzu/packages/with_shareholder_role/payroll/graphql/queries/portal_cash_compensations_query.py:27` | `count` | constant | 393 | 0 |
| +393 | `zuzu/packages/option/graphql/mutations/option_pause_mutation.py:39` | `date` | constant | 393 | 0 |
| +392 | `zuzu/packages/investment_association/document/services/ia_partner_certificate_of_investment_document_service.py:96` | `date` | constant | 395 | 3 |
| +392 | `zuzu/packages/stock_unissued_confirmation_request/types.py:20` | `date` | constant | 392 | 0 |
| +392 | `zuzu/packages/document/options/predefined_options.py:123` | `date` | function | 396 | 4 |
| +391 | `zuzu/common/factory/company/company_option_rule_factory.py:31` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/investment_association/consent_form_or_meeting/types.py:76` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/document/graphql/types.py:614` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/with_shareholder_role/shareholder/types.py:52` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/with_shareholder_role/employee_stock/types.py:97` | `date` | constant | 391 | 0 |
| +391 | `zuzu/packages/phantom_stock/graphql/types/types.py:161` | `date` | constant | 391 | 0 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -8 | `zuzu/db/models/stakeholder/employee/employment_status.py:53` | `get_queryset` | method | 11 | 19 |
| -5 | `zuzu/db/models/company/company_query_set.py:38` | `get_queryset` | method | 103 | 108 |
| -4 | `zuzu/db/models/subscription/subscription.py:907` | `get_queryset` | method | 70 | 74 |
| -4 | `zuzu/db/models/investment_association/partner/investment_association_partner.py:236` | `get_queryset` | method | 28 | 32 |
| -4 | `zuzu/db/models/agenda/option_grant/agenda_option_grant_grantee.py:43` | `get_queryset` | method | 1 | 5 |
| -2 | `zuzu/db/models/question_thread/question_message_attachment.py:33` | `get_queryset` | method | 5 | 7 |
| -2 | `zuzu/db/models/agenda/option_cancel/agenda_option_cancel_option.py:33` | `get_queryset` | method | 0 | 2 |
| -2 | `zuzu/vcm/models/company/vcm_company.py:62` | `get_queryset` | method | 3 | 5 |
| -2 | `zuzu/vcm/models/ir/alert/vcm_ir_alert.py:59` | `get_queryset` | method | 4 | 6 |
| -2 | `zuzu/db/models/phantom_stock/phantom_stock_vesting/phantom_stock_vesting_item.py:25` | `get_queryset` | method | 2 | 4 |
| -2 | `zuzu/db/models/investor_relations/im_watching.py:26` | `get_queryset` | method | 2 | 4 |
| -1 | `zuzu/db/models/stock.py:174` | `get_queryset` | method | 2 | 3 |
| -1 | `zuzu/db/models/purchase/payment/credit_card_payment/credit_card.py:35` | `get_queryset` | method | 22 | 23 |
| -1 | `zuzu/db/models/investor_relations/ir_insight_club/ir_insight_club_participation.py:19` | `get_queryset` | method | 4 | 5 |
| -1 | `zuzu/db/models/hrm/leave/hrm_leave_common_config.py:17` | `get_queryset` | method | 0 | 1 |
| -1 | `zuzu/db/models/hrm/leave/annual_leave/hrm_annual_leave_adjustment.py:17` | `get_queryset` | method | 3 | 4 |
| -1 | `zuzu/db/models/individual_investor/individual_event/individual_stock_option/individual_stock_option_exercise_event.py:32` | `get_queryset` | method | 0 | 1 |
| -1 | `zuzu/db/models/investor_relations/ir_alert/ir_alert.py:60` | `get_queryset` | method | 5 | 6 |
| -1 | `zuzu/vcm/models/fund_proposal/vcm_fund_proposal_attachment.py:31` | `get_queryset` | method | 1 | 2 |
| -1 | `zuzu/db/models/shareholders_agreement/modusign_documents/shareholders_agreement_modusign_document.py:48` | `get_queryset` | method | 0 | 1 |
| -1 | `zuzu/db/models/investment_association/event/share_event/ia_founding_meeting_event.py:21` | `get_queryset` | method | 2 | 3 |
| -1 | `zuzu/vcm/models/feed/vcm_company_news_feed.py:29` | `get_queryset` | method | 1 | 2 |
| -1 | `zuzu/db/models/investor_relations/feed/company_feed/company_ir_new_commit_feed.py:21` | `get_queryset` | method | 0 | 1 |
| -1 | `zuzu/db/models/investor_relations/im_access_log.py:26` | `get_queryset` | method | 2 | 3 |
| -1 | `zuzu/vcm/models/ir/approval/vcm_ir_approval.py:31` | `get_queryset` | method | 0 | 1 |

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-related-getqueryset/discrepancies.jsonl`
