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
- Current graph usage refresh: changed=16603, missing=0, errors=0

## Usage Signal

- Exact match: **2428/25706 = 9.4%**
- Missing: **0**
- Undercount: **24**
- Overcount: 23254
- Within +/-1: 11.8%
- Within +/-5: 20.8%
- Mean absolute error: 46.57
- Inlay mean: 54.21
- Pyright mean: 7.66

## Per Kind

| kind | n | exact% | under | +/-1% | +/-5% | MAE | inlay_mean | pyright_mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| class | 4903 | 32.9 | 0 | 42.0 | 60.6 | 10.38 | 28.38 | 18.00 |
| constant | 16831 | 2.0 | 9 | 2.3 | 3.1 | 61.69 | 66.07 | 4.39 |
| function | 1149 | 7.8 | 0 | 8.4 | 83.5 | 12.58 | 25.31 | 12.73 |
| method | 2823 | 13.9 | 15 | 17.7 | 31.5 | 33.05 | 40.16 | 7.18 |

## Error Pattern Distribution

| tag | n | percent |
|---|---:|---:|
| inlay_over_by_6-50 | 9332 | 36.3% |
| inlay_over_no_lsp_refs | 6710 | 26.1% |
| inlay_over_by_50plus | 4387 | 17.1% |
| inlay_over_by_1-5 | 2825 | 11.0% |
| match | 2428 | 9.4% |
| inlay_under_by_6-50 | 13 | 0.1% |
| inlay_under_by_1-5 | 8 | 0.0% |
| inlay_missed | 3 | 0.0% |

## Top Over Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| +21839 | `zuzu/common/management/commands/bq_schema_reference/model_registry.py:126` | `models` | constant | 21844 | 5 | 21810 |
| +12809 | `zuzu/packages/modusign/services/modusign_client/apis/types/document.py:26` | `datetime` | constant | 12811 | 2 | 12777 |
| +4097 | `zuzu/common/management/commands/bq_schema_reference/extractor.py:113` | `model_name` | constant | 4102 | 5 | 4066 |
| +4092 | `zuzu/vertex_ai/models/vertex_ai_prediction_request.py:24` | `model_name` | constant | 4092 | 0 | 4056 |
| +1541 | `zuzu/packages/modusign/services/modusign_client/apis/types/participant_field.py:32` | `required` | constant | 1542 | 1 | 1506 |
| +1149 | `zuzu/app/pages.py:14` | `get_app_page_path` | function | 1149 | 0 | 1149 |
| +994 | `zuzu/packages/krx/graphql/queries/krx_stock_price_prediction_query.py:29` | `model` | constant | 994 | 0 | 10 |
| +992 | `zuzu/cms/admin/content_author/content_author.py:11` | `model` | constant | 992 | 0 | 8 |
| +945 | `zuzu/db/models/company/tests/test_company_model.py:42` | `today` | constant | 972 | 27 | 937 |
| +945 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_consulting_scheduled_notification.py:23` | `today` | constant | 946 | 1 | 911 |
| +945 | `zuzu/packages/investor_relations/notifications/tests/test_promote_ir_subscription_scheduled_notification.py:24` | `today` | constant | 946 | 1 | 911 |
| +945 | `zuzu/packages/with_shareholder_role/tests/mutations/test_accept_stock_unissued_confirmation_request.py:34` | `today` | constant | 959 | 14 | 924 |
| +945 | `zuzu/packages/with_shareholder_role/tests/mutations/test_edit_stock_unissued_confirmation_request.py:36` | `today` | constant | 951 | 6 | 916 |
| +847 | `zuzu/common/factory/base.py:53` | `DjangoModelFactory` | class | 848 | 1 | 848 |
| +765 | `zuzu/common/models/protocol.py:11` | `exists` | method | 765 | 0 | 468 |
| +719 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:167` | `p` | constant | 722 | 3 | 685 |
| +663 | `zuzu/common/factory/base.py:132` | `fake` | function | 669 | 6 | 669 |
| +655 | `zuzu/common/models/big_number_field.py:6` | `BigNumberField` | class | 656 | 1 | 654 |
| +654 | `zuzu/packages/investor_relations/services/ir_discovery_engine_service.py:89` | `flat` | constant | 660 | 6 | 625 |
| +644 | `zuzu/common/requests/api.py:48` | `patch` | constant | 647 | 3 | 612 |
| +630 | `zuzu/packages/hrm/ag_grid_types.py:12` | `values` | constant | 630 | 0 | 306 |
| +628 | `zuzu/common/graphql/scalars/positive_decimal.py:9` | `PositiveDecimal` | class | 779 | 151 | 779 |
| +605 | `zuzu/packages/product/tests/services/test_product_conversion_service.py:21` | `now` | constant | 613 | 8 | 578 |
| +604 | `zuzu/db/models/audit_log/company_owner_audit_log.py:69` | `action_type` | constant | 606 | 2 | 41 |
| +604 | `zuzu/db/models/audit_log/ia_owner_audit_log.py:36` | `action_type` | constant | 605 | 1 | 40 |
| +604 | `zuzu/db/models/investor_relations/im_attachment/im_attachment_download_log.py:65` | `action_type` | constant | 604 | 0 | 39 |
| +604 | `zuzu/db/models/subscription/subscription_suspension_history.py:47` | `action_type` | constant | 606 | 2 | 41 |
| +604 | `zuzu/packages/subscription/types/subscription_types.py:51` | `action_type` | constant | 604 | 0 | 39 |
| +604 | `zuzu/vcm/models/ir/attachment/vcm_ir_attachment_download_log.py:66` | `action_type` | constant | 604 | 0 | 39 |
| +583 | `zuzu/db/models/owner_role/owner_role_permission_relation.py:25` | `owner_role` | constant | 583 | 0 | 548 |

