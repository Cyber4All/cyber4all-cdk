import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { Cluster } from "aws-cdk-lib/aws-ecs";
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
    public readonly cluster: Cluster;
    public readonly sharedAlb: SharedAlb;

    public readonly dockerHubSecret: ISecret;
    public readonly googleSecret: ISecret;
    public readonly sendGridSecret: ISecret;
    public readonly shortcutSecret: ISecret;
    public readonly slackSecret: ISecret;

    constructor(scope: Construct, id: string, props: SharedPlatformStackProps) {
        super(scope, id, props);

        const ecsCluster = new EcsCluster(this, "EcsCluster", {
            environment: props.environment,
            vpc: props.vpc,
        });
        this.cluster = ecsCluster.cluster;

        this.sharedAlb = new SharedAlb(this, "SharedAlb", {
            environment: props.environment,
            vpc: props.vpc,
            albDomainNames: props.albDomainNames,
        });

        ecsCluster.allowIngressFromSharedAlb(this.sharedAlb.loadBalancer);

        // Create secrets in Secrets Manager for the following 3rd party services
        const secretBaseName = `/${props.environment}/cyber4all`;
        this.dockerHubSecret = new Secret(this, "DockerHubSecret", {
            secretName: `${secretBaseName}/dockerhub`,
            description: "Docker Hub credentials for pulling private container images. Should contain 'username' and 'password' fields.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.googleSecret = new Secret(this, "GoogleSecret", {
            secretName: `${secretBaseName}/google`,
            description: "Google credentials for SSO integration.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.sendGridSecret = new Secret(this, "SendGridSecret", {
            secretName: `${secretBaseName}/sendgrid`,
            description: "SendGrid API credentials.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.shortcutSecret = new Secret(this, "ShortcutSecret", {
            secretName: `${secretBaseName}/shortcut`,
            description: "Shortcut API credentials for project and task management integration.",
            removalPolicy: RemovalPolicy.DESTROY
        });

        this.slackSecret = new Secret(this, "SlackSecret", {
            secretName: `${secretBaseName}/slack`,
            description: "Slack integration secrets (SLACK_TOKEN, SLACK_URI).",
            removalPolicy: RemovalPolicy.DESTROY
        });

        new CoralogixOtelCollectorDaemon(this, "CoralogixOtelCollector", {
            cluster: this.cluster,
            environment: props.environment,
            coralogixDomain: "coralogix.us",
        });
    }
}
