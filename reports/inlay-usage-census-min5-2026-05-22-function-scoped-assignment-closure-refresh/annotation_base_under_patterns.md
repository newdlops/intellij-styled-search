# Annotation Base Under Patterns

- under=112, missed=31

| base_diff | file:line | name | kind | base | lsp | extends |
|---:|---|---|---|---:|---:|---|
| -32 | `zuzu/packages/ms_word/services/utils/types.py:62` | `paragraph_format` | constant | 67 | 99 | `Format` |
| -24 | `zuzu/packages/ms_word/services/utils/types.py:68` | `paragraphs` | constant | 28 | 52 | `DocxParagraph` |
| -20 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:83` | `ceo_set` | constant | 8 | 28 | `ShareholderInstitutionMemberCeoManager` |
| -20 | `zuzu/packages/corporate_registration/auto_updater/types/branch_change.py:9` | `note` | constant | 25 | 45 | `` |
| -15 | `zuzu/db/models/user/app_user.py:327` | `two_factor_authentication_set` | constant | 6 | 21 | `TwoFactorAuthenticationManager` |
| -15 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:16` | `agenda_type` | constant | 72 | 87 | `` |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:280` | `management` | constant | 17 | 31 | `StockTransferAgreementManagement` |
| -13 | `zuzu/packages/ms_word/services/utils/types.py:56` | `runs` | constant | 9 | 22 | `DocxRun` |
| -11 | `zuzu/db/models/question_thread/company_question_thread.py:383` | `message_set` | constant | 29 | 40 | `QuestionThreadMessageManager` |
| -11 | `zuzu/packages/company/payroll/year_end_tax_settlement/year_end_tax_settlement_public/types/yets_employee_upload_form_version2.py:9` | `public_link` | constant | 4 | 15 | `` |
| -11 | `zuzu/packages/ms_word/services/utils/types.py:60` | `add_run` | constant | 53 | 64 | `Callable, DocxRun` |
| -10 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:442` | `traceable_type` | constant | 1 | 11 | `VestingTraceableType` |
| -10 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:19` | `deadline_date` | constant | 30 | 40 | `` |
| -8 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:443` | `valid_from` | constant | 2 | 10 | `NotRequired` |
| -8 | `zuzu/packages/ms_word/services/utils/types.py:29` | `font` | constant | 17 | 25 | `_DocxRunFont` |
| -7 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:11` | `purpose` | constant | 2 | 9 | `` |
| -7 | `zuzu/packages/ms_word/services/utils/types.py:21` | `size` | constant | 11 | 18 | `Length` |
| -6 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:114` | `cme_company_set` | constant | 7 | 13 | `CmeCompanyManager` |
| -6 | `zuzu/db/models/stakeholder/esop_participant.py:101` | `employee_stock_set` | constant | 7 | 13 | `AllEmployeeStockManager` |
| -6 | `zuzu/db/models/user/app_user.py:321` | `phone_set` | constant | 2 | 8 | `PhoneManager` |
| -6 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:14` | `change_note` | constant | 2 | 8 | `ChangeNote` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:28` | `bold` | constant | 7 | 13 | `` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:73` | `add_paragraph` | constant | 12 | 18 | `Callable, DocxParagraph` |
| -5 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee.py:130` | `option_set` | constant | 3 | 8 | `AgendaOptionExerciseGranteeOptionManager` |
| -5 | `zuzu/db/models/branch.py:15` | `installation_event` | constant | 18 | 23 | `BranchInstallationEvent` |
| -5 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:481` | `traceable_type` | constant | 1 | 6 | `NotRequired` |
| -5 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:329` | `institution_member_set` | constant | 49 | 54 | `ShareholderInstitutionMemberManager` |
| -5 | `zuzu/db/models/user/app_user.py:311` | `companyuserrelation_set` | constant | 4 | 9 | `ValidCompanyUserRelationManager` |
| -5 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:26` | `subscription_plans` | constant | 0 | 5 | `SubscriptionPlanQuerySet` |
| -5 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:27` | `companies` | constant | 0 | 5 | `CompanyQuerySet` |
| -5 | `zuzu/packages/investment_association/helpdesk/graphql/queries/staff_ia_question_thread_list_query.py:22` | `where` | constant | 0 | 5 | `IaQuestionThreadFilterInputType` |
| -5 | `zuzu/tests/legal/background_tasks/test_send_help_reminder.py:146` | `elapsed` | constant | 0 | 5 | `` |
| -4 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:119` | `bulk_email_template_set` | constant | 2 | 6 | `CmeBulkEmailTemplateManager` |
| -4 | `zuzu/db/models/events/event.py:617` | `outward_stocks` | constant | 40 | 44 | `ManyToManyRelatedManager, Stock, Self` |
| -4 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:297` | `traceable_type` | constant | 1 | 5 | `IndividualStockOptionVestingTraceableType` |
| -4 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:482` | `valid_from` | constant | 2 | 6 | `NotRequired` |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:30` | `pin_start_at` | constant | 0 | 4 | `` |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:29` | `attachments` | constant | 0 | 4 | `QuestionMessageAttachment` |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:31` | `pin_end_at` | constant | 0 | 4 | `` |
| -4 | `zuzu/packages/company/meeting/registration_fee/types.py:98` | `number_of_shareholders_meeting_minutes_notarization` | constant | 15 | 19 | `` |
| -4 | `zuzu/packages/company/meeting/registration_fee/types.py:99` | `number_of_directors_meeting_minutes_notarization` | constant | 15 | 19 | `` |
| -4 | `zuzu/packages/ms_word/services/field_tracker_service.py:18` | `type` | constant | 5 | 9 | `TFieldTrackerType` |
| -4 | `zuzu/packages/subscription/types/subscription_payment_types.py:468` | `perk_payments` | constant | 3 | 7 | `SubscriptionPerkPaymentType` |
| -3 | `zuzu/app/graphql/types/__init__.py:365` | `total_price` | constant | 0 | 3 | `NotRequired, PositiveDecimal` |
| -3 | `zuzu/db/models/company/investment_simulation/interfaces.py:22` | `share_class_identifier` | constant | 0 | 3 | `` |
| -3 | `zuzu/db/models/company/payroll/statement/email/payroll_statement_email.py:68` | `employee_set` | constant | 3 | 6 | `PayrollStatementEmailRecipientManager` |
| -3 | `zuzu/db/models/department/company_registration_staff_status.py:43` | `user_id` | constant | 4 | 7 | `` |
| -3 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:298` | `valid_from` | constant | 2 | 5 | `NotRequired` |
| -3 | `zuzu/db/models/shareholders_meeting_agenda.py:577` | `shareholder_vote_set` | constant | 3 | 6 | `ShareholderVoteManager` |
| -3 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:28` | `profile` | constant | 0 | 3 | `ProfileType` |
| -3 | `zuzu/packages/corporate_registration/auto_updater/types/branch_change.py:11` | `address` | constant | 29 | 32 | `` |
| -3 | `zuzu/packages/investment_association/bulk_email/types.py:19` | `email` | constant | 3 | 6 | `` |
| -3 | `zuzu/packages/investment_simulation/services/types.py:58` | `investors` | constant | 15 | 18 | `InvestmentSimulationRoundInvestorInput` |
| -3 | `zuzu/packages/ms_word/services/utils/types.py:57` | `alignment` | constant | 36 | 39 | `` |
| -3 | `zuzu/packages/ms_word/services/utils/types.py:92` | `width` | constant | 27 | 30 | `` |
| -3 | `zuzu/packages/ms_word/services/utils/types.py:99` | `columns` | constant | 41 | 44 | `DocxTableColumn` |
| -3 | `zuzu/packages/stock/stock_transfer_service.py:180` | `quantities_to_transfer` | constant | 0 | 3 | `QuantityToTransfer` |
| -3 | `zuzu/packages/stock/stock_transfer_service.py:182` | `transfer_method` | constant | 0 | 3 | `` |
| -3 | `zuzu/packages/stock_transfer_agreement/mutations/v2/pay_stock_transfer_agreement_mutation.py:32` | `stock_transfer_agreement_management` | constant | 3 | 6 | `StockTransferAgreementManagement` |
| -2 | `zuzu/app/graphql/types/__init__.py:363` | `share_class_id` | constant | 0 | 2 | `IDStr` |
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
| -2 | `zuzu/db/models/signup_channel/legal_partner_signup_channel.py:33` | `legal_partner_id` | constant | 0 | 2 | `` |
| -2 | `zuzu/db/models/stakeholder/stakeholder.py:80` | `shareholder` | constant | 32 | 34 | `Shareholder` |
| -2 | `zuzu/db/models/user/app_user.py:323` | `settings` | constant | 7 | 9 | `UserSettings` |
| -2 | `zuzu/packages/announcement/graphql/mutations/announcement_edit_mutation.py:21` | `announcement` | constant | 0 | 2 | `Announcement` |
| -2 | `zuzu/packages/company/meeting/types/agendas/new_issue_input.py:50` | `payment_bank` | constant | 14 | 16 | `` |
| -2 | `zuzu/packages/company/meeting/types/service_fee_types.py:25` | `items` | constant | 24 | 26 | `ServiceFeeItem` |
| -2 | `zuzu/packages/company/stakeholder/option_grantee/option_grantee_service.py:16` | `is_external_expert` | constant | 3 | 5 | `` |