## Top Under Counts

| diff | file:line | name | kind | inlay | pyright | previous |
|---:|---|---|---|---:|---:|---:|
| -30 | `zuzu/db/models/user/user.py:181` | `phone` | method | 101 | 131 | 100 |
| -28 | `zuzu/db/models/shareholders_meeting.py:206` | `meeting` | constant | 72 | 100 | 132 |
| -17 | `zuzu/packages/payment/services/payple_client.py:80` | `receipt_url` | constant | 42 | 59 | 7 |
| -15 | `zuzu/packages/payment/services/payple_client.py:81` | `paid_at` | constant | 44 | 59 | 9 |
| -15 | `zuzu/db/models/question_thread/question_thread.py:583` | `help_type` | method | 17 | 32 | 17 |
| -14 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:25` | `CORPORATION` | constant | 63 | 77 | 61 |
| -12 | `zuzu/packages/pipedrive/types.py:160` | `error_message` | constant | 70 | 82 | 35 |
| -11 | `zuzu/db/models/agenda/base/directors_or_shareholders_meeting_agenda_child_base.py:52` | `meeting` | method | 25 | 36 | 117 |
| -9 | `zuzu/db/models/stakeholder/stakeholder.py:115` | `email` | method | 52 | 61 | 57 |
| -6 | `zuzu/packages/document/base.py:73` | `message` | constant | 20 | 26 | 20 |
| -6 | `zuzu/db/models/purchase/purchase.py:430` | `status` | method | 27 | 33 | 33 |
| -6 | `zuzu/db/models/subscription/subscription.py:1096` | `status` | method | 51 | 57 | 62 |
| -6 | `zuzu/packages/notification/base/slack_notification.py:104` | `slack_channels` | method | 293 | 299 | 293 |
| -4 | `zuzu/db/models/agenda/director_compensation/agenda_director_compensation_item.py:44` | `name` | method | 3 | 7 | 30 |
| -3 | `zuzu/packages/document/base.py:111` | `document_type_name` | constant | 43 | 46 | 8 |
| -3 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:346` | `shares_at` | method | 9 | 12 | 11 |
| -3 | `zuzu/packages/investment_association/document/ia_document_builder.py:18` | `status` | method | 0 | 3 | 6 |
| -2 | `zuzu/db/models/directors_meeting_director_attendance.py:96` | `address` | method | 0 | 2 | 7 |
| -1 | `zuzu/common/graphql/typed_graphene/typed_base_mutation.py:64` | `__build_context__` | constant | 8 | 9 | 8 |
| -1 | `zuzu/packages/fi_sta/graphql/mutations/mixins/fi_sta_validation_mixin.py:54` | `address` | constant | 4 | 5 | 11 |
| -1 | `zuzu/db/models/branch.py:36` | `address` | method | 3 | 4 | 10 |
| -1 | `zuzu/db/models/purchase/payment/credit_card_payment/payment.py:202` | `status` | method | 7 | 8 | 13 |
| -1 | `zuzu/db/models/shareholders_meeting_director_attendance.py:81` | `address` | method | 0 | 1 | 7 |
| -1 | `zuzu/db/models/subscription/subscription_perk.py:227` | `quantity` | method | 15 | 16 | 5 |

## Artifacts

- Source valid LSP results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-import-module-segment-prune/lsp_usage_results_refreshed.jsonl`
- Bulk graph symbols: `/private/tmp/captain_symbols_current.json`
- Refreshed valid results: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-simple-value-base-margin/lsp_usage_results_refreshed.jsonl`
- Discrepancies: `/Users/lky/project/intellij-styled-search/reports/inlay-usage-census-min5-2026-05-21-simple-value-base-margin/discrepancies.jsonl`
