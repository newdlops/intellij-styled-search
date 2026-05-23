# Inlay Usage Accuracy Rerun

- Date: 2026-05-19
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Pyright: `/Users/lky/project/captain/.venv/bin/pyright-langserver` (unavailable)
- django-stubs: django-stubs 5.0.2
- Valid LSP usage sample: **888**
- Dropped cached LSP symbols missing from current graph: 112
- Skipped/unknown LSP candidates: 21
- Conservative 95% proportion margin at n=888: +/-3.3%
- Current graph usage refresh: changed=6, missing=112, errors=0
- Graph usage changed from cached baseline: 888/888

## Usage Signal

- Exact match: **3/888 = 0.3%**
- Within +/-1: 0.6%
- Within +/-5: 82.0%
- Mean absolute error: 51.12
- Inlay mean: 55.11
- Pyright mean: 3.99

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| method | 399 | 0.5 | 0.8 | 76.7 | 102.32 | 105.52 | 3.20 |
| class | 200 | 0.0 | 0.5 | 93.0 | 3.81 | 9.87 | 6.07 |
| function | 199 | 0.5 | 0.5 | 96.0 | 3.30 | 7.29 | 3.99 |
| constant | 90 | 0.0 | 0.0 | 50.0 | 35.02 | 37.91 | 2.89 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_1-5 | 615 | 69.3% |
| inlay_over_no_lsp_refs | 135 | 15.2% |
| inlay_over_by_6-50 | 89 | 10.0% |
| inlay_over_by_50plus | 46 | 5.2% |
| match | 3 | 0.3% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +2374 | `zuzu/db/models/hrm/attendance/work/hrm_staggered_work.py:75` | `get_queryset` | method | 2376 | 2 |
| +2373 | `zuzu/db/models/investor_relations/company_feed_rating.py:25` | `get_queryset` | method | 2373 | 0 |
| +2373 | `zuzu/db/models/company/company_purpose_change.py:38` | `get_queryset` | method | 2373 | 0 |
| +2373 | `zuzu/db/models/stakeholder/esop_participant.py:57` | `get_queryset` | method | 2374 | 1 |
| +2372 | `zuzu/vcm/models/feed/vcm_company_ir_open_feed.py:27` | `get_queryset` | method | 2373 | 1 |
| +2372 | `zuzu/db/models/investment_association/event/share_event/payment_term_partner_investment_event.py:26` | `get_queryset` | method | 2373 | 1 |
| +2371 | `zuzu/db/models/events/stock/stock_transfer_event.py:89` | `get_queryset` | method | 2373 | 2 |
| +2371 | `zuzu/db/models/department/department.py:56` | `get_queryset` | method | 2374 | 3 |
| +2370 | `zuzu/db/models/user/user_session_log.py:44` | `get_queryset` | method | 2373 | 3 |
| +2369 | `zuzu/db/models/company/payroll/year_end_tax_settlement/yets_assistance/yets_assistance.py:184` | `get_queryset` | method | 2375 | 6 |
| +2368 | `zuzu/db/models/investor_relations/im_broker/im_broker_assignment.py:42` | `get_queryset` | method | 2374 | 6 |
| +2368 | `zuzu/vcm/models/pfc/vcm_pfc.py:49` | `get_queryset` | method | 2375 | 7 |
| +2354 | `zuzu/db/models/stakeholder/employee/employment_status.py:53` | `get_queryset` | method | 2373 | 19 |
| +1994 | `zuzu/packages/stock/graphql/mutations/tests/test_new_issue_mutation.py:18` | `create` | method | 1995 | 1 |
| +1994 | `zuzu/db/models/registration_form_text/registration_form_text_new_or_change_rsu_rule.py:16` | `create` | method | 1995 | 1 |
| +1108 | `zuzu/db/models/hrm/emp/hrm_emp.py:1395` | `save` | method | 1114 | 6 |
| +894 | `zuzu/common/factory/payment/ia_payment_link_factory.py:16` | `model` | constant | 894 | 0 |
| +530 | `zuzu/db/models/investment_association/rule/ia_rule.py:293` | `meeting` | method | 535 | 5 |
| +394 | `zuzu/db/models/meeting_document/director_decision_document.py:69` | `date` | method | 394 | 0 |
| +284 | `zuzu/packages/unlisted_stock_management/investment_association/notifications/register_usm_ia_investment_certificate_registration_request_notification.py:37` | `investment_association` | constant | 288 | 4 |
| +284 | `zuzu/packages/investment_association/pf_company/notifications/edit_ia_pf_company_investment_sales_intent_slack_notification.py:42` | `investment_association` | method | 286 | 2 |
| +275 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 276 | 1 |
| +256 | `zuzu/packages/stock/replayable/stock_conversion_replayable.py:14` | `shareholder` | constant | 257 | 1 |
| +175 | `zuzu/packages/company/payroll/ai_payroll_ledger/excel_writers/ai_payroll_ledger_excel_writer.py:119` | `write` | method | 176 | 1 |
| +147 | `zuzu/db/models/modusign/modusign_api_log.py:38` | `status_code` | constant | 148 | 1 |
| +143 | `zuzu/packages/investor_relations/notifications/remind_ir_contact_request_notification.py:32` | `url` | method | 145 | 2 |
| +143 | `zuzu/packages/subscription/notifications/subscription_renew_slack_notification.py:44` | `url` | method | 144 | 1 |
| +141 | `zuzu/common/management/commands/post_dump.py:108` | `handle` | method | 141 | 0 |
| +128 | `zuzu/packages/document/document_types/iros_otp_issue_document.py:32` | `director` | constant | 136 | 8 |
| +119 | `zuzu/db/models/events/event.py:672` | `cast` | method | 155 | 36 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Population: `/tmp/inlay_usage_1000_20260519/population.jsonl`
- Candidate pool: `/tmp/inlay_usage_1000_20260519/sample_candidates.jsonl`
- Valid LSP results: `/tmp/inlay_usage_1000_20260519/lsp_usage_results.jsonl`
- Skipped LSP candidates: `/tmp/inlay_usage_1000_20260519/lsp_usage_skipped.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-1000-2026-05-19/discrepancies.jsonl`
