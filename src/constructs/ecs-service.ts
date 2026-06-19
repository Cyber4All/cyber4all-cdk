import { RemovalPolicy, Stack, Tags, TimeZone, ValidationError } from "aws-cdk-lib";
import { Schedule } from "aws-cdk-lib/aws-applicationautoscaling";
import { IVpc, Peer, Port, SecurityGroup, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
    AwsLogDriver,
    ContainerImage,
    Secret as EcsSecret,
    FargatePlatformVersion,
    FargateService,
    FargateTaskDefinition,
    ICluster
} from "aws-cdk-lib/aws-ecs";
import {
    ApplicationListenerRule,
    ApplicationProtocol,
    ApplicationTargetGroup,
    ListenerCondition,
    TargetType
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { LoadBalancerTarget } from "aws-cdk-lib/aws-route53-targets";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { CfnDatabaseUser, CfnDatabaseUserPropsAwsiamType } from "awscdk-resources-mongodbatlas";
import { Construct } from "constructs";
import { getHttpsListener, nextListenerRulePriority } from "../shared/alb";
import { getImageName, getRecordName, getRegionShortName } from "../shared/names";
import { NAME_TAG } from "../shared/tags";
import { Application, Environment, getEnvironmentName } from "../shared/types";
import { MongoDBCluster } from "./mongodb-cluster";
import { addOtelSidecar, getOtelEnvironment } from "./otel-sidecar";
import { SharedAlb } from "./shared-alb";

/**
 * Optional container-level settings for an ECS service or event-driven ECS task.
 */
export interface ContainerOptions {
    /** Plaintext environment variables passed to the container. */
    readonly environment?: Record<string, string>;

    /** Secrets exposed to the container as environment variables. */
    readonly secrets?: Record<string, EcsSecret>;

    /** Soft memory reservation for the container. Defaults to 256 MiB. */
    readonly memoryReservationMiB?: number;

    /** Hard memory limit for the container. Defaults to the task memory limit. */
    readonly memoryLimitMiB?: number;

    /** CPU units reserved for the container. Defaults to 256. */
    readonly cpu?: number;
}

/**
 * Shared ALB routing configuration for services that should receive public traffic.
 */
export interface AlbRoutingOptions {
    /** Shared load balancer that fronts the ECS service. Must include a 443 HTTPS listener. */
    readonly loadBalancer: SharedAlb;

    /** Fully qualified host name routed to this service. */
    readonly hostName: string;
}

/** Options for configuring the OTEL sidecar. */
export interface OtelSidecarOptions {
    /** The name of the application, used in OTEL attributes. */
    readonly applicationName: Application;

    /** Coralogix secret used by the OTEL sidecar. Must contain a PRIVATE_KEY field. */
    readonly coralogixSecret: ISecret;

    /** S3 bucket containing the OTEL collector YAML for Fargate sidecars. */
    readonly otelConfigBucket: IBucket;

    /** S3 URL passed to the OTEL collector sidecar as its config source. */
    readonly otelConfigS3Url: string;
}

/**
 * Properties for a long-running ECS service backed by Fargate.
 */
export interface EcsServiceProps {
    /** Deployment environment used in generated resource names. */
    readonly environment: Environment;

    /** Container image repository, optionally with a tag, such as cyber4all/service:staging. */
    readonly imageRepository: string;

    /** Secrets Manager secret containing Docker registry credentials. */
    readonly dockerCredentials: ISecret;

    /** ECS cluster where the service is deployed. */
    readonly cluster: ICluster;

    /** Desired number of running service tasks. Defaults to 1. */
    readonly desiredCount?: number;

    /** Optional container settings. */
    readonly containerOptions?: ContainerOptions;

    /** Optional ALB routing for public services. Omit for VPC-only services. */
    readonly albRouting?: AlbRoutingOptions;

    /** Optional MongoDB cluster to which the service has access. */
    readonly mongoCluster?: MongoDBCluster;

    /** Optional whether to enable execute command. Default is false. */
    readonly enableExecuteCommand?: boolean;

    /** Options for configuring the OTEL sidecar. */
    readonly otelSidecarOptions?: OtelSidecarOptions;

    /** Fargate task CPU units. Defaults to 512. */
    readonly taskCpu?: number;

    /** Fargate task memory in MiB. Defaults to 1024. */
    readonly taskMemoryLimitMiB?: number;
}

export class EcsService extends Construct {
    public readonly taskDefinition: FargateTaskDefinition;
    public readonly service: FargateService;
    public readonly serviceName: string;

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: EcsServiceProps) {
        super(scope, id);

        this.baseName = `${props.environment}`;
        this.regionShortName = getRegionShortName(Stack.of(this).region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);

        const imageName = getImageName(props.imageRepository, this);
        // Public serviceName exposed to other constructs should match the Service Connect DNS
        // (e.g. stg-clark-service-use1) so other services can resolve it via short name.
        this.serviceName = `${this.baseName}-${imageName}-${this.regionShortName}`;
        const resourceName = `${this.baseName}-${imageName}-${this.regionShortName}-${this.uniqueSuffix}`;
        const containerPort = 3000;

        const executionRole = new Role(this, "ExecutionRole", {
            roleName: `${this.baseName}-${imageName}-execution-role-${this.regionShortName}-${this.uniqueSuffix}`,
            assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
        });
        executionRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"));
        Object.values(props.containerOptions?.secrets ?? {}).forEach((secret) => {
            secret.grantRead(executionRole);
        });

        const taskRoleName = `${this.baseName}-${imageName}-task-role-${this.regionShortName}-${this.uniqueSuffix}`;
        const taskRole = new Role(this, "TaskRole", {
            roleName: taskRoleName,
            assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
        });

        this.taskDefinition = new FargateTaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            cpu: props.taskCpu ?? 512,
            memoryLimitMiB: props.taskMemoryLimitMiB ?? 1024,
            taskRole,
            executionRole,
        });

        const logDriver = new AwsLogDriver({
            streamPrefix: this.serviceName,
            logGroup: new LogGroup(this, "LogGroup", {
                logGroupName: `/ecs/service/${resourceName}`,
                retention: RetentionDays.ONE_WEEK,
                removalPolicy: RemovalPolicy.DESTROY,
            }),
        });

        let otelEnvironment = {};
        if (props.otelSidecarOptions) {
            const { applicationName, coralogixSecret, otelConfigBucket, otelConfigS3Url } = props.otelSidecarOptions;

            otelEnvironment = getOtelEnvironment({
                applicationName: `${applicationName}-${getEnvironmentName(props.environment)}`,
                subsystemName: this.serviceName,
            });

            addOtelSidecar(this.taskDefinition, { coralogixSecret, otelConfigBucket, otelConfigS3Url });
        }

        const containerEnvironment = {
            ...otelEnvironment,
            ...props.containerOptions?.environment,
        };

        const container = this.taskDefinition.addContainer("Container", {
            containerName: imageName,
            image: ContainerImage.fromRegistry(props.imageRepository, {
                credentials: props.dockerCredentials,
            }),
            essential: true,
            environment: containerEnvironment,
            secrets: props.containerOptions?.secrets,
            cpu: props.containerOptions?.cpu ?? 0,
            memoryReservationMiB: props.containerOptions?.memoryReservationMiB,
            memoryLimitMiB: props.containerOptions?.memoryLimitMiB,
            logging: logDriver,
        });
        container.addPortMappings({
            containerPort,
            name: imageName,
        });

        const securityGroupName = `${this.baseName}-${this.serviceName}-sg-${this.regionShortName}-${this.uniqueSuffix}`;
        const securityGroup = new SecurityGroup(this, "SecurityGroup", {
            vpc: props.cluster.vpc,
            securityGroupName: securityGroupName,
            description: `Security group for ${this.serviceName} Fargate service`,
            allowAllOutbound: true,
        });
        Tags.of(securityGroup).add(NAME_TAG, securityGroupName);
        // Allow ingress from VPC to container port
        securityGroup.addIngressRule(
            Peer.ipv4(props.cluster.vpc.vpcCidrBlock),
            Port.tcp(containerPort),
            "Allow inbound traffic from VPC",
        );

        this.service = new FargateService(this, "Service", {
            cluster: props.cluster,
            taskDefinition: this.taskDefinition,
            desiredCount: props.desiredCount ?? 1,
            enableExecuteCommand: props.enableExecuteCommand,
            serviceName: resourceName,
            enableECSManagedTags: true,
            securityGroups: [securityGroup],
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
            platformVersion: FargatePlatformVersion.LATEST,
            serviceConnectConfiguration: {
                services: [
                    {
                        portMappingName: imageName,
                        dnsName: this.serviceName,
                        port: containerPort,
                    },
                ],
            },
        });

        const scaling = this.service.autoScaleTaskCount({
            minCapacity: props.environment === Environment.STAGING ? 0 : 1,
            maxCapacity: 3,
        });
        scaling.scaleOnMemoryUtilization("MemoryScaling", {
            targetUtilizationPercent: 75,
        });

        if (props.environment === Environment.STAGING) {
            scaling.scaleOnSchedule("ScaleUpDuringWorkHours", {
                schedule: Schedule.cron({ minute: "0", hour: "9", weekDay: "MON-FRI" }),
                minCapacity: 1,
                maxCapacity: 3,
                timeZone: TimeZone.AMERICA_NEW_YORK,
            });
            scaling.scaleOnSchedule("ScaleDownOutsideWorkHours", {
                schedule: Schedule.cron({ minute: "0", hour: "17", weekDay: "MON-FRI" }),
                minCapacity: 0,
                maxCapacity: 0,
                timeZone: TimeZone.AMERICA_NEW_YORK,
            });
        }

        if (props.albRouting) {
            this.configureAlbRouting(props.cluster.vpc, props.albRouting, imageName, containerPort);
        }

        if (props.mongoCluster) {
            this.configureMongoDbAccess(props.mongoCluster, taskRoleName);
        }
    }

    private configureAlbRouting(
        vpc: IVpc,
        albRoutingOptions: AlbRoutingOptions,
        containerName: string,
        containerPort: number,
    ): void {
        const { hostName, loadBalancer } = albRoutingOptions;

        // Get the hosted zone for the specified host name by finding a hosted zone whose domain name is a suffix of the host name
        const hostedZone = Object.values(loadBalancer.hostedZones).find((zone) => hostName.endsWith(zone.zoneName));
        if (!hostedZone) {
            throw new ValidationError(lit`HostedZone`, `No hosted zone found for host name ${albRoutingOptions.hostName}`, this);
        }

        const targetGroup = new ApplicationTargetGroup(this, "TargetGroup", {
            targetGroupName: `${this.baseName}-${containerName}-${this.uniqueSuffix}`,
            vpc: vpc,
            protocol: ApplicationProtocol.HTTP,
            port: containerPort,
            targetType: TargetType.IP,
            targets: [
                this.service.loadBalancerTarget({ containerName, containerPort }),
            ],
        });

        const listener = getHttpsListener(this, loadBalancer.loadBalancer);
        new ApplicationListenerRule(this, "HostRule", {
            listener,
            priority: nextListenerRulePriority(listener),
            conditions: [ListenerCondition.hostHeaders([albRoutingOptions.hostName])],
            targetGroups: [targetGroup],
        });

        new ARecord(this, "AliasRecord", {
            zone: hostedZone,
            recordName: getRecordName(albRoutingOptions.hostName, hostedZone.zoneName),
            target: RecordTarget.fromAlias(new LoadBalancerTarget(loadBalancer.loadBalancer)),
        });

    }

    private configureMongoDbAccess(mongoCluster: MongoDBCluster, taskRoleName: string): void {
        const taskRoleArn = `arn:aws:iam::${Stack.of(this).account}:role/${taskRoleName}`;

        new CfnDatabaseUser(this, "MongoIamDbUser", {
            projectId: mongoCluster.projectId,
            username: taskRoleArn,
            databaseName: "$external",
            awsiamType: CfnDatabaseUserPropsAwsiamType.ROLE,
            // TODO: Use more fine-grained permissions for the roles
            roles: [
                {
                    roleName: "readWriteAnyDatabase",
                    databaseName: "admin",
                },
            ],
        });
    }
}
