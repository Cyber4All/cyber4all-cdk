#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "bcrypt==4.2.1",
#   "boto3==1.35.68",
#   "pymongo[aws]==4.10.0",
# ]
# ///
from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator, Sequence
from urllib.parse import parse_qsl, urlencode

import bcrypt
import boto3
import botocore.exceptions
import pymongo


REGION = "us-east-1"
REGION_SHORT = "use1"
LOCAL_URI = "mongodb://localhost:27017"
MOCK_PASSWORD = "MockPassword123"
DEFAULT_APPS = ("clark", "competency")
STORES = ("auto", "secrets-manager", "legacy-ssm")

SECRET_NAME = "/cyber4all/mongodb/{env}-cyber4all-{app}-cluster-" + REGION_SHORT + "/connection"
SECRET_URI_KEY = "MONGODB_URI"
LEGACY_SSM_NAME = "/{legacy_env}/{app}/mongo/connection-string"

ENVS = {
    "prod": "prd",
    "production": "prd",
    "prd": "prd",
    "stage": "stg",
    "staging": "stg",
    "stg": "stg",
    "dev": "dev",
    "development": "dev",
}
LEGACY_ENVS = {"prd": "prod", "stg": "staging", "dev": "dev"}
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

    args = parser().parse_args()
    try:
        args.func(args)
    except SyncError as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.error("Interrupted.")
        return 130
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=f"Back up and restore Cyber4All MongoDB data. Only {REGION} is supported.",
    )
    sub = p.add_subparsers(required=True)

    sync = sub.add_parser("sync", help="Dump selected source apps and restore them to the target.")
    add_source(sync)
    add_target(sync)
    add_common(sync)
    sync.set_defaults(func=sync_cmd)

    backup = sub.add_parser("backup", help="Dump selected source apps into archive files.")
    add_source(backup)
    add_app_arg(backup)
    backup.add_argument("-p", "--profile", help="AWS profile used unless --source-profile is set.")
    backup.add_argument("--dry-run", action="store_true")
    backup.add_argument("--out", type=Path, help="Backup directory. Defaults to mongo-backups/<timestamp>.")
    backup.set_defaults(func=backup_cmd)

    restore = sub.add_parser("restore", help="Restore app archive files to a target.")
    add_target(restore)
    add_common(restore)
    restore.add_argument("--from", dest="backup_path", type=Path, required=True)
    restore.set_defaults(func=restore_cmd)

    return p


def add_common(p: argparse.ArgumentParser) -> None:
    add_app_arg(p)
    p.add_argument("-p", "--profile", help="AWS profile used unless a source/target profile is set.")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--yes", action="store_true", help="Skip restore confirmation.")
    p.add_argument("--allow-prod-target", action="store_true", help="Allow restoring into prod.")
    p.add_argument("--skip-local-check", action="store_true")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--mock-passwords", dest="mock_passwords", action="store_true", default=None)
    group.add_argument("--no-mock-passwords", dest="mock_passwords", action="store_false")
    p.add_argument("--mock-password-value", default=MOCK_PASSWORD)


def add_app_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument("--apps", nargs="+", default=list(DEFAULT_APPS), help="Apps to process.")


def add_source(p: argparse.ArgumentParser) -> None:
    p.add_argument("--source", required=True, help="prod/prd, staging/stg, dev, or local.")
    p.add_argument("--source-uri", help="Explicit source URI.")
    p.add_argument("--source-store", choices=STORES, default="auto")
    p.add_argument("--source-profile")


def add_target(p: argparse.ArgumentParser) -> None:
    p.add_argument("--target", required=True, help="staging/stg, dev, prod/prd, or local.")
    p.add_argument("--target-uri", help="Explicit target URI.")
    p.add_argument("--target-store", choices=STORES, default="auto")
    p.add_argument("--target-profile")


def sync_cmd(args: argparse.Namespace) -> None:
    apps = app_list(args.apps)
    source_profile = args.source_profile or args.profile
    target_profile = args.target_profile or args.profile

    check_tools()
    check_target(args.target, args.allow_prod_target)
    confirm_restore(apps, target_label(args), args.yes, args.dry_run)
    check_local_target(args)

    mock_passwords = args.mock_passwords
    if mock_passwords is None:
        mock_passwords = endpoint_env(args.source) == "prd" and target_is_nonprod(args)
    if mock_passwords:
        log.warning("Password mocking is enabled. App user passwords will be set to %s.", args.mock_password_value)

    with tempfile.TemporaryDirectory(prefix="mongo-sync-") as temp:
        for app in apps:
            archive = Path(temp) / f"{app}.archive.gz"
            source_uri = get_uri(app, args.source, args.source_uri, args.source_store, source_profile)
            target_uri = get_uri(app, args.target, args.target_uri, args.target_store, target_profile)

            log.info("Syncing %s from %s to %s.", app, source_label(args), target_label(args))
            dump(source_uri, archive, source_profile, args.dry_run)
            restore(target_uri, archive, target_profile, args.dry_run)

            if mock_passwords:
                mock_app_passwords(app, target_uri, target_profile, args.mock_password_value, args.dry_run)


