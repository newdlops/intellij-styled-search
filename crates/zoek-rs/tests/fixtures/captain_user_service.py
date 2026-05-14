from functools import partial
from typing import TypedDict

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.validators import validate_email
from django.db.transaction import atomic, on_commit
from django.utils import timezone

from zuzu.common.exception import DuplicatedEmail, PasswordTooShort
from zuzu.db.models import (
    AppUser,
    Email,
    InputChannel,
    InputSignupChannel,
    PrivacyPolicy,
    PrivacyPolicyLog,
    SignupChannel,
    SignupLog,
    User,
    UserMarketingStatus,
    UserNotificationSettings,
    UserProfileImage,
    UserProfileImageMapping,
    UserSettings,
    UserSurvey,
)
from zuzu.db.models.user.survey.user_survey_version4 import UserSurveyVersion4
from zuzu.packages.pipedrive.tasks import sync_user_to_pipedrive

from ..notifications import (
    SignupNotification,
    UserShouldAuthenticateTwoFactorChangedNotification,
)
from ..types.signup_channel_input_type import SignupChannelInputType
from .signup_channel_service import SignupChannelCreatorBase

__all__ = [
    "get_active_user_by_email",
    "get_user",
    "edit_user_should_authenticate_two_factor",
    "edit_user_slack_member_id",
    "edit_user_profile_images",
    "edit_user_signup_channel",
    "signup",
    "edit_user",
]


def get_user(user_id: int | str) -> AppUser:
    return AppUser.objects.get(id=user_id)


def get_active_user_by_email(email: str) -> AppUser:
    return AppUser.objects.get(email=email, is_active=True)


@atomic
def edit_user_should_authenticate_two_factor(
    *,
    staff: AppUser,
    target_user: AppUser,
    should_authenticate_two_factor: bool,
) -> None:
    user_settings = target_user.settings
    if user_settings.should_authenticate_two_factor == should_authenticate_two_factor:
        return

    user_settings.should_authenticate_two_factor = should_authenticate_two_factor
    user_settings.save(update_fields=["should_authenticate_two_factor"])

    UserShouldAuthenticateTwoFactorChangedNotification(
        staff_name=staff.full_name,
        user_name=target_user.full_name,
        should_authenticate_two_factor=should_authenticate_two_factor,
    ).send()


@atomic
def edit_user_slack_member_id(user: AppUser, slack_member_id: str) -> None:
    user.slack_member_id = slack_member_id
    user.save(update_fields=["slack_member_id"])


@atomic
def edit_user_profile_images(
    *,
    user: AppUser,
    profile_image: UserProfileImage | None,
    profile_image_for_email: UserProfileImage | None,
    is_profile_image_changed: bool,
    is_profile_image_for_email_changed: bool,
) -> None:
    class UserProfileImageUpdateDict(TypedDict, total=False):
        profile_image: UserProfileImage | None
        profile_image_for_email: UserProfileImage | None

    updates = UserProfileImageUpdateDict()

    if is_profile_image_changed:
        updates["profile_image"] = profile_image

    if is_profile_image_for_email_changed:
        updates["profile_image_for_email"] = profile_image_for_email

    UserProfileImageMapping.objects.update_or_create(user=user, defaults=dict(updates))


@atomic
def edit_user_signup_channel(
    target_user: AppUser,
    signup_channel: SignupChannelInputType | None,
) -> None:
    if signup_channel is None:
        return
    signup_channel_type = signup_channel.get("type", "")
    name = signup_channel.get("name", "")

    input_channel = InputChannel.objects.filter(
        signup_channel_type=signup_channel_type
    ).first()
    if not input_channel:
        input_channel = InputChannel.objects.create(
            signup_channel_type=signup_channel_type,
            name=name,
        )

    InputSignupChannel.objects.filter(user=target_user).delete()
    InputSignupChannel.objects.create(
        user=target_user,
        input_channel=input_channel,
        signup_channel_type=SignupChannel.Type.INPUT,
    )


def signup(
    *,
    email: str,
    password: str,
    phone: str | None = "",
    full_name: str,
    signup_path: str,
    signup_channel_creator: SignupChannelCreatorBase | None,
    alimtalk_marketing_status: bool | None = False,
    email_marketing_status: bool | None = False,
    survey_result: UserSurveyVersion4 | None = None,
) -> AppUser:
    user_model = get_user_model()
    validate_email(email)

    if Email.objects.filter(email__iexact=email).exists():
        raise DuplicatedEmail

    if len(password) < 8:
        raise PasswordTooShort

    user = user_model.objects.create_user(
        username=email,
        email=email,
        password=password,
        full_name=full_name,
        is_active=not settings.SET_INACTIVE_ON_SIGNUP,
    )
    SignupLog.objects.create(user=user, path=signup_path)
    user.email_set.create(email=email)
    if phone:
        user.phone_set.create(phone_number=phone)
    UserSettings.objects.create(user=user)
    UserNotificationSettings.objects.create(
        user=user,
    )
    UserMarketingStatus.objects.create(
        user=user,
        is_marketing_email_on=(
            email_marketing_status if email_marketing_status else False
        ),
        is_marketing_alimtalk_on=(
            alimtalk_marketing_status if alimtalk_marketing_status else False
        ),
        marketing_email_effective_date=(
            timezone.now() if email_marketing_status else None
        ),
        marketing_alimtalk_effective_date=(
            timezone.now() if alimtalk_marketing_status else None
        ),
    )
    PrivacyPolicyLog.objects.create(user=user, privacy_policy=PrivacyPolicy.current())

    if signup_channel_creator:
        signup_channel = signup_channel_creator.create(user)
    else:
        signup_channel = None

    if survey_result is not None:
        _save_user_survey(user=user, survey_result=survey_result)

    SignupNotification(
        full_name=full_name,
        email=email,
        signup_channel=signup_channel,
        signup_path=signup_path,
    ).send()

    return AppUser.objects.get(id=user.id)


@atomic
def edit_user(
    *,
    user: User,
    full_name: str | None = None,
    phone: str | None = None,
    fab_collapse: bool | None = None,
) -> User:
    update_fields = []
    if full_name is not None:
        update_fields.append("full_name")
        user.full_name = full_name
    if phone is not None:
        user.update_phone(phone)
    if fab_collapse is not None:
        user.fab_collapse = fab_collapse
        update_fields.append("fab_collapse")
    user.save(update_fields=update_fields)
    on_commit(partial(sync_user_to_pipedrive.delay, user.id))
    return user


def _save_user_survey(user: User, survey_result: UserSurveyVersion4) -> None:
    UserSurvey.objects.create(user=user, survey_result=survey_result)
