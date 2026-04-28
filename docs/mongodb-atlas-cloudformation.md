# MongoDB Atlas CloudFormation Setup

Use this guide before deploying CDK stacks that use the MongoDB Atlas CloudFormation resource provider.

CloudFormation public extensions are enabled per AWS account and region. Secrets Manager secrets are also regional, so create the profile secret in the same account and region where the CDK stack will run.

## Resources Used By This Repo

The current CDK codebase uses these MongoDB Atlas CloudFormation resource types:

- `MongoDB::Atlas::Project`
- `MongoDB::Atlas::Cluster`
- `MongoDB::Atlas::FlexCluster`

If another `Cfn*` resource from `awscdk-resources-mongodbatlas` is added later, activate the matching `MongoDB::Atlas::*` public extension before deploying it.

## Create The Atlas Profile Secret

Create an API key in MongoDB Atlas with permissions for the resources the stack will manage. For the current codebase, that means enough access to create and update Atlas projects and clusters in the target organization.

When Atlas shows the API key, copy both values:

- Public key
- Private key

Do not store the real key values in source control, tickets, or docs.

In AWS Secrets Manager, create a secret for the Atlas CloudFormation profile. This repo uses the default Atlas profile unless a stack passes a different `profile` value.

Default profile secret name:

```text
cfn/atlas/profile/default
```

For a non-default profile, use:

```text
cfn/atlas/profile/<profile>
```

Secret value:

```json
{
  "PublicKey": "<atlas-public-key>",
  "PrivateKey": "<atlas-private-key>"
}
```

The `PublicKey` and `PrivateKey` key names are case-sensitive.

Add these tags to the secret for tracking:

| Key | Value |
| --- | --- |
| `environment` | `<environment>` |
| `managed-by` | `manual` |
| `application` | `shared` |

Example AWS CLI shape:

```sh
aws secretsmanager create-secret \
  --name cfn/atlas/profile/default \
  --secret-string '{"PublicKey":"<atlas-public-key>","PrivateKey":"<atlas-private-key>"}' \
  --tags Key=environment,Value=staging Key=managed-by,Value=manual Key=application,Value=shared
```

## Activate The CloudFormation Extensions

In the AWS Console:

1. Open CloudFormation.
2. Go to Public extensions.
3. Search for `MongoDB::Atlas`.
4. Activate each resource type used by this repo.
5. For each activation, specify an IAM execution role.

Activate these extensions:

- `MongoDB::Atlas::Project`
- `MongoDB::Atlas::Cluster`
- `MongoDB::Atlas::FlexCluster`

The least-privilege execution role should be limited to reading the Atlas profile secret from Secrets Manager.

The execution role trust policy must allow CloudFormation public extensions to assume it. Add this statement to the role trust policy:

```json
{
  "Effect": "Allow",
  "Principal": {
    "Service": "resources.cloudformation.amazonaws.com"
  },
  "Action": "sts:AssumeRole"
}
```

Example policy scope for the default staging profile in `us-east-1`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:317620868823:secret:cfn/atlas/profile/default-*"
    }
  ]
}
```

For staging, the CDK bootstrap CloudFormation execution role was used instead:

```text
arn:aws:iam::317620868823:role/cdk-hnb659fds-cfn-exec-role-317620868823-us-east-1
```

That role is broader than the provider needs, but it is already present in the CDK-bootstrapped account.

When using that CDK bootstrap role, add the `resources.cloudformation.amazonaws.com` trust-policy statement above without removing the existing CDK trust relationships.

## Atlas Tags

MongoDB Atlas validates tag characters more strictly than AWS. Tag keys and values can use letters, numbers, spaces, semi-colons, `@`, underscores, dashes, periods, plus signs, and colons. They cannot include `/`.

For example, use a slash-free repository tag value such as:

```text
github.com:cyber4all:cyber4all-cdk
```

Do not use:

```text
https://github.com/cyber4all/cyber4all-cdk
```

## Pre-Deploy Checklist

- The Atlas API key exists and has the needed Atlas permissions.
- The Secrets Manager secret exists in the target AWS account and region.
- The secret name matches the CDK `profile` value, for example `default` maps to `cfn/atlas/profile/default`.
- The secret JSON uses `PublicKey` and `PrivateKey`.
- The secret has the tracking tags listed above.
- Every `MongoDB::Atlas::*` CloudFormation resource type used by the CDK code has been activated.
- Each activated extension uses an execution role that can read the Atlas profile secret.
- The extension execution role trusts `resources.cloudformation.amazonaws.com`.
- Atlas tag values do not contain `/`.

## Troubleshooting

- `Profile not found`: check the secret name, AWS region, AWS account, and `profile` property.
- `AccessDeniedException` reading Secrets Manager: check the CloudFormation extension execution role.
- Role assume errors during extension activation or deployment: check that the execution role trusts `resources.cloudformation.amazonaws.com`.
- Atlas authorization errors: check the API key permissions in MongoDB Atlas.
- Atlas `INVALID_PARAMETER` tag errors: remove unsupported characters such as `/` from Atlas tag keys and values.
- CloudFormation does not recognize a MongoDB resource type: activate the matching public extension in the target account and region.
