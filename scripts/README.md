# MongoDB Sync Script

The supported entry point is the interactive Python script:

```bash
uv run scripts/mongo_sync.py
```

The script is intentionally narrow. It backs up prod, restores that fresh
backup to staging or local, and always mocks app user passwords after
`mongorestore`.

The prompts are:

- Whether prod uses legacy SSM connection strings or current Secrets Manager
  connection strings.
- Which apps to back up and restore: `clark`, `competency`, or both.
- Whether to restore the prod backup to staging or local.
- For staging restores, whether staging uses legacy SSM connection strings or
  current Secrets Manager connection strings.

Connection strings are fixed by workflow:

```text
legacy prod source:  /prod/{app}/mongo/connection-string in cyber4all-dev account 842676000360
current prod source: /cyber4all/mongodb/prd-cyber4all-{app}-cluster-use1/connection
legacy staging:      /staging/{app}/mongo/connection-string in cyber4all-dev account 842676000360
current staging:     /cyber4all/mongodb/stg-cyber4all-{app}-cluster-use1/connection
local target:        mongodb://localhost:27017
```

Secrets Manager connection secrets are expected to be JSON and the script reads
the `MONGODB_URI` field.

Each run writes archives and MongoDB tool logs to `mongo-backups/<timestamp>`:

```text
clark.archive.gz
clark.mongodump.log
clark.mongorestore.staging.log
competency.archive.gz
competency.mongodump.log
competency.mongorestore.staging.log
manifest.json
```

Restores exclude `config.*` namespaces because Atlas does not allow this role to
create collections in the internal `config` database, and those namespaces are
not application data.

## AWS Profiles And Access

Legacy SSM parameters live in the cyber4all-dev account `842676000360`. The
script reads `~/.aws/config` and chooses a profile for that account
automatically whenever a legacy prod or staging connection string is selected.

The script also reads `~/.aws/config` to find the prod and staging SSO profiles
matching the Atlas IAM database users below. For current staging restores, the
staging profile reads the new Secrets Manager connection string. For all
staging restores, it authenticates to MongoDB when the URI uses `MONGODB-AWS`.

The script verifies the selected MongoDB auth profiles with STS before running:

```text
prod MongoDB auth:
arn:aws:iam::194683060534:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AWSDeveloperAccess_a4ce2d7d5ed4adfc

staging MongoDB auth:
arn:aws:iam::317620868823:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AWSDeveloperAccess_6653ddc859367089
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

Restores use `mongorestore --drop`, so the script asks you to type `restore`
before a non-dry-run restore starts. There is no prod restore path in this
script.
