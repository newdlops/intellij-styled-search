# Inlay Usage Accuracy Rerun

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25267**
- Dropped cached LSP symbols missing from current graph: 439
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25267: +/-0.6%
- Current graph usage refresh: changed=2744, missing=439, errors=0

## Usage Signal

- Exact match: **2555/25267 = 10.1%**
- Missing: **439**
- Undercount: **0**
- Overcount: 22712
- Within +/-1: 12.6%
- Within +/-5: 21.2%
- Mean absolute error: 31.85
- Inlay mean: 39.49
- Pyright mean: 7.64

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4858 | 34.1 | 0 | 43.3 | 61.1 | 9.90 | 27.89 | 17.99 |
| constant | 16486 | 1.9 | 0 | 2.4 | 3.0 | 42.26 | 46.59 | 4.32 |
| function | 1139 | 8.3 | 0 | 9.0 | 86.4 | 7.66 | 20.27 | 12.61 |
| method | 2784 | 17.3 | 0 | 21.0 | 33.4 | 18.39 | 25.55 | 7.16 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 11544 | 45.7% |
| inlay_over_no_lsp_refs | 6499 | 25.7% |
| inlay_over_by_1-5 | 2743 | 10.9% |
| match | 2555 | 10.1% |
| inlay_over_by_50plus | 1926 | 7.6% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| +526 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 527 | 1 | 654 |
| +472 | `zuzu/packages/alimtalk/alimtalk_template.py:4` | `Template` | class | 481 | 9 | 144 |
| +375 | `zuzu/common/models/fixed_inheritance.py:22` | `annotate` | method | 384 | 9 | 377 |
| +353 | `zuzu/packages/notification/email/email_template.py:6` | `Template` | class | 512 | 159 | 179 |
| +333 | `zuzu/packages/corporate_registration/services/content_extract_service/client/types/codef_corporate_registration_issue_request.py:178` | `Manager` | class | 334 | 1 | 481 |
| +325 | `zuzu/common/celery/celery.py:8` | `app` | constant | 329 | 4 | 291 |
| +318 | `zuzu/common/management/commands/render_test_timing_tree.py:40` | `add` | method | 320 | 2 | 302 |
| +315 | `zuzu/db/models/meeting_document/base/meeting_document.py:100` | `shareholders_meeting` | constant | 363 | 48 | 175 |
| +303 | `zuzu/db/models/company/user_relation/company_user_relation.py:67` | `Role` | class | 593 | 290 | 596 |
| +300 | `zuzu/packages/incorporation/services/incorporation_service.py:570` | `director_type` | function | 301 | 1 | 556 |
| +294 | `zuzu/common/models/protocol.py:11` | `exists` | method | 294 | 0 | 468 |
| +289 | `zuzu/db/models/agenda/base/shareholders_meeting_agenda_child_base.py:38` | `meeting` | method | 302 | 13 | 186 |
| +259 | `zuzu/db/models/company/company_purpose_change_item.py:44` | `name` | method | 270 | 11 | 218 |
| +254 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:226` | `replace` | method | 255 | 1 | 270 |
| +242 | `zuzu/db/models/agenda/base/directors_meeting_agenda_child_base.py:24` | `meeting` | method | 243 | 1 | 124 |
| +229 | `zuzu/db/models/investment_association/rule/ia_rule.py:293` | `meeting` | method | 234 | 5 | 100 |
| +228 | `zuzu/db/models/option/option_management.py:142` | `meeting` | method | 229 | 1 | 95 |
| +227 | `zuzu/common/models/purchasable.py:122` | `get_queryset` | method | 227 | 0 | 91 |
| +227 | `zuzu/packages/legal_partner/graphql/mutations/staff_ia_legal_partner_assign_mutation.py:35` | `investment_association` | constant | 229 | 2 | 186 |
| +227 | `zuzu/packages/company/meeting/actions/send_directors_meeting_notice_email_action.py:22` | `meeting` | method | 228 | 1 | 94 |
| +227 | `zuzu/packages/company/meeting/actions/send_shareholders_meeting_convocation_notice_email_action.py:23` | `meeting` | method | 228 | 1 | 94 |
| +225 | `zuzu/packages/payment/payment_link/graphql/mutations/staff_create_ia_payment_link_mutation.py:20` | `investment_association` | constant | 227 | 2 | 182 |
| +223 | `zuzu/packages/payment/graphql/mutations/register_credit_card_mutation.py:47` | `investment_association` | constant | 227 | 4 | 184 |
| +222 | `zuzu/packages/unlisted_stock_management/investment_association/graphql/mutations/staff_create_usm_ia_and_partner_mutation.py:51` | `investment_association` | constant | 227 | 5 | 186 |
| +217 | `zuzu/common/factory/company_factory.py:25` | `establishment_date` | constant | 219 | 2 | 424 |
| +215 | `zuzu/db/models/company/bulk_email_template/company_bulk_email_template.py:53` | `Type` | class | 234 | 19 | 300 |
| +214 | `zuzu/db/models/subscription/subscription_plan.py:64` | `Name` | class | 346 | 132 | 349 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-python-full-shallow-import-root-return-call-cli/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-python-full-shallow-import-root-return-call-cli/discrepancies.jsonl`
