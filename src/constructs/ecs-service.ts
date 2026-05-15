import { RemovalPolicy, Stack, TimeZone, ValidationError } from "aws-cdk-lib";
import { Schedule } from "aws-cdk-lib/aws-applicationautoscaling";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import {
    AppProtocol,
    AwsLogDriver,
    CapacityProviderStrategy,
    ContainerImage,
    Ec2Service,
    Ec2TaskDefinition,
    Secret as EcsSecret,
    ICluster,
} from "aws-cdk-lib/aws-ecs";
import {
    ApplicationListenerRule,
    ApplicationProtocol,
    ApplicationTargetGroup,
    ListenerCondition,
    TargetType
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { LoadBalancerTarget } from "aws-cdk-lib/aws-route53-targets";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";
import { getHttpsListener, nextListenerRulePriority } from "../shared/alb";
import { EPHEMERAL_PORT_RANGE } from "../shared/ecs";
import { getImageName, getRecordName, getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";
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

/**
 * Properties for a long-running EC2-backed ECS service.
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

    /** ECS capacity provider strategies. */
    readonly capacityProviderStrategies?: CapacityProviderStrategy[];

    /** Desired number of running service tasks. Defaults to 1. */
    readonly desiredCount?: number;

    /** Optional container settings. */
    readonly containerOptions?: ContainerOptions;

    /** Optional ALB routing for public services. Omit for VPC-only services. */
    readonly albRouting?: AlbRoutingOptions;
}

export class EcsService extends Construct {
    public readonly taskDefinition: Ec2TaskDefinition;
    public readonly service: Ec2Service;
    public readonly serviceName: string;

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: EcsServiceProps) {
        super(scope, id);

        this.baseName = `${props.environment}`;
        this.regionShortName = getRegionShortName(Stack.of(this).region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);

        this.serviceName = getImageName(props.imageRepository, this);
        const resourceName = `${this.baseName}-${this.serviceName}-${this.regionShortName}-${this.uniqueSuffix}`;
        const containerPort = 3000;

        this.taskDefinition = new Ec2TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
        });

        const logDriver = new AwsLogDriver({
            streamPrefix: this.serviceName,
            logGroup: new LogGroup(this, "LogGroup", {
                logGroupName: `/ecs/service/${resourceName}`,
                retention: RetentionDays.ONE_WEEK,
                removalPolicy: RemovalPolicy.DESTROY,
            }),
        });

        const container = this.taskDefinition.addContainer("Container", {
            containerName: this.serviceName,
            image: ContainerImage.fromRegistry(props.imageRepository, {
                credentials: props.dockerCredentials,
            }),
            environment: props.containerOptions?.environment,
            secrets: props.containerOptions?.secrets,
            cpu: props.containerOptions?.cpu ?? 256,
            memoryReservationMiB: props.containerOptions?.memoryReservationMiB ?? 256,
            memoryLimitMiB: props.containerOptions?.memoryReservationMiB ? props.containerOptions?.memoryReservationMiB + 1024 : 1024,
            logging: logDriver,
        });

        container.addPortMappings({
            containerPort,
            name: this.serviceName,
            appProtocol: AppProtocol.http,
        });

        this.service = new Ec2Service(this, "Service", {
            cluster: props.cluster,
            taskDefinition: this.taskDefinition,
            desiredCount: props.desiredCount ?? 1,
            serviceName: resourceName,
            enableECSManagedTags: true,
            capacityProviderStrategies: props.capacityProviderStrategies,
            serviceConnectConfiguration: {
                services: [
                    {
                        portMappingName: this.serviceName,
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
            this.configureAlbRouting(props.cluster.vpc, props.albRouting, this.serviceName, containerPort);
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
            vpc: vpc,
            protocol: ApplicationProtocol.HTTP,
            port: containerPort,
            targetType: TargetType.INSTANCE,
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

        this.service.connections.allowFrom(
            loadBalancer.loadBalancer,
            EPHEMERAL_PORT_RANGE,
            "Allow ALB traffic to ECS service",
        );
    }
}

