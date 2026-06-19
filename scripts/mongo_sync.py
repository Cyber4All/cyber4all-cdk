#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "bcrypt==4.2.1",
#   "boto3==1.35.68",
#   "inquirer==3.4.0",
#   "pymongo[aws]==4.10.0",
# ]
# ///
from __future__ import annotations

import configparser
import contextlib
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator, Sequence
from urllib.parse import parse_qsl, urlencode

import bcrypt
import boto3
import botocore.exceptions
import inquirer
import pymongo

REGION = "us-east-1"
REGION_SHORT = "use1"
LOCAL_URI = "mongodb://localhost:27017"
MOCK_PASSWORD = "MockPassword123"
DEFAULT_APPS = ("clark", "competency")
LEGACY_SSM_ACCOUNT_ID = "842676000360"
PROD_MONGO_AUTH_ROLE_ARN = "arn:aws:iam::194683060534:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AWSDeveloperAccess_a4ce2d7d5ed4adfc"
STAGING_MONGO_AUTH_ROLE_ARN = "arn:aws:iam::317620868823:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AWSDeveloperAccess_6653ddc859367089"
SOURCE_CHOICES = {
    "Legacy prod SSM connection strings": "legacy",
    "Current prod Secrets Manager connection strings": "current",
}
TARGET_CHOICES = {
    "Staging": "staging",
    "Local": "local",
}

SECRET_NAME = (
    "/cyber4all/mongodb/{env}-cyber4all-{app}-cluster-" + REGION_SHORT + "/connection"
)
SECRET_URI_KEY = "MONGODB_URI"
LEGACY_SSM_NAME = "/{legacy_env}/{app}/mongo/connection-string"

LEGACY_ENVS = {"prd": "prod", "stg": "staging"}
USER_COLLECTIONS = {
    "clark": ("onion", "users"),
    "competency": ("secured-auth", "users"),
}
ALL_APPS = {"clark", "competency", "card"}

log = logging.getLogger("mongo-sync")


class SyncError(RuntimeError):
    pass


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(levelname)s] %(asctime)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    try:
        if len(sys.argv) > 1:
            raise SyncError(
                "This script now uses interactive prompts. Run `uv run scripts/mongo_sync.py` without arguments."
            )
        args = prompt_args()
        args.func(args)
    except SyncError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130
    return 0


def prompt_args() -> SimpleNamespace:
    if not sys.stdin.isatty():
        raise SyncError("Interactive prompts require a TTY.")

    source_label = ask(
        [
            inquirer.List(
                "source", message="Which prod source?", choices=tuple(SOURCE_CHOICES)
            )
        ]
    )["source"]
    target_label = ask(
        [
            inquirer.List(
                "target",
                message="Restore prod backup to?",
                choices=tuple(TARGET_CHOICES),
            )
        ]
    )["target"]
    source = SOURCE_CHOICES[source_label]
    target = TARGET_CHOICES[target_label]

    return SimpleNamespace(
        source=source,
        target=target,
        func=run_selected_workflow,
        apps=DEFAULT_APPS,
        legacy_ssm_profile=find_legacy_ssm_profile() if source == "legacy" else None,
        source_profile=find_profile_for_role(PROD_MONGO_AUTH_ROLE_ARN),
        target_profile=(
            find_profile_for_role(STAGING_MONGO_AUTH_ROLE_ARN)
            if target == "staging"
            else None
        ),
        backup_path=Path("mongo-backups") / time.strftime("%Y%m%d-%H%M%S"),
        mock_password_value=MOCK_PASSWORD,
    )


def ask(questions: Sequence[Any]) -> dict[str, Any]:
    answers = inquirer.prompt(questions)
    if answers is None:
        raise SyncError("Prompt cancelled.")
    return answers


def run_selected_workflow(args: SimpleNamespace) -> None:
    apps = app_list(args.apps)

    check_tools()
    check_mongo_auth_profiles(args)
    confirm_restore(apps, target_label(args.target))
    if args.target == "local":
        check_local_target()
    log.warning(
        "Password mocking is required for %s restores. App user passwords will be set to %s.",
        args.target,
        args.mock_password_value,
    )

    backup_prod(args, apps)
    restore_backup(args, apps)


