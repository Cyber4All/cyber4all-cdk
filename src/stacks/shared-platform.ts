import { RemovalPolicy, SecretValue, Stack, StackProps } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { CoralogixOtelCollectorDaemon } from "../constructs/coralogix-otel-collector-daemon";
import { EcsCluster } from "../constructs/ecs-cluster";
import { SharedAlb } from "../constructs/shared-alb";
import { Environment } from "../shared/types";

export interface SharedPlatformStackProps extends StackProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
    readonly albDomainNames: string[];
}

export class SharedPlatformStack extends Stack {
    public readonly cluster: EcsCluster;
    public readonly sharedAlb: SharedAlb;

    public readonly dockerHubSecret: ISecret;
    public readonly googleSecret: ISecret;
    public readonly sendGridSecret: ISecret;
    public readonly shortcutSecret: ISecret;
    public readonly slackSecret: ISecret;

    constructor(scope: Construct, id: string, props: SharedPlatformStackProps) {
        super(scope, id, props);

        this.cluster = new EcsCluster(this, "EcsCluster", {
            environment: props.environment,
            vpc: props.vpc,
        });

        this.sharedAlb = new SharedAlb(this, "SharedAlb", {
            environment: props.environment,
            vpc: props.vpc,
            albDomainNames: props.albDomainNames,
        });

        this.cluster.allowIngressFromSharedAlb(this.sharedAlb.loadBalancer);

        // Create secrets in Secrets Manager for the following 3rd party services
        const secretBaseName = `/${props.environment}/cyber4all`;
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
                SHORTCUT_API_TOKEN: SecretValue.unsafePlainText("placeholder"),
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

        new CoralogixOtelCollectorDaemon(this, "CoralogixOtelCollector", {
            cluster: this.cluster,
            environment: props.environment,
        });
    }
}
