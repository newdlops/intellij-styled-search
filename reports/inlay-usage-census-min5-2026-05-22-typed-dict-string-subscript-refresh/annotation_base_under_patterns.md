# Annotation Base Under Patterns

- under=121, missed=23

| base_diff | file:line | name | kind | base | lsp | extends |
|---:|---|---|---|---:|---:|---|
| -31 | `zuzu/packages/ms_word/services/utils/types.py:62` | `paragraph_format` | constant | 68 | 99 | `Format` |
| -27 | `zuzu/packages/corporate_registration/auto_updater/types/branch_change.py:9` | `note` | constant | 18 | 45 | `` |
| -24 | `zuzu/packages/ms_word/services/utils/types.py:68` | `paragraphs` | constant | 28 | 52 | `DocxParagraph` |
| -20 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:83` | `ceo_set` | constant | 8 | 28 | `ShareholderInstitutionMemberCeoManager` |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:280` | `management` | constant | 17 | 31 | `StockTransferAgreementManagement` |
| -14 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:16` | `agenda_type` | constant | 73 | 87 | `` |
| -13 | `zuzu/packages/ms_word/services/utils/types.py:56` | `runs` | constant | 9 | 22 | `DocxRun` |
| -12 | `zuzu/packages/company/meeting/types/service_fee_types.py:17` | `label` | constant | 52 | 64 | `` |
| -11 | `zuzu/db/models/question_thread/company_question_thread.py:383` | `message_set` | constant | 29 | 40 | `QuestionThreadMessageManager` |
| -11 | `zuzu/packages/ms_word/services/utils/types.py:60` | `add_run` | constant | 53 | 64 | `Callable, DocxRun` |
| -10 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:442` | `traceable_type` | constant | 1 | 11 | `VestingTraceableType` |
| -10 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:19` | `deadline_date` | constant | 30 | 40 | `` |
| -8 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:443` | `valid_from` | constant | 2 | 10 | `NotRequired` |
| -8 | `zuzu/packages/ms_word/services/utils/types.py:29` | `font` | constant | 17 | 25 | `_DocxRunFont` |
| -7 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:11` | `purpose` | constant | 2 | 9 | `` |
| -6 | `zuzu/db/models/stakeholder/esop_participant.py:101` | `employee_stock_set` | constant | 7 | 13 | `AllEmployeeStockManager` |
| -6 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:14` | `change_note` | constant | 2 | 8 | `ChangeNote` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:21` | `size` | constant | 12 | 18 | `Length` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:28` | `bold` | constant | 7 | 13 | `` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:73` | `add_paragraph` | constant | 12 | 18 | `Callable, DocxParagraph` |
| -5 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee.py:130` | `option_set` | constant | 3 | 8 | `AgendaOptionExerciseGranteeOptionManager` |
| -5 | `zuzu/db/models/branch.py:15` | `installation_event` | constant | 18 | 23 | `BranchInstallationEvent` |
| -5 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:481` | `traceable_type` | constant | 1 | 6 | `NotRequired` |
| -5 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:329` | `institution_member_set` | constant | 49 | 54 | `ShareholderInstitutionMemberManager` |
| -5 | `zuzu/db/models/user/app_user.py:311` | `companyuserrelation_set` | constant | 4 | 9 | `ValidCompanyUserRelationManager` |
| -5 | `zuzu/db/models/user/app_user.py:321` | `phone_set` | constant | 3 | 8 | `PhoneManager` |
| -4 | `zuzu/db/models/company/investment_simulation/interfaces.py:21` | `shares` | constant | 0 | 4 | `Decimal` |
| -4 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:119` | `bulk_email_template_set` | constant | 2 | 6 | `CmeBulkEmailTemplateManager` |
| -4 | `zuzu/db/models/events/event.py:617` | `outward_stocks` | constant | 40 | 44 | `ManyToManyRelatedManager, Stock, Self` |
| -4 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:297` | `traceable_type` | constant | 1 | 5 | `IndividualStockOptionVestingTraceableType` |
| -4 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:482` | `valid_from` | constant | 2 | 6 | `NotRequired` |
| -4 | `zuzu/packages/company/meeting/registration_fee/types.py:98` | `number_of_shareholders_meeting_minutes_notarization` | constant | 15 | 19 | `` |
| -4 | `zuzu/packages/company/meeting/registration_fee/types.py:99` | `number_of_directors_meeting_minutes_notarization` | constant | 15 | 19 | `` |
| -4 | `zuzu/packages/convocation/graphql/mutations/convocation_notice_email_send_mutation.py:62` | `meeting_id` | constant | 1 | 5 | `` |
| -4 | `zuzu/packages/ibk/services/ibk_service.py:84` | `code` | constant | 2 | 6 | `` |
| -4 | `zuzu/packages/investment_association/helpdesk/graphql/queries/staff_ia_question_thread_list_query.py:22` | `where` | constant | 1 | 5 | `IaQuestionThreadFilterInputType` |
| -4 | `zuzu/packages/ms_word/services/field_tracker_service.py:18` | `type` | constant | 5 | 9 | `TFieldTrackerType` |
| -3 | `zuzu/db/models/company/investment_simulation/interfaces.py:22` | `share_class_identifier` | constant | 0 | 3 | `` |
| -3 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:114` | `cme_company_set` | constant | 10 | 13 | `CmeCompanyManager` |
| -3 | `zuzu/db/models/department/company_registration_staff_status.py:43` | `user_id` | constant | 4 | 7 | `` |
| -3 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:298` | `valid_from` | constant | 2 | 5 | `NotRequired` |
| -3 | `zuzu/packages/investment_association/bulk_email/types.py:19` | `email` | constant | 3 | 6 | `` |
| -3 | `zuzu/packages/investment_simulation/services/types.py:58` | `investors` | constant | 15 | 18 | `InvestmentSimulationRoundInvestorInput` |
| -3 | `zuzu/packages/krx/types.py:28` | `price` | constant | 1 | 4 | `` |
| -3 | `zuzu/packages/ms_word/services/utils/types.py:92` | `width` | constant | 27 | 30 | `` |
| -3 | `zuzu/packages/ms_word/services/utils/types.py:99` | `columns` | constant | 41 | 44 | `DocxTableColumn` |
| -3 | `zuzu/packages/stock/stock_transfer_service.py:180` | `quantities_to_transfer` | constant | 0 | 3 | `QuantityToTransfer` |
| -3 | `zuzu/packages/stock/stock_transfer_service.py:182` | `transfer_method` | constant | 0 | 3 | `` |
| -3 | `zuzu/packages/stock_transfer_agreement/mutations/v2/pay_stock_transfer_agreement_mutation.py:32` | `stock_transfer_agreement_management` | constant | 3 | 6 | `StockTransferAgreementManagement` |
| -3 | `zuzu/packages/subscription/types/subscription_payment_types.py:468` | `perk_payments` | constant | 4 | 7 | `SubscriptionPerkPaymentType` |
| -2 | `zuzu/app/graphql/types/__init__.py:355` | `name` | constant | 0 | 2 | `` |
| -2 | `zuzu/db/models/company/company_purpose_change.py:69` | `purpose_set` | constant | 28 | 30 | `CompanyPurposeChangeItemManager` |
| -2 | `zuzu/db/models/company/investment_simulation/interfaces.py:27` | `sell_stocks` | constant | 0 | 2 | `InvestmentSimulationRoundSellStockInterface` |
| -2 | `zuzu/db/models/company/investment_simulation/interfaces.py:40` | `sequence` | constant | 7 | 9 | `` |
| -2 | `zuzu/db/models/events/event.py:618` | `inward_optionvestingtraceables` | constant | 27 | 29 | `ManyToManyRelatedManager` |
| -2 | `zuzu/db/models/events/event.py:621` | `outward_optionvestingtraceables` | constant | 45 | 47 | `ManyToManyRelatedManager` |
| -2 | `zuzu/db/models/events/event.py:627` | `outward_phantomstockvestingtraceables` | constant | 22 | 24 | `ManyToManyRelatedManager` |
| -2 | `zuzu/db/models/events/event.py:624` | `inward_phantomstockvestingtraceables` | constant | 17 | 19 | `ManyToManyRelatedManager` |
| -2 | `zuzu/db/models/events/event.py:630` | `inward_rsuvestingtraceables` | constant | 25 | 27 | `ManyToManyRelatedManager, RsuVestingTraceable, Self` |
| -2 | `zuzu/db/models/events/event.py:631` | `outward_rsuvestingtraceables` | constant | 28 | 30 | `ManyToManyRelatedManager` |
| -2 | `zuzu/db/models/hrm/attendance/work/hrm_fixed_work.py:83` | `schedule_set` | constant | 1 | 3 | `HrmFixedWorkScheduleManager` |
| -2 | `zuzu/db/models/hrm/attendance/work/hrm_staggered_work.py:83` | `schedule_set` | constant | 1 | 3 | `HrmStaggeredWorkScheduleManager` |
| -2 | `zuzu/db/models/notarization_poa.py:30` | `shareholder_signer_set` | constant | 7 | 9 | `NotarizationPoaShareholderSignerManager` |
| -2 | `zuzu/db/models/notarization_poa.py:31` | `director_signer_set` | constant | 8 | 10 | `NotarizationPoaDirectorSignerManager` |
| -2 | `zuzu/db/models/registration_agenda.py:111` | `agenda_ceo_address_change` | constant | 1 | 3 | `AgendaCeoAddressChange` |
| -2 | `zuzu/db/models/registration_agenda.py:112` | `agenda_director_change` | constant | 6 | 8 | `AgendaDirectorChange` |
| -2 | `zuzu/db/models/signup_channel/legal_partner_signup_channel.py:33` | `legal_partner_id` | constant | 0 | 2 | `` |
| -2 | `zuzu/db/models/stakeholder/stakeholder.py:80` | `shareholder` | constant | 32 | 34 | `Shareholder` |
| -2 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 19 | 21 | `TwoFactorAuthenticationManager` |
| -2 | `zuzu/db/models/user/app_user.py:323` | `settings` | constant | 7 | 9 | `UserSettings` |
| -2 | `zuzu/packages/company/meeting/types/agendas/new_issue_input.py:50` | `payment_bank` | constant | 14 | 16 | `` |
| -2 | `zuzu/packages/company/meeting/types/service_fee_types.py:25` | `items` | constant | 24 | 26 | `ServiceFeeItem` |
| -2 | `zuzu/packages/company/stakeholder/option_grantee/option_grantee_service.py:16` | `is_external_expert` | constant | 3 | 5 | `` |
| -2 | `zuzu/packages/investment_association/bulk_email/types.py:20` | `cc_emails` | constant | 5 | 7 | `` |
| -2 | `zuzu/packages/investment_round/graphql/mutations/base/investment_round_validation_mutation.py:34` | `new_issue_events` | constant | 1 | 3 | `NewIssueEvent` |
| -2 | `zuzu/packages/modusign/views/webhook.py:61` | `type` | constant | 12 | 14 | `` |
| -2 | `zuzu/packages/ms_word/services/field_tracker_service.py:19` | `page` | constant | 6 | 8 | `` |
| -2 | `zuzu/packages/ms_word/services/ms_word_builder.py:74` | `text` | constant | 1 | 3 | `TRunLike` |
| -2 | `zuzu/packages/ms_word/services/utils/types.py:22` | `color` | constant | 5 | 7 | `Color` |
| -2 | `zuzu/packages/ms_word/services/utils/types.py:8` | `append` | constant | 2 | 4 | `Callable` |
