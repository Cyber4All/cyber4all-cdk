import { RemovalPolicy, SecretValue, Stack, StackProps } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as fs from "node:fs";
import * as path from "node:path";
import { EcsCluster } from "../constructs/ecs-cluster";
import { SharedAlb } from "../constructs/shared-alb";
import {
    CORALOGIX_FARGATE_OTEL_CONFIG_ASSET_PATH,
    CORALOGIX_FARGATE_OTEL_CONFIG_OBJECT_KEY,
} from "../shared/coralogix";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";

export interface SharedPlatformStackProps extends StackProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
    readonly albDomainNames: string[];
}

export class SharedPlatformStack extends Stack {
    public readonly cluster: EcsCluster;
    public readonly sharedAlb: SharedAlb;
    public readonly coralogixSecret: ISecret;
    public readonly dockerHubSecret: ISecret;
    public readonly googleSecret: ISecret;
    public readonly sendGridSecret: ISecret;
    public readonly shortcutSecret: ISecret;
    public readonly slackSecret: ISecret;
    public readonly otelConfigBucket: IBucket;
    public readonly otelConfigObjectKey: string;
    public readonly otelConfigS3Url: string;

    constructor(scope: Construct, id: string, props: SharedPlatformStackProps) {
        super(scope, id, props);

        const resourceBaseName = `${props.environment}-cyber4all`;
        const regionShortName = getRegionShortName(Stack.of(this).region);
        const uniqueSuffix = this.node.addr.substring(0, 8);

        this.cluster = new EcsCluster(this, "EcsCluster", {
            environment: props.environment,
            vpc: props.vpc,
        });

        this.sharedAlb = new SharedAlb(this, "SharedAlb", {
            environment: props.environment,
            vpc: props.vpc,
            albDomainNames: props.albDomainNames,
        });

        // Create secrets in Secrets Manager for the following 3rd party services
        const secretBaseName = `/${props.environment}/cyber4all`;
        // Preserve the old construct path so the existing named secret updates in place.
        const coralogixScope = new Construct(this, "CoralogixOtelCollector");
        this.coralogixSecret = new Secret(coralogixScope, "CoralogixPrivateKeySecret", {
            secretName: `${secretBaseName}/coralogix`,
            description: "Coralogix API credentials for telemetry export. Must contain a PRIVATE_KEY field.",
            secretObjectValue: {
                PRIVATE_KEY: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY,
        });
        this.dockerHubSecret = new Secret(this, "DockerHubSecret", {
            secretName: `${secretBaseName}/dockerhub`,
            description: "Docker Hub credentials for pulling private container images. Should contain 'username' and 'password' fields.",
            secretObjectValue: {
                username: SecretValue.unsafePlainText("placeholder"),
                password: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.googleSecret = new Secret(this, "GoogleSecret", {
            secretName: `${secretBaseName}/google`,
            description: "Google credentials for SSO integration.",
            secretObjectValue: {
                GOOGLE_CLIENT_ID: SecretValue.unsafePlainText("placeholder"),
                GOOGLE_CLIENT_SECRET: SecretValue.unsafePlainText("placeholder"),
                GOOGLE_PRIVATE_KEY: SecretValue.unsafePlainText("placeholder"),
                GOOGLE_SERVICE_ACCOUNT_EMAIL: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.sendGridSecret = new Secret(this, "SendGridSecret", {
            secretName: `${secretBaseName}/sendgrid`,
            description: "SendGrid API credentials.",
            secretObjectValue: {
                SENDGRID_API_KEY: SecretValue.unsafePlainText("placeholder"),
                SENDGRID_VERIFIED_USER_API_KEY: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.shortcutSecret = new Secret(this, "ShortcutSecret", {
            secretName: `${secretBaseName}/shortcut`,
            description: "Shortcut API credentials for project and task management integration.",
            secretObjectValue: {
                SHORTCUT_API_KEY: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.slackSecret = new Secret(this, "SlackSecret", {
            secretName: `${secretBaseName}/slack`,
            description: "Slack integration secrets (SLACK_TOKEN, SLACK_URI).",
            secretObjectValue: {
                SLACK_TOKEN: SecretValue.unsafePlainText("placeholder"),
                SLACK_URI: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY
        });

        this.otelConfigObjectKey = CORALOGIX_FARGATE_OTEL_CONFIG_OBJECT_KEY;
        this.otelConfigBucket = new Bucket(this, "FargateOtelConfigBucket", {
            bucketName: `${resourceBaseName}-otel-config-${regionShortName}-${uniqueSuffix}`,
            enforceSSL: true,
            autoDeleteObjects: true,
            removalPolicy: RemovalPolicy.DESTROY,
        });
        this.otelConfigS3Url = `s3://${this.otelConfigBucket.bucketName}.s3.${this.region}.amazonaws.com/${this.otelConfigObjectKey}`;

        new BucketDeployment(this, "FargateOtelConfigDeployment", {
            destinationBucket: this.otelConfigBucket,
            sources: [
                Source.data(
                    this.otelConfigObjectKey,
                    fs.readFileSync(path.join(__dirname, "../..", CORALOGIX_FARGATE_OTEL_CONFIG_ASSET_PATH), "utf8"),
                ),
            ],
            retainOnDelete: false,
        });
    }
}
