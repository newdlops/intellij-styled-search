# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/private/tmp/ijss-pyright-lsp/node_modules/.bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **10000**
- Skipped/unknown LSP candidates: 14
- Conservative 95% proportion margin at n=10000: +/-1.0%
- Current graph usage refresh: changed=452, missing=0, errors=0
- Graph usage changed from cached baseline: 8000/10000

## Usage Signal

- Exact match: **6191/10000 = 61.9%**
- Within +/-1: 72.1%
- Within +/-5: 83.7%
- Mean absolute error: 8.44
- Inlay mean: 11.94
- Pyright mean: 3.53

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 4000 | 61.4 | 71.0 | 85.5 | 8.89 | 11.58 | 2.77 |
| class | 2000 | 75.8 | 92.6 | 98.0 | 0.87 | 6.96 | 6.10 |
| function | 2000 | 91.8 | 96.2 | 98.0 | 0.84 | 4.55 | 3.71 |
| constant | 2000 | 19.2 | 29.5 | 51.3 | 22.73 | 25.04 | 2.31 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| match | 6191 | 61.9% |
| inlay_over_no_lsp_refs | 1612 | 16.1% |
| inlay_over_by_1-5 | 1227 | 12.3% |
| inlay_over_by_6-50 | 723 | 7.2% |
| inlay_over_by_50plus | 193 | 1.9% |
| inlay_under_by_1-5 | 34 | 0.3% |
| inlay_missed | 13 | 0.1% |
| inlay_under_by_6-50 | 7 | 0.1% |

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
| -15 | `zuzu/db/models/events/event.py:578` | `get_queryset` | method | 34 | 49 |
| -11 | `zuzu/db/models/purchase/payment/credit_card_payment/credit_card.py:35` | `get_queryset` | method | 12 | 23 |
| -10 | `zuzu/db/models/company/investment_simulation/investment_simulation.py:47` | `get_queryset` | method | 0 | 10 |
| -8 | `zuzu/db/models/stakeholder/employee/employment_status.py:53` | `get_queryset` | method | 11 | 19 |
| -7 | `zuzu/db/models/company/company_query_set.py:38` | `get_queryset` | method | 101 | 108 |
| -7 | `zuzu/db/models/venture_capital/quarterly_report/venture_capital_quarterly_report.py:267` | `get_queryset` | method | 11 | 18 |
| -6 | `zuzu/db/models/subscription/subscription.py:907` | `get_queryset` | method | 68 | 74 |
| -6 | `zuzu/db/models/purchase/purchase.py:243` | `get_queryset` | method | 19 | 25 |
| -5 | `zuzu/db/models/hrm/attendance/work/hrm_staggered_work_schedule.py:119` | `get_queryset` | method | 1 | 6 |
| -5 | `zuzu/db/models/venture_capital/quarterly_report/venture_capital_quarterly_report_item_reply.py:52` | `get_queryset` | method | 13 | 18 |
| -4 | `zuzu/db/models/company/credit/charge.py:40` | `get_queryset` | method | 3 | 7 |
| -4 | `zuzu/db/models/investment_association/partner/investment_association_partner.py:236` | `get_queryset` | method | 28 | 32 |
| -4 | `zuzu/db/models/company/credit/credit_use.py:45` | `get_queryset` | method | 12 | 16 |
| -4 | `zuzu/db/models/agenda/option_grant/agenda_option_grant_grantee.py:43` | `get_queryset` | method | 1 | 5 |
| -3 | `zuzu/db/models/company/right_to_consent_or_consult/right_to_consent_or_consult.py:27` | `get_queryset` | method | 0 | 3 |
| -3 | `zuzu/db/models/venture_capital/fund.py:26` | `get_queryset` | method | 3 | 6 |
| -3 | `zuzu/db/models/option/option_exercise/option_exercise_management.py:148` | `get_queryset` | method | 5 | 8 |
| -3 | `zuzu/db/models/phantom_stock/phantom_stock_vesting/phantom_stock_vesting_item.py:25` | `get_queryset` | method | 1 | 4 |
| -3 | `zuzu/db/models/events/stock/stock_event_base.py:28` | `get_queryset` | method | 0 | 3 |
| -2 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/ia_meeting_sealed_notice_document_file.py:36` | `get_queryset` | method | 3 | 5 |
| -2 | `zuzu/db/models/question_thread/question_message_attachment.py:33` | `get_queryset` | method | 5 | 7 |
| -2 | `zuzu/db/models/consent_form/consent_form.py:98` | `get_queryset` | method | 2 | 4 |
| -2 | `zuzu/db/models/company_managing_entity/bulk_email/cme_bulk_email_template.py:30` | `get_queryset` | method | 0 | 2 |
| -2 | `zuzu/db/models/investment_association/consent_form_or_meeting/meeting/agendas/base/ia_meeting_agenda_vote.py:28` | `get_queryset` | method | 1 | 3 |
| -2 | `zuzu/db/models/agenda/option_cancel/agenda_option_cancel_option.py:33` | `get_queryset` | method | 0 | 2 |
| -2 | `zuzu/vcm/models/company/vcm_company.py:62` | `get_queryset` | method | 3 | 5 |
| -2 | `zuzu/db/models/two_factor_authentication.py:106` | `get_queryset` | method | 9 | 11 |
| -2 | `zuzu/db/models/investor_relations/im_access_log.py:26` | `get_queryset` | method | 1 | 3 |
| -2 | `zuzu/vcm/models/ir/alert/vcm_ir_alert.py:59` | `get_queryset` | method | 4 | 6 |
| -2 | `zuzu/db/models/investor_relations/im_watching.py:26` | `get_queryset` | method | 2 | 4 |

## Artifacts

- Population: `/tmp/inlay_usage_10000_20260520_resample_1/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_10000_20260520_resample_1/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_10000_20260520_resample_1/lsp_usage_skipped.jsonl`
- Discrepancies: `reports/inlay-usage-10000-2026-05-20-resample-1-no-unknown-getqueryset/discrepancies.jsonl`
