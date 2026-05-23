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
- Current graph usage refresh: changed=146, missing=0, errors=0

## Usage Signal

- Exact match: **2656/25706 = 10.3%**
- Missing: **0**
- Undercount: **0**
- Overcount: 23050
- Within +/-1: 12.9%
- Within +/-5: 21.5%
- Mean absolute error: 32.10
- Inlay mean: 39.76
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4903 | 34.3 | 0 | 43.5 | 61.2 | 9.90 | 27.89 | 18.00 |
| constant | 16831 | 2.6 | 0 | 3.0 | 3.6 | 42.45 | 46.84 | 4.39 |
| function | 1149 | 8.4 | 0 | 9.2 | 86.6 | 7.71 | 20.45 | 12.73 |
| method | 2823 | 15.7 | 0 | 19.9 | 33.0 | 18.88 | 26.05 | 7.18 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 11645 | 45.3% |
| inlay_over_no_lsp_refs | 6579 | 25.6% |
| inlay_over_by_1-5 | 2808 | 10.9% |
| match | 2656 | 10.3% |
| inlay_over_by_50plus | 2018 | 7.9% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| +526 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 527 | 1 | 654 |
| +471 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 480 | 9 | 144 |
| +378 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 387 | 9 | 377 |
| +349 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 508 | 159 | 179 |
| +341 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 342 | 1 | 556 |
| +333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 481 |
| +321 | `zuzu/common/celery/celery.py:8` | `app` | constant | 325 | 4 | 291 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 | 175 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 596 |
| +299 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 301 | 2 | 302 |
| +289 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 302 | 13 | 186 |
| +265 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 284 | 19 | 300 |
| +263 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 274 | 11 | 218 |
| +253 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 254 | 1 | 270 |
| +242 | `zuzu/db/models/agenda/base/directors_meeting_agenda_child_base.py:24` | `meeting` | method | 243 | 1 | 124 |
| +229 | `zuzu/db/models/investment_association/rule/ia_rule.py:293` | `meeting` | method | 234 | 5 | 100 |
| +228 | `zuzu/db/models/option/option_management.py:142` | `meeting` | method | 229 | 1 | 95 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 91 |
| +227 | `zuzu/packages/legal_partner/graphql/mutations/staff_ia_legal_partner_assign_mutation.py:35` | `investment_association` | constant | 229 | 2 | 186 |
| +227 | `zuzu/packages/company/meeting/actions/send_directors_meeting_notice_email_action.py:22` | `meeting` | method | 228 | 1 | 94 |
| +227 | `zuzu/packages/company/meeting/actions/send_shareholders_meeting_convocation_notice_email_action.py:23` | `meeting` | method | 228 | 1 | 94 |
| +225 | `zuzu/packages/payment/payment_link/graphql/mutations/staff_create_ia_payment_link_mutation.py:20` | `investment_association` | constant | 227 | 2 | 182 |
| +223 | `zuzu/packages/payment/graphql/mutations/register_credit_card_mutation.py:47` | `investment_association` | constant | 227 | 4 | 184 |
| +223 | `zuzu/packages/company/meeting/types/meeting_service_types.py:443` | `director_type` | method | 231 | 8 | 226 |
| +222 | `zuzu/packages/unlisted_stock_management/investment_association/graphql/mutations/staff_create_usm_ia_and_partner_mutation.py:51` | `investment_association` | constant | 227 | 5 | 186 |
| +217 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 219 | 2 | 424 |
| +214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 349 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Bulk graph symbols: `/private/tmp/captain_symbols_current.json`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-no-agenda-special/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-no-agenda-special/discrepancies.jsonl`