def backup_cmd(args: argparse.Namespace) -> None:
    apps = app_list(args.apps)
    source_profile = args.source_profile or args.profile
    backup_dir = args.out or Path("mongo-backups") / time.strftime("%Y%m%d-%H%M%S")

    check_tools()
    if backup_dir.exists() and any(backup_dir.iterdir()):
        raise SyncError(f"Backup directory is not empty: {backup_dir}")
    if not args.dry_run:
        backup_dir.mkdir(parents=True, exist_ok=True)

    log.info("Writing backups to %s.", backup_dir)
    manifest = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "region": REGION,
        "source": args.source,
        "source_store": args.source_store,
        "apps": {},
    }
    for app in apps:
        archive = backup_dir / f"{app}.archive.gz"
        dump(get_uri(app, args.source, args.source_uri, args.source_store, source_profile), archive, source_profile, args.dry_run)
        manifest["apps"][app] = {"archive": archive.name}

    if args.dry_run:
        log.info("Would write %s.", backup_dir / "manifest.json")
    else:
        (backup_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def restore_cmd(args: argparse.Namespace) -> None:
    apps = app_list(args.apps)
    target_profile = args.target_profile or args.profile

    check_tools()
    check_target(args.target, args.allow_prod_target)
    confirm_restore(apps, target_label(args), args.yes, args.dry_run)
    check_local_target(args)

    if args.mock_passwords:
        log.warning("Password mocking is enabled. App user passwords will be set to %s.", args.mock_password_value)

    for app in apps:
        archive = archive_for_app(args.backup_path, app, apps)
        target_uri = get_uri(app, args.target, args.target_uri, args.target_store, target_profile)
        restore(target_uri, archive, target_profile, args.dry_run)
        if args.mock_passwords:
            mock_app_passwords(app, target_uri, target_profile, args.mock_password_value, args.dry_run)


def app_list(raw: Sequence[str]) -> tuple[str, ...]:
    apps = [part.strip().lower() for value in raw for part in value.split(",") if part.strip()]
    unknown = sorted(set(apps) - ALL_APPS)
    if unknown:
        raise SyncError(f"Unknown app(s): {', '.join(unknown)}. Supported apps: {', '.join(sorted(ALL_APPS))}.")
    if not apps:
        raise SyncError("At least one app is required.")
    return tuple(dict.fromkeys(apps))


def endpoint_env(endpoint: str) -> str | None:
    if endpoint.lower() == "local":
        return None
    try:
        return ENVS[endpoint.lower()]
    except KeyError as exc:
        raise SyncError(f"Unknown environment {endpoint}. Use prod/prd, staging/stg, dev, or local.") from exc


def get_uri(app: str, endpoint: str, explicit_uri: str | None, store: str, profile: str | None) -> str:
    if explicit_uri:
        return mongo_uri(explicit_uri)
    if endpoint.lower() == "local":
        return LOCAL_URI

    env = endpoint_env(endpoint)
    assert env is not None

    errors = []
    stores = ("secrets-manager", "legacy-ssm") if store == "auto" else (store,)
    for candidate in stores:
        try:
            if candidate == "secrets-manager":
                return mongo_uri(secret_uri(app, env, profile))
            return mongo_uri(ssm_uri(app, env, profile))
        except SyncError as exc:
            errors.append(f"{candidate}: {exc}")

    raise SyncError(f"Could not resolve MongoDB URI for {env}/{app}. Attempts: {'; '.join(errors)}")


def secret_uri(app: str, env: str, profile: str | None) -> str:
    name = SECRET_NAME.format(env=env, app=app)
    try:
        response = aws(profile).client("secretsmanager").get_secret_value(SecretId=name)
    except botocore.exceptions.BotoCoreError as exc:
        raise SyncError(f"Secrets Manager lookup failed for {name}: {exc}") from exc

    value = response.get("SecretString")
    if value is None and response.get("SecretBinary"):
        value = response["SecretBinary"].decode("utf-8")
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
        value = aws(profile).client("ssm").get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except botocore.exceptions.BotoCoreError as exc:
        raise SyncError(f"SSM lookup failed for {name}: {exc}") from exc
    if not value.startswith("mongodb"):
        raise SyncError(f"SSM parameter {name} is not a MongoDB URI.")
    return value


def aws(profile: str | None) -> boto3.Session:
    try:
        return boto3.Session(profile_name=profile, region_name=REGION) if profile else boto3.Session(region_name=REGION)
    except botocore.exceptions.ProfileNotFound as exc:
        raise SyncError(f"AWS profile not found: {profile}") from exc


def mongo_uri(uri: str) -> str:
    if not uri.startswith(("mongodb://", "mongodb+srv://")):
        raise SyncError("MongoDB URI must start with mongodb:// or mongodb+srv://.")
    if not uri.startswith("mongodb+srv://") or has_credentials(uri) or query_arg(uri, "authMechanism"):
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
            raise SyncError(f"No AWS credentials found for profile {profile or 'default'}.")
        frozen = credentials.get_frozen_credentials()
    except botocore.exceptions.BotoCoreError as exc:
        hint = f" --profile {profile}" if profile else ""
        raise SyncError(f"Could not load AWS credentials. Run `aws sso login{hint}` if using SSO. {exc}") from exc

    old = {key: os.environ.get(key) for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION")}
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


def dump(uri: str, archive: Path, profile: str | None, dry_run: bool) -> None:
    run(["mongodump", f"--uri={uri}", f"--archive={archive}", "--gzip", "--quiet"], uri, profile, dry_run)


def restore(uri: str, archive: Path, profile: str | None, dry_run: bool) -> None:
    if not dry_run and not archive.exists():
        raise SyncError(f"Backup archive does not exist: {archive}")
    run(["mongorestore", f"--uri={uri}", f"--archive={archive}", "--gzip", "--drop", "--quiet"], uri, profile, dry_run)


def run(command: list[str], uri: str, profile: str | None, dry_run: bool) -> None:
    log.info("%s%s", "Would run: " if dry_run else "Running: ", redact_command(command))
    if dry_run:
        return
    with atlas_env(uri, profile):
        try:
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError as exc:
            raise SyncError(f"{command[0]} failed with exit code {exc.returncode}.") from exc


def mock_app_passwords(app: str, uri: str, profile: str | None, password: str, dry_run: bool) -> None:
    if app not in USER_COLLECTIONS:
        return
    db_name, collection_name = USER_COLLECTIONS[app]
    if dry_run:
        log.info("Would update passwords in %s.%s for %s.", db_name, collection_name, app)
        return

    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    with atlas_env(uri, profile):
        client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=5000)
        try:
            result = client[db_name][collection_name].update_many({}, {"$set": {"password": password_hash}})
        except pymongo.errors.PyMongoError as exc:
            raise SyncError(f"Failed to mock passwords for {app}: {exc}") from exc
        finally:
            client.close()
    log.warning("Mocked passwords for %s users in %s.%s.", result.modified_count, db_name, collection_name)


def check_tools() -> None:
    missing = [tool for tool in ("mongodump", "mongorestore") if shutil.which(tool) is None]
    if missing:
        raise SyncError("Missing MongoDB Database Tools: " + ", ".join(missing))


def check_target(target: str, allow_prod: bool) -> None:
    if target.lower() != "local" and endpoint_env(target) == "prd" and not allow_prod:
        raise SyncError("Refusing to restore into prod. Pass --allow-prod-target to override.")


def check_local_target(args: argparse.Namespace) -> None:
    uri = args.target_uri or LOCAL_URI
    if args.target.lower() != "local" and not is_local_uri(uri):
        return
    if args.skip_local_check or args.dry_run:
        log.info("Would ping local MongoDB at %s.", redact_uri(uri))
        return

    client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=3000)
    try:
        client.admin.command("ping")
    except pymongo.errors.PyMongoError as exc:
        raise SyncError(f"Could not connect to local MongoDB at {redact_uri(uri)}.") from exc
    finally:
        client.close()