def backup_prod(args: SimpleNamespace, apps: Sequence[str]) -> Path:
    backup_dir = args.backup_path

    if backup_dir.exists() and any(backup_dir.iterdir()):
        raise SyncError(f"Backup directory is not empty: {backup_dir}")
    backup_dir.mkdir(parents=True, exist_ok=True)

    log.info("Writing backups to %s.", backup_dir)
    manifest = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "region": REGION,
        "source": "prod",
        "source_store": "legacy-ssm" if args.source == "legacy" else "secrets-manager",
        "source_mongo_auth_role_arn": PROD_MONGO_AUTH_ROLE_ARN,
        "target": args.target,
        "apps": {},
    }
    if args.source == "legacy":
        manifest["legacy_ssm_account_id"] = LEGACY_SSM_ACCOUNT_ID
    for app in apps:
        archive = backup_dir / f"{app}.archive.gz"
        dump(prod_uri(app, args), archive, args.source_profile)
        manifest["apps"][app] = {"archive": archive.name}

    (backup_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    return backup_dir


def restore_backup(args: SimpleNamespace, apps: Sequence[str]) -> None:
    for app in apps:
        archive = args.backup_path / f"{app}.archive.gz"
        uri = target_uri(app, args.target, args.target_profile)
        restore(uri, archive, args.target_profile)
        mock_app_passwords(app, uri, args.target_profile, args.mock_password_value)


def app_list(raw: Sequence[str]) -> tuple[str, ...]:
    apps = [
        part.strip().lower()
        for value in raw
        for part in value.split(",")
        if part.strip()
    ]
    unknown = sorted(set(apps) - ALL_APPS)
    if unknown:
        raise SyncError(
            f"Unknown app(s): {', '.join(unknown)}. Supported apps: {', '.join(sorted(ALL_APPS))}."
        )
    if not apps:
        raise SyncError("At least one app is required.")
    return tuple(dict.fromkeys(apps))


def check_mongo_auth_profiles(args: SimpleNamespace) -> None:
    check_expected_role(
        args.source_profile, PROD_MONGO_AUTH_ROLE_ARN, "prod MongoDB auth"
    )
    if args.target == "staging":
        check_expected_role(
            args.target_profile, STAGING_MONGO_AUTH_ROLE_ARN, "staging MongoDB auth"
        )


def check_expected_role(
    profile: str | None, expected_role_arn: str, label: str
) -> None:
    try:
        caller_arn = aws(profile).client("sts").get_caller_identity()["Arn"]
    except (botocore.exceptions.BotoCoreError, botocore.exceptions.ClientError) as exc:
        raise SyncError(
            f"Could not verify {label} profile {profile or 'default'} with STS: {exc}"
        ) from exc

    if not caller_matches_role(caller_arn, expected_role_arn):
        raise SyncError(
            f"The {label} profile {profile or 'default'} resolves to {caller_arn}, "
            f"but Atlas is configured for {expected_role_arn}."
        )
    log.info("Verified %s profile %s as %s.", label, profile or "default", caller_arn)


def caller_matches_role(caller_arn: str, expected_role_arn: str) -> bool:
    if caller_arn == expected_role_arn:
        return True

    expected_account, expected_role = role_account(expected_role_arn), role_name(
        expected_role_arn
    )
    assumed = re.fullmatch(
        r"arn:aws:sts::(?P<account>\d+):assumed-role/(?P<role>[^/]+)/.+", caller_arn
    )
    return bool(
        assumed
        and assumed["account"] == expected_account
        and assumed["role"] == expected_role
    )


def role_account(role_arn: str) -> str:
    return role_arn.split(":", 5)[4]


def role_name(role_arn: str) -> str:
    return role_arn.rsplit("/", 1)[1]


def find_profile_for_role(role_arn: str) -> str:
    account = role_account(role_arn)
    permission_set = sso_permission_set(role_arn)
    profiles = aws_config_profiles()

    matches = [
        name
        for name, values in profiles.items()
        if values.get("sso_account_id") == account
        and values.get("sso_role_name") == permission_set
    ]
    matches.extend(
        name
        for name, values in profiles.items()
        if values.get("role_arn") == role_arn and name not in matches
    )

    if not matches:
        raise SyncError(
            f"No AWS profile found in ~/.aws/config for account {account} and SSO role {permission_set}. "
            "Run `aws configure sso` or add the profile, then rerun this script."
        )
    if len(matches) > 1:
        log.warning(
            "Multiple profiles match %s in account %s. Using %s.",
            permission_set,
            account,
            matches[0],
        )
    return matches[0]


def find_legacy_ssm_profile() -> str:
    profiles = aws_config_profiles()
    preferred = ("AWSDeveloperAccess", "AWSAdministratorAccess")
    for permission_set in preferred:
        for name, values in profiles.items():
            if (
                values.get("sso_account_id") == LEGACY_SSM_ACCOUNT_ID
                and values.get("sso_role_name") == permission_set
            ):
                return name

    matches = [
        name
        for name, values in profiles.items()
        if values.get("sso_account_id") == LEGACY_SSM_ACCOUNT_ID
    ]
    if not matches:
        raise SyncError(
            f"No AWS profile found in ~/.aws/config for legacy SSM account {LEGACY_SSM_ACCOUNT_ID}. "
            "Run `aws configure sso` or add a dev-account profile that can read the legacy parameters."
        )
    if len(matches) > 1:
        log.warning(
            "Multiple profiles match legacy SSM account %s. Using %s.",
            LEGACY_SSM_ACCOUNT_ID,
            matches[0],
        )
    return matches[0]


def aws_config_profiles() -> dict[str, dict[str, str]]:
    config_path = Path.home() / ".aws" / "config"
    if not config_path.exists():
        raise SyncError(f"AWS config file not found: {config_path}")

    parser = configparser.ConfigParser(interpolation=None)
    parser.read(config_path)
    profiles: dict[str, dict[str, str]] = {}
    for section in parser.sections():
        if section == "default":
            name = "default"
        elif section.startswith("profile "):
            name = section.removeprefix("profile ")
        else:
            continue
        profiles[name] = {key: value for key, value in parser.items(section)}
    return profiles


def sso_permission_set(role_arn: str) -> str:
    name = role_name(role_arn)
    match = re.fullmatch(r"AWSReservedSSO_(?P<permission_set>.+)_[0-9a-f]+", name)
    return match["permission_set"] if match else name


def prod_uri(app: str, args: SimpleNamespace) -> str:
    if args.source == "legacy":
        return mongo_uri(ssm_uri(app, "prd", args.legacy_ssm_profile))
    return mongo_uri(secret_uri(app, "prd", args.source_profile))


def target_uri(app: str, target: str, target_profile: str | None) -> str:
    if target == "local":
        return LOCAL_URI
    if target == "staging":
        return mongo_uri(secret_uri(app, "stg", target_profile))
    raise SyncError(f"Unsupported restore target: {target}")


def secret_uri(app: str, env: str, profile: str | None) -> str:
    name = SECRET_NAME.format(env=env, app=app)
    try:
        response = aws(profile).client("secretsmanager").get_secret_value(SecretId=name)
    except botocore.exceptions.BotoCoreError as exc:
        raise SyncError(f"Secrets Manager lookup failed for {name}: {exc}") from exc

    value = response.get("SecretString")
    if not value:
        raise SyncError(f"Secrets Manager secret {name} had no value.")

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = value

    if isinstance(parsed, str) and parsed.startswith("mongodb"):
        return parsed
    if isinstance(parsed, dict):
        uri = parsed.get(SECRET_URI_KEY)
        if isinstance(uri, str) and uri.startswith("mongodb"):
            return uri
    raise SyncError(f"Secrets Manager secret {name} does not contain {SECRET_URI_KEY}.")


def ssm_uri(app: str, env: str, profile: str | None) -> str:
    name = LEGACY_SSM_NAME.format(legacy_env=LEGACY_ENVS[env], app=app)
    try:
        value = (
            aws(profile)
            .client("ssm")
            .get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
        )
    except botocore.exceptions.BotoCoreError as exc:
        raise SyncError(f"SSM lookup failed for {name}: {exc}") from exc
    if not value.startswith("mongodb"):
        raise SyncError(f"SSM parameter {name} is not a MongoDB URI.")
    return value


def aws(profile: str | None) -> boto3.Session:
    try:
        return (
            boto3.Session(profile_name=profile, region_name=REGION)
            if profile
            else boto3.Session(region_name=REGION)
        )
    except botocore.exceptions.ProfileNotFound as exc:
        raise SyncError(f"AWS profile not found: {profile}") from exc


def mongo_uri(uri: str) -> str:
    if not uri.startswith(("mongodb://", "mongodb+srv://")):
        raise SyncError("MongoDB URI must start with mongodb:// or mongodb+srv://.")
    if (
        not uri.startswith("mongodb+srv://")
        or has_credentials(uri)
        or query_arg(uri, "authMechanism")
    ):
        return uri

    base, _, query = uri.partition("?")
    if "/" not in base.removeprefix("mongodb+srv://"):
        base += "/"
    params = parse_qsl(query, keep_blank_values=True)
    keys = {key.lower() for key, _ in params}
    if "authsource" not in keys:
        params.append(("authSource", "$external"))
    if "authmechanism" not in keys:
        params.append(("authMechanism", "MONGODB-AWS"))
    return f"{base}?{urlencode(params)}"


def has_credentials(uri: str) -> bool:
    return "@" in uri.split("://", 1)[1].split("/", 1)[0].split("?", 1)[0]


def query_arg(uri: str, wanted: str) -> str | None:
    for key, value in parse_qsl(uri.partition("?")[2], keep_blank_values=True):
        if key.lower() == wanted.lower():
            return value
    return None


@contextlib.contextmanager
def atlas_env(uri: str, profile: str | None) -> Iterator[None]:
    if (query_arg(uri, "authMechanism") or "").upper() != "MONGODB-AWS":
        yield
        return

    try:
        credentials = aws(profile).get_credentials()
        if credentials is None:
            raise SyncError(
                f"No AWS credentials found for profile {profile or 'default'}."
            )
        frozen = credentials.get_frozen_credentials()
    except botocore.exceptions.BotoCoreError as exc:
        hint = f" --profile {profile}" if profile else ""
        raise SyncError(
            f"Could not load AWS credentials. Run `aws sso login{hint}` if using SSO. {exc}"
        ) from exc

    old = {
        key: os.environ.get(key)
        for key in (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_REGION",
        )
    }
    os.environ["AWS_ACCESS_KEY_ID"] = frozen.access_key
    os.environ["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
    os.environ["AWS_REGION"] = REGION
    if frozen.token:
        os.environ["AWS_SESSION_TOKEN"] = frozen.token
    else:
        os.environ.pop("AWS_SESSION_TOKEN", None)
    try:
        yield
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def dump(uri: str, archive: Path, profile: str | None) -> None:
    run(
        ["mongodump", f"--uri={uri}", f"--archive={archive}", "--gzip", "--quiet"],
        uri,
        profile,
    )


def restore(uri: str, archive: Path, profile: str | None) -> None:
    if not archive.exists():
        raise SyncError(f"Backup archive does not exist: {archive}")
    run(
        [
            "mongorestore",
            f"--uri={uri}",
            f"--archive={archive}",
            "--gzip",
            "--drop",
            "--quiet",
        ],
        uri,
        profile,
    )


def run(command: list[str], uri: str, profile: str | None) -> None:
    log.info("Running: %s", redact_command(command))
    with atlas_env(uri, profile):
        try:
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError as exc:
            raise SyncError(
                f"{command[0]} failed with exit code {exc.returncode}."
            ) from exc


def mock_app_passwords(app: str, uri: str, profile: str | None, password: str) -> None:
    if app not in USER_COLLECTIONS:
        return
    db_name, collection_name = USER_COLLECTIONS[app]

    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode(
        "utf-8"
    )
    with atlas_env(uri, profile):
        client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=5000)
        try:
            result = client[db_name][collection_name].update_many(
                {}, {"$set": {"password": password_hash}}
            )
        except pymongo.errors.PyMongoError as exc:
            raise SyncError(f"Failed to mock passwords for {app}: {exc}") from exc
        finally:
            client.close()
    log.warning(
        "Mocked passwords for %s users in %s.%s.",
        result.modified_count,
        db_name,
        collection_name,
    )


def check_tools() -> None:
    missing = [
        tool for tool in ("mongodump", "mongorestore") if shutil.which(tool) is None
    ]
    if missing:
        raise SyncError("Missing MongoDB Database Tools: " + ", ".join(missing))


def check_local_target() -> None:
    client = pymongo.MongoClient(LOCAL_URI, serverSelectionTimeoutMS=3000)
    try:
        client.admin.command("ping")
    except pymongo.errors.PyMongoError as exc:
        raise SyncError(f"Could not connect to local MongoDB at {LOCAL_URI}.") from exc
    finally:
        client.close()


def confirm_restore(apps: Sequence[str], target: str) -> None:
    log.warning(
        "Restore uses mongorestore --drop for app(s) %s into %s.",
        ", ".join(apps),
        target,
    )
    if not sys.stdin.isatty():
        raise SyncError("Restore confirmation requires a TTY.")
    confirmation = ask(
        [inquirer.Text("confirmation", message="Type 'restore' to continue")]
    )["confirmation"]
    if confirmation.strip() != "restore":
        raise SyncError("Restore cancelled.")


def target_label(target: str) -> str:
    return LOCAL_URI if target == "local" else target


def redact_command(command: Sequence[str]) -> str:
    return shlex.join(
        [
            "--uri=" + redact_uri(arg[6:]) if arg.startswith("--uri=") else arg
            for arg in command
        ]
    )


def redact_uri(uri: str | None) -> str:
    if not uri:
        return ""
    return re.sub(r"(mongodb(?:\+srv)?://)([^/@]+)@", r"\1***@", uri)


if __name__ == "__main__":
    raise SystemExit(main())
