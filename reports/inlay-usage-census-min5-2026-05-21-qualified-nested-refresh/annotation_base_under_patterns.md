# Annotation Base Undercount Patterns

- Annotation fields checked: 7685
- Base undercount if removing structural margin: 161

## Container Bases

| container extends | n |
|---|---:|
| `<none>` | 35 |
| `TypedDict` | 24 |
| `Protocol` | 23 |
| `TimestampedModel` | 13 |
| `BaseContext` | 10 |
| `TimestampedModel, Castable` | 8 |
| `TypedValidationErrors` | 6 |
| `User` | 4 |
| `TypedBaseMutation.TypedArguments` | 4 |
| `Exception` | 4 |
| `CompanyOwnerRequiredContext` | 4 |
| `Stakeholder` | 3 |
| `HrmWorkBase` | 2 |
| `metaclass=InterfaceMeta` | 2 |
| `NamedTuple` | 2 |
| `TimestampedModel, DirectorsOrShareholdersAgendaChildBase, metaclass=AbstractModelMeta` | 1 |
| `Numbered, TypedDict` | 1 |
| `BulkEmail` | 1 |
| `HrmDeptEventBase` | 1 |
| `InvestmentAssociationDocument` | 1 |
| `QuestionThread` | 1 |
| `SignupChannel` | 1 |
| `Employee` | 1 |
| `TimestampedModel, SoftDeletableModel` | 1 |
| `FiStaAbstractDocument` | 1 |
| `AnnouncementValidationContext` | 1 |
| `CompanyCreateErrors` | 1 |
| `BaseModel` | 1 |
| `PaginationArguments` | 1 |
| `InvestmentSimulationRoundInterface` | 1 |

## Field Type Names

| field extends | n |
|---|---:|
| `<none>` | 52 |
| `NotRequired` | 10 |
| `ManyToManyRelatedManager` | 5 |
| `ProfileType` | 3 |
| `IDStr` | 2 |
| `AgendaNewIssueItemShareClass` | 2 |
| `StockTransferAgreementManagement` | 2 |
| `QuestionMessageAttachmentQuerySet` | 2 |
| `NotRequired, IDStr` | 2 |
| `_DocxRunFont` | 2 |
| `Callable` | 2 |
| `PortfolioCompany` | 2 |
| `NotRequired, PositiveDecimal` | 1 |
| `Type` | 1 |
| `Manager, AgendaNewIssueNewShareClass` | 1 |
| `AgendaOptionExerciseGranteeOptionManager` | 1 |
| `BranchInstallationEvent` | 1 |
| `CompanyPurposeChangeItemManager` | 1 |
| `UUIDField, UUID` | 1 |
| `InvestmentSimulationRoundSellStockInterface` | 1 |
| `PayrollStatementEmailRecipientManager` | 1 |
| `CmeCompanyManager` | 1 |
| `CmeBulkEmailTemplateManager` | 1 |
| `EmailActivityRecipientStatusHistoryManager` | 1 |
| `ManyToManyRelatedManager, Stock, Self` | 1 |
| `ManyToManyRelatedManager, RsuVestingTraceable, Self` | 1 |
| `HrmFixedWorkScheduleManager` | 1 |
| `HrmStaggeredWorkScheduleManager` | 1 |
| `HrmDeptStatus` | 1 |
| `IndividualStockOptionVestingTraceableType` | 1 |

## Largest Base Unders

