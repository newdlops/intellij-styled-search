# Inlay Usage Accuracy Rerun

- Date: 2026-05-21
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census mode: full population, existing LSP sample reused
- Census zero-usage symbols: excluded
- Census minimum graph usage: 5
- Valid LSP usage sample: **25635**
- Dropped cached LSP symbols missing from current graph: 71
- Skipped/unknown LSP candidates: 4
- Quarantined LSP timeout candidates: 3284
- Conservative 95% proportion margin at n=25635: +/-0.6%
- Current graph usage refresh: changed=2809, missing=71, errors=0

## Usage Signal

- Exact match: **2686/25635 = 10.5%**
- Missing: **71**
- Undercount: **9**
- Overcount: 22940
- Within +/-1: 13.0%
- Within +/-5: 21.6%
- Mean absolute error: 31.65
- Inlay mean: 39.32
- Pyright mean: 7.67

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4900 | 34.0 | 0 | 43.2 | 61.0 | 9.91 | 27.91 | 18.00 |
| constant | 16764 | 2.6 | 9 | 3.1 | 3.7 | 41.90 | 46.28 | 4.38 |
| function | 1149 | 8.2 | 0 | 8.9 | 86.3 | 7.67 | 20.40 | 12.73 |
| method | 2822 | 17.2 | 0 | 20.9 | 33.3 | 18.29 | 25.47 | 7.18 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 11662 | 45.5% |
| inlay_over_no_lsp_refs | 6564 | 25.6% |
| inlay_over_by_1-5 | 2780 | 10.8% |
| match | 2686 | 10.5% |
| inlay_over_by_50plus | 1934 | 7.5% |
| inlay_missed | 9 | 0.0% |

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
| -1 | `zuzu/packages/tbk/types.py:37` | `payment_date` | constant | 0 | 1 | 17 |
| -1 | `zuzu/packages/tbk/types.py:38` | `seat_count` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:39` | `average_bookkeeping_price` | constant | 0 | 1 | 8 |
| -1 | `zuzu/packages/tbk/types.py:41` | `monthly_subscription_price` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:48` | `start_date` | constant | 0 | 1 | 10 |
| -1 | `zuzu/packages/tbk/types.py:57` | `average_bookkeeping_price` | constant | 0 | 1 | 8 |
| -1 | `zuzu/packages/tbk/types.py:49` | `end_date` | constant | 0 | 1 | 14 |
| -1 | `zuzu/packages/tbk/types.py:59` | `monthly_subscription_price` | constant | 0 | 1 | 7 |
| -1 | `zuzu/packages/tbk/types.py:69` | `items` | constant | 0 | 1 | 6 |

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-python-full-shallow-id-remap-cli/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-python-full-shallow-id-remap-cli/discrepancies.jsonl`
