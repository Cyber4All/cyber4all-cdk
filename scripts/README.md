# MongoDB Sync Scripts

The supported entry point is the Python CLI:

```bash
uv run scripts/mongo_sync.py --help
```

Common migrations:

```bash
# Legacy prod SSM connection strings to new staging Secrets Manager clusters.
uv run scripts/mongo_sync.py sync \
  --source prod \
  --target staging \
  --source-store legacy-ssm \
  --target-store secrets-manager \
  --apps clark competency

# Prod to local MongoDB. Password mocking is enabled automatically for prod -> local.
uv run scripts/mongo_sync.py sync \
  --source prod \
  --target local \
  --source-store legacy-ssm \
  --apps clark competency

# Backup only.
uv run scripts/mongo_sync.py backup \
  --source prod \
  --source-store legacy-ssm \
  --apps clark competency

# Restore from a backup directory to staging.
uv run scripts/mongo_sync.py restore \
  --from mongo-backups/20260605-120000 \
  --target staging \
  --target-store secrets-manager \
  --apps clark competency \
  --mock-passwords
```

`--source-store auto` and `--target-store auto` try the CDK-created Secrets
Manager secret first, then fall back to the legacy SSM path:

```text
/cyber4all/mongodb/{env}-cyber4all-{app}-cluster-{region_short}/connection
/{legacy_env}/{app}/mongo/connection-string
```

These scripts only support `us-east-1`; the CDK Secrets Manager path uses
`use1` as the region suffix. CDK-created secrets are expected to be JSON and
the script reads the `MONGODB_URI` field.

## AWS Profiles And Access

Use `-p` or `--profile` to choose the AWS CLI profile for both source and
target access:

```bash
uv run scripts/mongo_sync.py sync \
  --source prod \
  --target staging \
  --profile cyber4all-admin
```

Use `--source-profile` and `--target-profile` when the source and target are
in different AWS accounts or need different roles:

```bash
uv run scripts/mongo_sync.py sync \
  --source prod \
  --target staging \
  --source-profile cyber4all-prod \
  --target-profile cyber4all-staging
```

The script does not keep its own allowlist of profile names. A profile is
allowed only by the permissions behind that AWS profile:

- It must be able to read the selected connection-string source:
  `secretsmanager:GetSecretValue` for CDK-created secrets or
  `ssm:GetParameter` for legacy SSM parameters.
- If the parameter or secret uses a customer-managed KMS key, it also needs
  permission to decrypt that value.
- For Atlas URIs using `MONGODB-AWS`, MongoDB Atlas must have a database user
  configured for the IAM principal behind that profile. Source profiles need
  read/backup access; target profiles need restore/write/drop access.

To stop a profile from being usable, remove either its AWS read/decrypt access
to the connection string or its matching MongoDB Atlas IAM database user/roles.

Restores use `mongorestore --drop`, so the CLI asks for confirmation unless
`--yes` is passed. Restoring into `prod` is blocked unless
`--allow-prod-target` is also passed.
