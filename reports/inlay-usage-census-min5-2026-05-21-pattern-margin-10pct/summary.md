# Inlay Usage Accuracy Rerun

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25706**
- Dropped cached LSP symbols missing from current graph: 0
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25706: +/-0.6%
- Current graph usage refresh: changed=7817, missing=0, errors=0
- Graph usage changed from cached baseline: 25686/25706

## Usage Signal

- Exact match: **2599/25706 = 10.1%**
- Undercount: **0**
- Overcount: 23107
- Within +/-1: 12.7%
- Within +/-5: 21.4%
- Mean absolute error: 32.57
- Inlay mean: 40.23
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| constant | 16831 | 2.6 | 0 | 3.0 | 3.6 | 43.14 | 47.53 | 4.39 |
| class | 4903 | 33.4 | 0 | 43.1 | 61.0 | 9.92 | 27.92 | 18.00 |
| method | 2823 | 15.2 | 0 | 19.4 | 32.4 | 18.99 | 26.17 | 7.18 |
| function | 1149 | 8.4 | 0 | 9.2 | 86.6 | 7.71 | 20.45 | 12.73 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 11559 | 45.0% |
| inlay_over_no_lsp_refs | 6582 | 25.6% |
| inlay_over_by_1-5 | 2835 | 11.0% |
| match | 2599 | 10.1% |
| inlay_over_by_50plus | 2131 | 8.3% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 |
| +547 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 547 | 0 |
| +527 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 528 | 1 |
| +471 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 480 | 9 |
| +387 | `zuzu/packages/with_shareholder_role/decorators.py:34` | `stakeholder` | constant | 452 | 65 |
| +378 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 387 | 9 |
| +349 | `zuzu/common/factory/company_user_relation_factory.py:47` | `stakeholder` | constant | 350 | 1 |
| +349 | `zuzu/common/factory/company_user_relation_factory.py:53` | `stakeholder` | constant | 350 | 1 |
| +349 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 508 | 159 |
| +346 | `zuzu/packages/with_shareholder_role/types/types.py:277` | `stakeholder` | constant | 346 | 0 |
| +345 | `zuzu/packages/owner_role/types.py:65` | `stakeholder` | constant | 346 | 1 |
| +343 | `zuzu/db/models/company/user_relation/company_user_relation.py:90` | `stakeholder` | constant | 394 | 51 |
| +341 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 342 | 1 |
| +333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 |
| +299 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 301 | 2 |
| +289 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 302 | 13 |
| +265 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 284 | 19 |
| +263 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 274 | 11 |
| +253 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 254 | 1 |
| +242 | `zuzu/db/models/agenda/base/directors_meeting_agenda_child_base.py:24` | `meeting` | method | 243 | 1 |
| +229 | `zuzu/db/models/investment_association/rule/ia_rule.py:293` | `meeting` | method | 234 | 5 |
| +228 | `zuzu/db/models/option/option_management.py:142` | `meeting` | method | 229 | 1 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 |
| +227 | `zuzu/packages/legal_partner/graphql/mutations/staff_ia_legal_partner_assign_mutation.py:35` | `investment_association` | constant | 229 | 2 |
| +227 | `zuzu/packages/company/meeting/actions/send_directors_meeting_notice_email_action.py:22` | `meeting` | method | 228 | 1 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright |
|---:|---|---|---|---:|---:|

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-20-noisy-value-member-filter/lsp_usage_results_refreshed.jsonl`
- Bulk graph symbols: `/private/tmp/captain_symbols_current.json`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-pattern-margin-10pct/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-pattern-margin-10pct/discrepancies.jsonl`
