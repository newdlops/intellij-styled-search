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
- Current graph usage refresh: changed=25633, missing=0, errors=0
- Graph usage changed from cached baseline: 25638/25706

## Usage Signal

- Exact match: **38/25706 = 0.1%**
- Within +/-1: 0.4%
- Within +/-5: 16.6%
- Mean absolute error: 52.91
- Inlay mean: 60.22
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 0.0 | 0.0 | 0.0 | 73.22 | 77.58 | 4.39 |
| class | 4903 | 0.7 | 2.0 | 67.0 | 7.54 | 23.85 | 18.00 |
| method | 2823 | 0.0 | 0.0 | 0.1 | 28.33 | 35.50 | 7.18 |
| function | 1149 | 0.5 | 1.0 | 84.2 | 9.45 | 21.80 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_50plus | 8457 | 32.9% |
| inlay_over_no_lsp_refs | 6727 | 26.2% |
| inlay_over_by_6-50 | 6143 | 23.9% |
| inlay_over_by_1-5 | 4089 | 15.9% |
| inlay_under_by_6-50 | 131 | 0.5% |
| inlay_under_by_1-5 | 99 | 0.4% |
| match | 38 | 0.1% |
| inlay_under_by_50plus | 22 | 0.1% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +4107 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4112 | 5 |
| +4106 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4106 | 0 |
| +3393 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 3398 | 5 |
| +1152 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1152 | 0 |
| +925 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 952 | 27 |
| +925 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 926 | 1 |
| +925 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 926 | 1 |
| +925 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 939 | 14 |
| +925 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 931 | 6 |
| +851 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 852 | 1 |
| +667 | `zuzu/common/factory/base.py:132` | `fake` | function | 673 | 6 |
| +659 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:40` | `output_field` | constant | 659 | 0 |
| +659 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:114` | `output_field` | constant | 659 | 0 |
| +658 | `zuzu/db/models/hrm/attendance/work/db_functions.py:9` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:45` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:51` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:57` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:62` | `output_field` | constant | 658 | 0 |
| +658 | `zuzu/db/models/hrm/leave/usage/hrm_leave_usage_item.py:85` | `output_field` | constant | 658 | 0 |
| +657 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 658 | 1 |
| +606 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 612 | 6 |
| +590 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 590 | 0 |
| +545 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:92` | `choices` | constant | 550 | 5 |
| +507 | `zuzu/staff/admin/input_filter.py:15` | `choices` | method | 507 | 0 |
| +472 | `zuzu/common/models/protocol.py:11` | `exists` | method | 472 | 0 |
| +406 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 471 | 65 |
| +397 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 399 | 2 |
| +392 | `zuzu/packages/company/graphql/types/company_list_item_type.py:121` | `establishment_date` | constant | 392 | 0 |
| +392 | `zuzu/packages/company/types.py:12` | `establishment_date` | constant | 394 | 2 |
| +391 | `zuzu/vcm/models/company/vcm_company.py:125` | `establishment_date` | constant | 392 | 1 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| -184 | `zuzu/db/models/incorporation_request/incorporation_request.py:228` | `IncorporationRequest` | class | 102 | 286 |
| -148 | `zuzu/packages/alimtalk/types.py:5` | `AlimtalkRecipient` | class | 100 | 248 |
| -127 | `zuzu/common/factory/stock/stock_factory.py:47` | `StockFactory` | class | 79 | 206 |
| -117 | `zuzu/db/models/shareholders_meeting.py:205` | `ShareholdersMeeting` | class | 129 | 246 |
| -112 | `zuzu/common/factory/articles_of_incorporation/articles_of_incorporation_factory.py:19` | `ArticlesOfIncorporationFactory` | class | 75 | 187 |
| -100 | `zuzu/db/models/stock.py:183` | `Stock` | class | 123 | 223 |
| -94 | `zuzu/db/models/option/option_exercise/option_exercise_management.py:152` | `OptionExerciseManagement` | class | 75 | 169 |
| -87 | `zuzu/db/models/shareholders_meeting_agenda.py:347` | `ShareholdersMeetingAgenda` | class | 94 | 181 |
| -86 | `zuzu/db/models/incorporation_request/incorporation_request_assistance.py:31` | `IncorporationRequestAssistance` | class | 27 | 113 |
| -84 | `zuzu/db/models/modusign/modusign_document.py:148` | `ModusignDocument` | class | 136 | 220 |
| -83 | `zuzu/db/models/directors_meeting.py:88` | `DirectorsMeeting` | class | 110 | 193 |
| -81 | `zuzu/db/models/events/event.py:591` | `Event` | class | 183 | 264 |
| -81 | `zuzu/db/models/option/option_exercise/option_exercise_claim.py:143` | `OptionExerciseClaim` | class | 75 | 156 |
| -70 | `zuzu/db/models/articles_of_incorporation/articles_of_incorporation.py:92` | `ArticlesOfIncorporation` | class | 65 | 135 |
| -69 | `zuzu/packages/investment_association/owner/graphql/decorators/investment_association_owner_required.py:18` | `investment_association_owner_required` | function | 138 | 207 |
| -60 | `zuzu/db/models/directors_meeting_agenda.py:210` | `DirectorsMeetingAgenda` | class | 78 | 138 |
| -57 | `zuzu/db/models/events/director/director_term_end_event.py:32` | `DirectorTermEndEvent` | class | 75 | 132 |
| -55 | `zuzu/db/models/stakeholder/director/director.py:59` | `AUDITOR` | constant | 121 | 176 |
| -55 | `zuzu/db/models/agenda/new_issue/agenda_new_issue.py:65` | `AgendaNewIssue` | class | 66 | 121 |
| -53 | `zuzu/db/models/stakeholder/director/director.py:56` | `CO_CEO` | constant | 107 | 160 |
| -53 | `zuzu/db/models/captable_request.py:56` | `CaptableRequest` | class | 40 | 93 |
| -53 | `zuzu/db/models/events/stock/stock_transfer_event.py:93` | `StockTransferEvent` | class | 59 | 112 |
| -48 | `zuzu/common/services/service.py:14` | `ServiceContext` | class | 87 | 135 |
| -48 | `zuzu/db/models/company/investment_simulation/investment_simulation.py:51` | `InvestmentSimulation` | class | 36 | 84 |
| -48 | `zuzu/db/models/events/director/director_appointment_event.py:400` | `DirectorAppointmentEvent` | class | 78 | 126 |
| -46 | `zuzu/db/models/events/stock/bonus_issue_event.py:45` | `BonusIssueEvent` | class | 30 | 76 |
| -42 | `zuzu/db/models/purchase/service_fee/service_fee.py:49` | `ServiceFee` | class | 35 | 77 |
| -40 | `zuzu/common/factory/shareholders_meeting_agenda_factory.py:19` | `ShareholdersMeetingAgendaFactory` | class | 80 | 120 |
| -40 | `zuzu/db/models/hrm/dept/hrm_dept.py:201` | `HrmDept` | class | 125 | 165 |
| -40 | `zuzu/packages/document/options/__init__.py:33` | `DocumentOption` | class | 191 | 231 |

## Artifacts

- Source candidate pool: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/sample_candidates.jsonl`
- Source valid LSP results: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_results.jsonl`
- Refreshed valid results: `reports/inlay-usage-census-min5-2026-05-20-python-bare-fallback-gated/lsp_usage_results_refreshed.jsonl`
- Source timeout quarantine: `/private/tmp/inlay_usage_census_min5_20260520_datepruned/lsp_usage_timeouts.jsonl`
- Discrepancies: `reports/inlay-usage-census-min5-2026-05-20-python-bare-fallback-gated/discrepancies.jsonl`