def confirm_restore(apps: Sequence[str], target: str, yes: bool, dry_run: bool) -> None:
    log.warning("Restore uses mongorestore --drop for app(s) %s into %s.", ", ".join(apps), target)
    if dry_run or yes:
        return
    if not sys.stdin.isatty():
        raise SyncError("Restore confirmation requires a TTY. Pass --yes to skip it.")
    if input("Type 'restore' to continue: ").strip() != "restore":
        raise SyncError("Restore cancelled.")


def archive_for_app(path: Path, app: str, apps: Sequence[str]) -> Path:
    if path.is_file():
        if len(apps) != 1:
            raise SyncError("--from can be a file only when restoring one app.")
        return path
    return path / f"{app}.archive.gz"


def target_is_nonprod(args: argparse.Namespace) -> bool:
    return args.target.lower() == "local" or endpoint_env(args.target) != "prd"


def source_label(args: argparse.Namespace) -> str:
    return redact_uri(args.source_uri) if args.source_uri else args.source


def target_label(args: argparse.Namespace) -> str:
    return redact_uri(args.target_uri) if args.target_uri else args.target


def is_local_uri(uri: str) -> bool:
    return bool(re.match(r"^mongodb://(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:/|\?|$)", uri))


def redact_command(command: Sequence[str]) -> str:
    return shlex.join(["--uri=" + redact_uri(arg[6:]) if arg.startswith("--uri=") else arg for arg in command])


def redact_uri(uri: str | None) -> str:
    if not uri:
        return ""
    return re.sub(r"(mongodb(?:\+srv)?://)([^/@]+)@", r"\1***@", uri)


if __name__ == "__main__":
    raise SystemExit(main())
