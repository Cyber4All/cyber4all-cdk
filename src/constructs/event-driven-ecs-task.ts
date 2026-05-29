import { Stack } from "aws-cdk-lib";
import {
    AwsLogDriver,
    ContainerImage,
    Ec2TaskDefinition,
    ICluster
} from "aws-cdk-lib/aws-ecs";
import { EventPattern, Rule } from "aws-cdk-lib/aws-events";
import { EcsTask } from "aws-cdk-lib/aws-events-targets";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnDatabaseUser, CfnDatabaseUserPropsAwsiamType } from "awscdk-resources-mongodbatlas";
import { Construct } from "constructs";
import { getImageName, getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";
import { ContainerOptions } from "./ecs-service";
import { MongoDBCluster } from "./mongodb-cluster";
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

    /** Optional MongoDB cluster for the task. */
    readonly mongoCluster?: MongoDBCluster;
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


        const taskRoleName = `${this.baseName}-${taskName}-task-role-${this.regionShortName}-${this.uniqueSuffix}`;
        const taskRole = new Role(this, "TaskRole", {
            roleName: taskRoleName,
            assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
        });

        this.taskDefinition = new Ec2TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            taskRole,
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

        if (props.mongoCluster) {
            this.configureMongoDbAccess(props.mongoCluster, taskRoleName);
        }
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
