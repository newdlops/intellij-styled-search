# Fast RG Usage Census

- Date: 2026-05-23
- Workspace: `/Users/lky/project/captain`
- Current zoek-rs: `/Users/lky/project/intellij-styled-search/target/release/zoek-rs`
- Census minimum graph usage: 5
- Python files tokenized: 11026
- Python files failed: 0
- Census rows: **158547**
- Elapsed: 11.2s

## Proxy Result

- Exact likely/proxy match: **83438/158547 = 52.6%**
- MAY undercount risk: **0/158547 = 0.0%**
- Likely below proxy but MAY safe: **36997/158547 = 23.3%**
- Proxy overcount: **38112/158547 = 24.0%**

The proxy uses Python NAME tokens, excludes known symbol definition tokens, uses bare tokens for classes/functions and member tokens for methods/fields.

## Per Kind

| kind | n | exact% | may_under% | likely_under_may_safe% | proxy_over% |
|---|---:|---:|---:|---:|---:|
| class | 10244 | 33.9 | 0.0 | 21.8 | 44.3 |
| field | 131054 | 52.7 | 0.0 | 25.7 | 21.7 |
| function | 4113 | 71.2 | 0.0 | 10.8 | 17.9 |
| method | 13136 | 61.2 | 0.0 | 5.1 | 33.7 |

## Top MAY Under Risk

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|

## Top Proxy Over

| diff | file:line | name | kind | graph | proxy | bare | member |
|---:|---|---|---|---:|---:|---:|---:|
| +1199 | `zuzu/db/models/hrm/approval/template/abstract_hrm_assignable_model.py:120` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/events/option/abstract_option_event.py:152` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/address.py:377` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/bonus_issue/agenda_bonus_issue_new_issue_balance_certificate_file.py:61` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/bonus_issue/agenda_bonus_issue_new_issue_minutes_file.py:53` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/bonus_issue/agenda_bonus_issue_shares_to_issue.py:46` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/borrow_capital/agenda_borrow_capital.py:32` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/change_of_articles_of_incorporation/agenda_change_of_aoi_class_stock.py:45` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/change_of_articles_of_incorporation/agenda_change_of_aoi_custom.py:62` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/change_of_articles_of_incorporation/agenda_change_of_aoi_director_compensation_rule.py:43` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/change_of_articles_of_incorporation/agenda_change_of_aoi_number_of_directors.py:53` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/change_of_articles_of_incorporation/agenda_change_of_aoi_third_party_allocation.py:56` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/director_change/agenda_director_change.py:740` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item.py:258` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_from_conversion.py:38` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_from_payment.py:29` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_institution_member.py:63` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_institution_member_ceo.py:39` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/new_issue/agenda_new_issue_item_shareholder.py:158` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/option_cancel/agenda_option_cancel_grantee.py:52` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/option_cancel/agenda_option_cancel_option.py:115` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_claim.py:60` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee.py:118` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee_option.py:50` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/option_grant/agenda_option_grant_grantee.py:170` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/purpose_change/agenda_purpose_change_item.py:41` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/rsu_grant/agenda_rsu_grant_grantee.py:125` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/agenda/custom/agenda_template.py:69` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/investor_relations/deprecated/business_plan/ai_analysis_feedback.py:28` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/company/payroll/ai_payroll_ledger.py:48` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/alimtalk_activity/alimtalk_activity.py:44` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/alimtalk_activity/alimtalk_activity_recipient.py:68` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/alimtalk_activity/alimtalk_activity_recipient_status_history.py:57` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/announcement/announcement.py:136` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/user/app_user.py:408` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/meeting_document/appointed_director_certificate_of_seal_document.py:43` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/meeting_document/appointed_director_resident_registration_document.py:42` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/article/article.py:125` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/article/article_publish_history.py:43` | `objects` | field | 9067 | 7868 | 6 | 7868 |
| +1199 | `zuzu/db/models/articles_of_incorporation/articles_of_incorporation.py:344` | `objects` | field | 9067 | 7868 | 6 | 7868 |

## Artifacts

- Population: `/private/tmp/inlay_usage_rg_census_min5_20260523_token_shape_likely_baseline_rebuilt/population.jsonl`
- Discrepancies: `reports/inlay-usage-rg-census-min5-2026-05-23-token-shape-likely-baseline-rebuilt/discrepancies.jsonl`
