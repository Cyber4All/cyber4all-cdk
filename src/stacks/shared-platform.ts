import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { InstanceClass, InstanceSize, InstanceType, IVpc } from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerInsights, EcsOptimizedImage, ICluster } from "aws-cdk-lib/aws-ecs";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";

export interface SharedPlatformStackProps extends StackProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
}

export class SharedPlatformStack extends Stack {
    public readonly cluster: ICluster;

    public readonly dockerHubSecret: ISecret;
    public readonly googleSecret: ISecret;
    public readonly sendGridSecret: ISecret;
    public readonly shortcutSecret: ISecret;
    public readonly coralogixSecret: ISecret;

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: SharedPlatformStackProps) {
        super(scope, id, props);

        this.baseName = `${props?.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(this.region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);

        this.cluster = new Cluster(this, "EcsCluster", {
            clusterName: `${this.baseName}-cluster-${this.regionShortName}-${this.uniqueSuffix}`,
            vpc: props.vpc,
            capacity: {
                autoScalingGroupName: `${this.baseName}-asg-${this.regionShortName}-${this.uniqueSuffix}`,
                instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
                machineImage: EcsOptimizedImage.amazonLinux2023(),
                maxCapacity: 3,
                ssmSessionPermissions: true
            },
            defaultCloudMapNamespace: {
                name: `${this.baseName}-namespace-${this.regionShortName}-${this.uniqueSuffix}`,
                useForServiceConnect: true
            },
            containerInsightsV2: ContainerInsights.ENABLED
        });

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
        this.coralogixSecret = new Secret(this, "CoralogixSecret", {
            secretName: `${secretBaseName}/coralogix`,
            description: "Coralogix API credentials for log aggregation and analysis.",
            removalPolicy: RemovalPolicy.DESTROY
        });

    }
}
