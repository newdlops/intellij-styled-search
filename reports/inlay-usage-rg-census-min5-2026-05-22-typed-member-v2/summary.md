# Fast RG Usage Census

- Date: 2026-05-22
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **17062**
- Elapsed: 9.7s

## Proxy Result

- Exact proxy match: **4721/17062 = 27.7%**
- Proxy undercount risk: **5050/17062 = 29.6%**
- Proxy overcount: **7291/17062 = 42.7%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | proxy_under% | proxy_over% |
|---|---:|---:|---:|---:|
| class | 8686 | 26.9 | 0.0 | 73.1 |
| field | 5802 | 24.4 | 68.2 | 7.4 |
| function | 2329 | 37.0 | 40.9 | 22.1 |
| method | 245 | 44.5 | 55.5 | 0.0 |

## Top Proxy Under

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:68` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:92` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:116` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_adjust_rsu_vesting_traceable.py:142` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/registration/mutations/test_cancel_registration_assistance_request.py:30` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:31` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:38` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:62` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:69` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/captable/test_captable_service.py:120` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/question_thread/company_question_thread.py:389` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/tests/legal/mutation/test_director_delete.py:14` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/phantom_stock/tests/test_get_phantom_stock_vesting_traceable.py:36` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/phantom_stock/tests/test_get_phantom_stock_vesting_traceable.py:45` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_get_rsu_vesting_traceable.py:40` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/rsu/tests/services/test_get_rsu_vesting_traceable.py:49` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_get_traceable_vesting_service.py:36` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_get_traceable_vesting_service.py:42` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:20` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:45` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:66` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:91` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:115` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/investment_round/services/tests/test_investment_round_service.py:127` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:103` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:223` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:235` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/company/meeting/registration_fee/types.py:443` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/events/tests/test_new_issue_event_model.py:50` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/mutations/test_option_cancel.py:28` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/option/tests/test_option_query_set.py:215` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/option/tests/test_option_query_set.py:223` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/db/models/option/tests/test_option_query_set.py:264` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_option_grant_status_detail_excel_writer.py:77` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_option_grant_status_detail_excel_writer.py:82` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/services/test_option_grant_status_detail_excel_writer.py:105` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/query/test_permission_for_options_admin.py:45` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/query/test_permission_for_options_admin.py:53` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/option/tests/query/test_permission_for_options_admin.py:58` | `company` | field | 5 | 10701 | 12780 | 10701 |
| -10696 | `zuzu/packages/event_time_machine/test/test_option_related_event_time_travel_test_case.py:75` | `company` | field | 5 | 10701 | 12780 | 10701 |

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +8883 | `zuzu/db/models/company/company.py:815` | `name` | function | 13100 | 4217 | 4217 | 2189 |
| +7375 | `zuzu/db/models/question_thread/question_thread.py:551` | `content` | function | 8185 | 810 | 810 | 199 |
| +6213 | `zuzu/db/models/agenda/bonus_issue/agenda_bonus_issue.py:226` | `key` | function | 6910 | 697 | 697 | 4 |
| +5806 | `zuzu/packages/ms_word/services/utils/docx_replace_image.py:162` | `Paragraph` | class | 5818 | 12 | 12 | 0 |
| +5456 | `zuzu/packages/ms_word/services/utils/types.py:43` | `Format` | class | 5497 | 41 | 41 | 0 |
| +3364 | `zuzu/db/models/agenda/agenda_new_or_change_rsu_rule/agenda_new_or_change_rsu_rule.py:99` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/authorized_shares_change/agenda_authorized_shares_change.py:52` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/bonus_issue/agenda_bonus_issue.py:212` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/branch_change/agenda_branch_change.py:94` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/ceo_address_change/agenda_ceo_address_change.py:105` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/change_of_articles_of_incorporation/agenda_change_of_articles_of_incorporation.py:147` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/co_ceo_system_change/agenda_co_ceo_system_change.py:85` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/company_name_change/agenda_company_name_change.py:108` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/director_compensation/agenda_director_compensation.py:135` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/director_compensation_rule/agenda_director_compensation_rule.py:69` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/financial_statements/agenda_financial_statements.py:67` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/head_office_relocation/agenda_head_office_relocation.py:78` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/head_office_relocation_aoi_change/agenda_head_office_relocation_aoi_change.py:52` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/method_of_giving_public_notice_change/agenda_method_of_giving_public_notice_change.py:77` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/new_issue/agenda_new_issue.py:410` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/new_options_rule/agenda_new_options_rule.py:108` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/option_cancel/agenda_option_cancel.py:62` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise.py:178` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/option_grant/agenda_option_grant.py:121` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/purpose_change/agenda_purpose_change.py:74` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/rsu_grant/agenda_rsu_grant.py:63` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/shareholders_meeting_convocation/agenda_shareholders_meeting_convocation.py:39` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/agenda/subsidiary_establishment/agenda_subsidiary_establishment.py:91` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/investment_association/consent_form_or_meeting/electronic_signature/ia_consent_form_or_meeting_electronic_signature_required_document.py:151` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/investment_association/document/investment_association_document.py:142` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/db/models/meeting_document/seal_stamp_documents/seal_stamp_card_continued_use_application_form_document.py:135` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/document/document_types/electronic_certificate_application_form_template_document.py:115` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/document/document_types/incorporation_electronic_certificate_application_form_document.py:69` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_company_ceos_name_update_failed_slack_notification.py:19` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_company_info_search_failed_slack_notification.py:19` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_company_registration_number_update_failed_slack_notification.py:19` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_contract_document_all_signed_slack_notification.py:22` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_contract_document_payment_date_due_slack_notification.py:22` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_contract_document_payment_date_overdue_slack_notification.py:22` | `title` | function | 4298 | 934 | 934 | 227 |
| +3364 | `zuzu/packages/fi_sta/notifications/slack_notifications/fi_sta_management_contract_document_signing_started_slack_notification.py:22` | `title` | function | 4298 | 934 | 934 | 227 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260522_typed_member_v2/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-22-typed-member-v2/discrepancies.jsonl`