| diff | file:line | qualified | base | lsp | container extends | field extends |
|---:|---|---|---:|---:|---|---|
| -64 | `zuzu/packages/ms_word/services/utils/types.py:62` | `DocxParagraph.paragraph_format` | 35 | 99 | `Protocol` | `Format` |
| -43 | `zuzu/packages/ms_word/services/utils/types.py:68` | `DocxTableCell.paragraphs` | 9 | 52 | `Protocol` | `DocxParagraph` |
| -39 | `zuzu/packages/ms_word/services/utils/types.py:60` | `DocxParagraph.add_run` | 25 | 64 | `Protocol` | `Callable, DocxRun` |
| -24 | `zuzu/packages/ms_word/services/utils/types.py:84` | `DocxTableRow.cells` | 7 | 31 | `Protocol` | `DocxTableCell` |
| -22 | `zuzu/packages/ms_word/services/utils/types.py:98` | `DocxTable.rows` | 9 | 31 | `Protocol` | `DocxTableRow` |
| -21 | `zuzu/packages/ms_word/services/utils/types.py:29` | `DocxRun.font` | 4 | 25 | `Protocol` | `_DocxRunFont` |
| -20 | `zuzu/db/models/stakeholder/shareholder/shareholder_institution_member.py:83` | `ShareholderInstitutionMember.ceo_set` | 8 | 28 | `TimestampedModel` | `ShareholderInstitutionMemberCeoManager` |
| -20 | `zuzu/packages/corporate_registration/auto_updater/types/branch_change.py:9` | `BranchChangeEvent.note` | 25 | 45 | `<none>` | `<none>` |
| -18 | `zuzu/packages/ms_word/services/utils/types.py:56` | `DocxParagraph.runs` | 4 | 22 | `Protocol` | `DocxRun` |
| -17 | `zuzu/packages/ms_word/services/utils/types.py:57` | `DocxParagraph.alignment` | 22 | 39 | `Protocol` | `<none>` |
| -15 | `zuzu/db/models/user/app_user.py:327` | `AppUser.two_factor_authentication_set` | 6 | 21 | `User` | `TwoFactorAuthenticationManager` |
| -15 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:16` | `TypedMeetingPlanAgenda.agenda_type` | 72 | 87 | `metaclass=InterfaceMeta` | `<none>` |
| -14 | `zuzu/db/models/stock_transfer_agreement/stock_transfer_agreement.py:280` | `StockTransferAgreement.management` | 17 | 31 | `TimestampedModel, SoftDeletableModel` | `StockTransferAgreementManagement` |
| -12 | `zuzu/packages/ms_word/services/utils/types.py:21` | `_DocxRunFont.size` | 6 | 18 | `<none>` | `Length` |
| -12 | `zuzu/packages/ms_word/services/utils/types.py:99` | `DocxTable.columns` | 32 | 44 | `Protocol` | `DocxTableColumn` |
| -11 | `zuzu/db/models/question_thread/company_question_thread.py:383` | `CompanyQuestionThread.message_set` | 29 | 40 | `QuestionThread` | `QuestionThreadMessageManager` |
| -11 | `zuzu/packages/company/payroll/year_end_tax_settlement/year_end_tax_settlement_public/types/yets_employee_upload_form_version2.py:9` | `_YetsEmployeeFileTypeVersion2.public_link` | 4 | 15 | `TypedDict` | `<none>` |
| -11 | `zuzu/packages/ms_word/services/utils/types.py:28` | `DocxRun.bold` | 2 | 13 | `Protocol` | `<none>` |
| -10 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:442` | `OptionVestingTraceable.CopyAndUpdateProps.traceable_type` | 1 | 11 | `TypedDict` | `VestingTraceableType` |
| -10 | `zuzu/packages/company/meeting/services/meeting_plan_agenda_base.py:19` | `TypedMeetingPlanAgenda.deadline_date` | 30 | 40 | `metaclass=InterfaceMeta` | `<none>` |
| -10 | `zuzu/packages/ms_word/services/utils/types.py:85` | `DocxTableRow.height` | 0 | 10 | `Protocol` | `<none>` |
| -10 | `zuzu/packages/ms_word/services/utils/types.py:92` | `DocxTableColumn.width` | 20 | 30 | `Protocol` | `<none>` |
| -8 | `zuzu/db/models/option/option_vesting/option_vesting_traceable.py:443` | `OptionVestingTraceable.CopyAndUpdateProps.valid_from` | 2 | 10 | `TypedDict` | `NotRequired` |
| -8 | `zuzu/packages/ms_word/services/utils/types.py:73` | `DocxTableCell.add_paragraph` | 10 | 18 | `Protocol` | `Callable, DocxParagraph` |
| -7 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:11` | `PurposeItemEvent.purpose` | 2 | 9 | `NamedTuple` | `<none>` |
| -6 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:114` | `CompanyManagingEntity.cme_company_set` | 7 | 13 | `TimestampedModel` | `CmeCompanyManager` |
| -6 | `zuzu/db/models/user/app_user.py:321` | `AppUser.phone_set` | 2 | 8 | `User` | `PhoneManager` |
| -6 | `zuzu/packages/corporate_registration/auto_updater/types/purpose_change.py:14` | `PurposeItemEvent.change_note` | 2 | 8 | `NamedTuple` | `ChangeNote` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:22` | `_DocxRunFont.color` | 1 | 7 | `<none>` | `Color` |
| -6 | `zuzu/packages/ms_word/services/utils/types.py:69` | `DocxTableCell.vertical_alignment` | 1 | 7 | `Protocol` | `WD_CELL_VERTICAL_ALIGNMENT` |
| -5 | `zuzu/db/models/agenda/option_exercise/agenda_option_exercise_grantee.py:130` | `AgendaOptionExerciseGrantee.option_set` | 3 | 8 | `TimestampedModel` | `AgendaOptionExerciseGranteeOptionManager` |
| -5 | `zuzu/db/models/branch.py:15` | `Branch.installation_event` | 18 | 23 | `Numbered, TypedDict` | `BranchInstallationEvent` |
| -5 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:481` | `RsuVestingTraceable.CopyAndUpdateProps.traceable_type` | 1 | 6 | `TypedDict` | `NotRequired` |
| -5 | `zuzu/db/models/stakeholder/shareholder/shareholder.py:329` | `Shareholder.institution_member_set` | 49 | 54 | `<none>` | `ShareholderInstitutionMemberManager` |
| -5 | `zuzu/db/models/user/app_user.py:311` | `AppUser.companyuserrelation_set` | 4 | 9 | `User` | `ValidCompanyUserRelationManager` |
| -5 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:26` | `AnnouncementValidationContext.subscription_plans` | 0 | 5 | `BaseContext` | `SubscriptionPlanQuerySet` |
| -5 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:27` | `AnnouncementValidationContext.companies` | 0 | 5 | `BaseContext` | `CompanyQuerySet` |
| -5 | `zuzu/packages/document/base.py:36` | `InvalidDocumentType.director_type` | 2 | 7 | `Exception` | `<none>` |
| -5 | `zuzu/packages/investment_association/helpdesk/graphql/queries/staff_ia_question_thread_list_query.py:22` | `StaffIaQuestionThreadListQuery.StaffIaQuestionThreadListInputArguments.where` | 0 | 5 | `PaginationArguments` | `IaQuestionThreadFilterInputType` |
| -5 | `zuzu/packages/ms_word/services/utils/types.py:70` | `DocxTableCell.width` | 2 | 7 | `Protocol` | `<none>` |
| -5 | `zuzu/tests/legal/background_tasks/test_send_help_reminder.py:146` | `SendHelpReminderTestCase._TestSettings.elapsed` | 0 | 5 | `TypedDict` | `<none>` |
| -4 | `zuzu/db/models/company_managing_entity/company_managing_entity.py:119` | `CompanyManagingEntity.bulk_email_template_set` | 2 | 6 | `TimestampedModel` | `CmeBulkEmailTemplateManager` |
| -4 | `zuzu/db/models/events/event.py:617` | `Event.outward_stocks` | 40 | 44 | `TimestampedModel, Castable` | `ManyToManyRelatedManager, Stock, Self` |
| -4 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:297` | `IndividualStockOptionVestingTraceable.CopyAndUpdateProps.traceable_type` | 1 | 5 | `TypedDict` | `IndividualStockOptionVestingTraceableType` |
| -4 | `zuzu/db/models/rsu/rsu_vesting/rsu_vesting_traceable.py:482` | `RsuVestingTraceable.CopyAndUpdateProps.valid_from` | 2 | 6 | `TypedDict` | `NotRequired` |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:30` | `AnnouncementValidationContext.pin_start_at` | 0 | 4 | `BaseContext` | `<none>` |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:29` | `AnnouncementValidationContext.attachments` | 0 | 4 | `BaseContext` | `QuestionMessageAttachment` |
| -4 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:31` | `AnnouncementValidationContext.pin_end_at` | 0 | 4 | `BaseContext` | `<none>` |
| -4 | `zuzu/packages/company/meeting/registration_fee/types.py:98` | `MeetingForTaxAndFeeCalculation.number_of_shareholders_meeting_minutes_notarization` | 15 | 19 | `<none>` | `<none>` |
| -4 | `zuzu/packages/company/meeting/registration_fee/types.py:99` | `MeetingForTaxAndFeeCalculation.number_of_directors_meeting_minutes_notarization` | 15 | 19 | `<none>` | `<none>` |
| -4 | `zuzu/packages/ms_word/services/field_tracker_service.py:18` | `FieldTracker.type` | 5 | 9 | `<none>` | `TFieldTrackerType` |
| -4 | `zuzu/packages/ms_word/services/utils/types.py:97` | `DocxTable.style` | 4 | 8 | `Protocol` | `<none>` |
| -3 | `zuzu/app/graphql/types/__init__.py:365` | `StockTransferQuantityInput.total_price` | 0 | 3 | `TypedDict` | `NotRequired, PositiveDecimal` |
| -3 | `zuzu/db/models/company/investment_simulation/interfaces.py:22` | `InvestmentSimulationRoundSellStockInterface.share_class_identifier` | 0 | 3 | `<none>` | `<none>` |
| -3 | `zuzu/db/models/company/payroll/statement/email/payroll_statement_email.py:68` | `PayrollStatementEmail.employee_set` | 3 | 6 | `BulkEmail` | `PayrollStatementEmailRecipientManager` |
| -3 | `zuzu/db/models/department/company_registration_staff_status.py:43` | `CompanyRegistrationStaffStatus.user_id` | 4 | 7 | `TimestampedModel` | `<none>` |
| -3 | `zuzu/db/models/individual_investor/individual_stock_option/individual_stock_option_vesting/individual_stock_option_vesting_traceable.py:298` | `IndividualStockOptionVestingTraceable.CopyAndUpdateProps.valid_from` | 2 | 5 | `TypedDict` | `NotRequired` |
| -3 | `zuzu/db/models/shareholders_meeting_agenda.py:577` | `ShareholdersMeetingAgenda.shareholder_vote_set` | 3 | 6 | `TimestampedModel` | `ShareholderVoteManager` |
| -3 | `zuzu/packages/announcement/graphql/mutations/base/announcement_validation_mutation.py:28` | `AnnouncementValidationContext.profile` | 0 | 3 | `BaseContext` | `ProfileType` |
| -3 | `zuzu/packages/company/company_investment_contract_info/graphql/mutations/base_authorized_options_soft_limit_mutation.py:35` | `TypedBaseAuthorizedOptionsSoftLimitMutationErrors.authorized_options_method` | 0 | 3 | `TypedValidationErrors` | `<none>` |
