import { Stack } from "aws-cdk-lib";
import {
    AwsLogDriver,
    ContainerImage,
    Ec2TaskDefinition,
    ICluster
} from "aws-cdk-lib/aws-ecs";
import { EventPattern, Rule } from "aws-cdk-lib/aws-events";
import { EcsTask } from "aws-cdk-lib/aws-events-targets";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { getImageName, getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";
import { ContainerOptions } from "./ecs-service";
/**
 * Properties for an ECS task launched by an EventBridge rule.
 */
export interface EventDrivenEcsTaskProps {
    /** Deployment environment used in generated resource names. */
    readonly environment: Environment;

    /** Container image repository, optionally with a tag, such as cyber4all/task:staging. */
    readonly imageRepository: string;

    /** Secrets Manager secret containing Docker registry credentials. */
    readonly dockerCredentials: ISecret;

    /** ECS cluster where EventBridge starts the task. */
    readonly cluster: ICluster;

    /** EventBridge pattern that triggers the task. */
    readonly eventPattern: EventPattern;

    /** Optional container settings. */
    readonly containerOptions?: ContainerOptions;
}

export class EventDrivenEcsTask extends Construct {
    public readonly taskDefinition: Ec2TaskDefinition;
    public readonly eventRule: Rule;

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: EventDrivenEcsTaskProps) {
        super(scope, id);

        this.baseName = `${props.environment}`;
        this.regionShortName = getRegionShortName(Stack.of(this).region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);

        const taskName = getImageName(props.imageRepository, this);
        const resourceName = `${this.baseName}-${taskName}-${this.regionShortName}-${this.uniqueSuffix}`;

        this.taskDefinition = new Ec2TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
        });

        const logDriver = new AwsLogDriver({
            streamPrefix: taskName,
        });

        this.taskDefinition.addContainer("Container", {
            containerName: taskName,
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

        this.eventRule = new Rule(this, "EventRule", {
            eventPattern: props.eventPattern,
        });

        this.eventRule.addTarget(
            new EcsTask({
                cluster: props.cluster,
                taskDefinition: this.taskDefinition,
                taskCount: 1,
            }),
        );
    }
}
