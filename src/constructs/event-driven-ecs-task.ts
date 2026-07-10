import { RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import { SecurityGroup, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
    AwsLogDriver,
    ContainerImage,
    FargatePlatformVersion,
    FargateTaskDefinition,
    ICluster,
    LaunchType
} from "aws-cdk-lib/aws-ecs";
import { EventPattern, Rule } from "aws-cdk-lib/aws-events";
import { EcsTask } from "aws-cdk-lib/aws-events-targets";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnDatabaseUser, CfnDatabaseUserPropsAwsiamType } from "awscdk-resources-mongodbatlas";
import { Construct } from "constructs";
import { getImageName, getRegionShortName } from "../shared/names";
import { NAME_TAG } from "../shared/tags";
import { Environment } from "../shared/types";
import { ContainerOptions, OtelSidecarOptions } from "./ecs-service";
import { MongoDBCluster } from "./mongodb-cluster";
import { addOtelSidecar, getOtelEnvironment } from "./otel-sidecar";
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

    /** Options for configuring the OTEL sidecar. */
    readonly otelSidecarOptions?: OtelSidecarOptions;

    /** Fargate task CPU units. Defaults to 512. */
    readonly taskCpu?: number;

    /** Fargate task memory in MiB. Defaults to 1024. */
    readonly taskMemoryLimitMiB?: number;
}

export class EventDrivenEcsTask extends Construct {
    public readonly taskDefinition: FargateTaskDefinition;
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

        this.taskDefinition = new FargateTaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            cpu: props.taskCpu ?? 512,
            memoryLimitMiB: props.taskMemoryLimitMiB ?? 1024,
            taskRole,
            ephemeralStorageGiB: 150
        });

        const logDriver = new AwsLogDriver({
            streamPrefix: taskName,
            logGroup: new LogGroup(this, "LogGroup", {
                logGroupName: `/ecs/scheduled-task/${resourceName}`,
                retention: RetentionDays.ONE_WEEK,
                removalPolicy: RemovalPolicy.DESTROY,
            }),
        });

        let otelEnvironment = {};
        if (props.otelSidecarOptions) {
            const { applicationName, coralogixSecret, otelConfigBucket, otelConfigS3Url } = props.otelSidecarOptions;
            otelEnvironment = getOtelEnvironment({
                subsystemName: taskName,
                applicationName: `${applicationName}-${props.environment}`,
                enableNodeAutoInstrumentation: false,
            });

            addOtelSidecar(this.taskDefinition, { coralogixSecret, otelConfigBucket, otelConfigS3Url });
        }

        this.taskDefinition.addContainer("Container", {
            containerName: taskName,
            image: ContainerImage.fromRegistry(props.imageRepository, {
                credentials: props.dockerCredentials,
            }),
            essential: true,
            environment: {
                ...otelEnvironment,
                ...props.containerOptions?.environment,
                // TODO: This isn't the best solution, but we need this ENV for clark-bundling-service to ref itself. 
                // This can't be set in the stack because it uses UniqueSuffix. The proper solution would be to fix
                // clark-bundling-service to not need the TaskDefinition name directly to calculate size threshold.
                TASK_DEFINITION: resourceName
            },
            secrets: props.containerOptions?.secrets,
            cpu: props.containerOptions?.cpu ?? 0,
            memoryReservationMiB: props.containerOptions?.memoryReservationMiB,
            memoryLimitMiB: props.containerOptions?.memoryLimitMiB,
            logging: logDriver,
        });

        const securityGroupName = `${this.baseName}-${taskName}-sg-${this.regionShortName}-${this.uniqueSuffix}`;
        const securityGroup = new SecurityGroup(this, "SecurityGroup", {
            vpc: props.cluster.vpc,
            securityGroupName: securityGroupName,
            description: `Security group for ${taskName} Fargate scheduled task`,
            allowAllOutbound: true,
        });
        Tags.of(securityGroup).add(NAME_TAG, securityGroupName);

        this.eventRule = new Rule(this, "EventRule", {
            eventPattern: props.eventPattern,
        });

        this.eventRule.addTarget(
            new EcsTask({
                cluster: props.cluster,
                taskDefinition: this.taskDefinition,
                taskCount: 1,
                launchType: LaunchType.FARGATE,
                platformVersion: FargatePlatformVersion.LATEST,
                assignPublicIp: false,
                securityGroups: [securityGroup],
                subnetSelection: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
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
