# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158547**
- Elapsed: 12.7s

## Proxy Result

- Exact likely/proxy match: **95201/158547 = 60.0%**
- MAY undercount risk: **0/158547 = 0.0%**
- Likely below proxy but MAY safe: **38318/158547 = 24.2%**
- Proxy overcount: **25028/158547 = 15.8%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10244 | 33.9 | 0.0 | 22.4 | 43.7 |
| field | 131054 | 59.7 | 0.0 | 26.6 | 13.7 |
| function | 4113 | 71.9 | 0.0 | 11.0 | 17.1 |
| method | 13136 | 80.5 | 0.0 | 5.2 | 14.3 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +284 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 289 | 5 | 5 | 443 |
| +182 | `zuzu/db/models/meeting_draft/meeting_draft.py:56` | `AgendaType` | class | 183 | 1 | 1 | 180 |
| +181 | `zuzu/db/models/company/company.py:815` | `name` | function | 1295 | 1114 | 1114 | 2189 |
| +133 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 139 | 6 | 6 | 149 |
| +115 | `zuzu/db/models/subscription/subscription_perk.py:159` | `PerkType` | class | 116 | 1 | 1 | 107 |
| +109 | `zuzu/fi_sta/models/fi_sta_user.py:43` | `Role` | class | 114 | 5 | 5 | 443 |
| +107 | `zuzu/common/personal_information/personal_information_log_builder.py:40` | `append` | method | 1309 | 1202 | 0 | 1202 |
| +107 | `zuzu/packages/ms_word/services/utils/types.py:8` | `append` | field | 1309 | 1202 | 0 | 1202 |
| +91 | `zuzu/db/models/subscription/subscription_perk.py:172` | `PerkMethod` | class | 92 | 1 | 1 | 85 |
| +87 | `zuzu/packages/document/views/document_docx_view.py:22` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/document/views/document_html_view.py:9` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/document/views/document_image_view.py:19` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/document/views/document_pdf_view.py:29` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/document/views/document_view.py:194` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/fi_sta/views/fi_sta_document_view.py:54` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/fi_sta/views/fi_sta_modusign_document_view.py:75` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/document/views/investment_association_document_view.py:112` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/company/meeting/document/views/meeting_document_view.py:60` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +87 | `zuzu/packages/company/payroll/year_end_tax_settlement/services/parsers/registry.py:62` | `get` | method | 6440 | 6353 | 2 | 6353 |
| +82 | `zuzu/db/models/question_thread/question_thread_message_profile.py:13` | `ProfileType` | class | 84 | 2 | 2 | 81 |
| +81 | `zuzu/db/models/events/option/option_exercise_event.py:116` | `ExerciseType` | class | 83 | 2 | 2 | 79 |
| +78 | `zuzu/db/models/question_thread/question_thread.py:551` | `content` | function | 401 | 323 | 323 | 199 |
| +76 | `zuzu/common/factory/audit_log/audit_log_factory.py:8` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/base.py:50` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/bulk_email/bulk_email_factory.py:10` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/bulk_email/bulk_email_recipient_factory.py:11` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/common/token_factory.py:11` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/document_delivery/document_delivery_factory.py:9` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/event_factory.py:10` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/fi_sta/document/fi_sta_abstract_document_factory.py:10` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/fi_sta/document/fi_sta_signable_document_factory.py:12` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/file_attachment_factory.py:7` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/investment_association/event/investment_association_event_factory.py:10` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/investment_association/ia_bulk_email_factory.py:12` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/investment_association/ia_bulk_email_recipient_factory.py:13` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/investment_association/partner/investment_association_organization_partner_factory.py:13` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/investment_association/partner/investment_association_partner_factory.py:11` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/modusign/modusign_document_factory.py:15` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/modusign/modusign_document_usage_history/base_modusign_document_usage_history_factory.py:8` | `_T` | field | 651 | 575 | 575 | 0 |
| +76 | `zuzu/common/factory/option/option_grant_contract_stakeholder_factory.py:10` | `_T` | field | 651 | 575 | 575 | 0 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_derived_context_baseline_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-derived-context-baseline-rebuilt/discrepancies.jsonl`
