import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
    Compatibility,
    ContainerImage,
    Ec2Service,
    Secret as EcsSecret,
    LogDriver,
    NetworkMode,
    PropagatedTagSource,
    Protocol,
    TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
    BlockPublicAccess,
    Bucket,
    BucketEncryption,
    IBucket,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";
import { EcsCluster } from "./ecs-cluster";

const DEFAULT_VERSION = "v0.5.12";
const DEFAULT_CONFIG_KEY = "coralogix/coralogix-otel-config.yaml";

export const CORALOGIX_LOG_URL = "https://api.coralogix.us/api/v1/logs";

export interface CoralogixOtelCollectorDaemonProps {
    readonly cluster: EcsCluster;
    readonly environment: Environment;
}

export class CoralogixOtelCollectorDaemon extends Construct {
    public readonly taskDefinition: TaskDefinition;
    public readonly daemon: Ec2Service;
    public readonly logGroup: ILogGroup;
    public readonly privateKeySecret: ISecret;
    public readonly configBucket: IBucket;

    constructor(scope: Construct, id: string, props: CoralogixOtelCollectorDaemonProps) {
        super(scope, id);

        const stack = Stack.of(this);
        const regionShortName = getRegionShortName(stack.region);

        const logicalServiceName = "coralogix-otel";
        const resourceBaseName = `${props.environment}-${logicalServiceName}`;
        const uniqueSuffix = this.node.addr.substring(0, 8);
        const resourceName = `${resourceBaseName}-${regionShortName}-${uniqueSuffix}`;

        const configPath = path.join(__dirname, "../../assets/coralogix-otel-config.yaml");
        const configKey = DEFAULT_CONFIG_KEY;

        const profilingConfigPath = path.join(__dirname, "../../assets/otel-profiling-config.yaml");
        const profilingConfigKey = "coralogix/otel-profiling-config.yaml";

        this.privateKeySecret = new Secret(this, "CoralogixPrivateKeySecret", {
            secretName: `/${props.environment}/cyber4all/coralogix`,
            description: "Coralogix API credentials for telemetry export.",
            removalPolicy: RemovalPolicy.DESTROY,
        });

        this.configBucket = new Bucket(this, "ConfigBucket", {
            bucketName: `${resourceBaseName}-config-${regionShortName}-${uniqueSuffix}`,
            encryption: BucketEncryption.S3_MANAGED,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            autoDeleteObjects: true,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const configDeployment = new BucketDeployment(this, "ConfigDeployment", {
            destinationBucket: this.configBucket,
            sources: [
                Source.data(configKey, fs.readFileSync(configPath, "utf8")),
                Source.data(profilingConfigKey, fs.readFileSync(profilingConfigPath, "utf8")),
            ],
            retainOnDelete: false,
        });

        const taskAndExecutionRole = new Role(this, "Role", {
            roleName: `${resourceBaseName}-role-${regionShortName}-${uniqueSuffix}`,
            assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy",
                ),
            ],
        });

        this.privateKeySecret.grantRead(taskAndExecutionRole);
        this.configBucket.grantRead(taskAndExecutionRole);

        this.logGroup = new LogGroup(this, "LogGroup", {
            logGroupName: `/ecs/daemon/${resourceName}`,
            retention: RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const s3ConfigUrl = `s3://${this.configBucket.bucketName}.s3.${stack.region}.amazonaws.com/${configKey}`;

        this.taskDefinition = new TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            cpu: "256",
            memoryMiB: "2048",
            executionRole: taskAndExecutionRole,
            taskRole: taskAndExecutionRole,
            compatibility: Compatibility.EC2,
            networkMode: NetworkMode.HOST,
            volumes: [
                {
                    name: "hostfs",
                    host: {
                        sourcePath: "/var/lib/docker",
                    },
                },
                {
                    name: "docker-socket",
                    host: {
                        sourcePath: "/var/run/docker.sock",
                    },
                },
            ],
        });

        const container = this.taskDefinition.addContainer("OtelCollector", {
            containerName: "coralogix-otel-agent",
            image: ContainerImage.fromRegistry(
                `coralogixrepo/coralogix-otel-collector:${DEFAULT_VERSION}`,
            ),
            essential: true,
            cpu: 0,
            memoryLimitMiB: 2048,
            privileged: true,
            entryPoint: ["sh", "-c"],
            command: [`exec /cdot --config ${s3ConfigUrl}`],
            environment: {
                CORALOGIX_DOMAIN: "coralogix.us",
                MY_POD_IP: "127.0.0.1",
                CLUSTER_NAME: props.cluster.cluster.clusterName,
            },
            secrets: {
                CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(this.privateKeySecret,),
            },
            logging: LogDriver.awsLogs({
                streamPrefix: logicalServiceName,
                logGroup: this.logGroup,
            }),
            healthCheck: {
                command: ["/healthcheck"],
                interval: Duration.seconds(30),
                timeout: Duration.seconds(5),
                retries: 3,
                startPeriod: Duration.seconds(10),
            },
        });

        container.addPortMappings(
            {
                containerPort: 4317,
                hostPort: 4317,
                protocol: Protocol.TCP,
            },
            {
                containerPort: 4318,
                hostPort: 4318,
                protocol: Protocol.TCP,
            },
            {
                containerPort: 8888,
                hostPort: 8888,
                protocol: Protocol.TCP,
            },
            {
                containerPort: 1777,
                hostPort: 1777,
                protocol: Protocol.TCP,
            },
        );

        container.addMountPoints(
            {
                sourceVolume: "hostfs",
                containerPath: "/hostfs/var/lib/docker",
                readOnly: true,
            },
            {
                sourceVolume: "docker-socket",
                containerPath: "/var/run/docker.sock",
                readOnly: false,
            },
        );

        this.daemon = new Ec2Service(this, "DaemonService", {
            serviceName: resourceName,
            cluster: props.cluster.cluster,
            taskDefinition: this.taskDefinition,
            daemon: true,
            minHealthyPercent: 0,
            maxHealthyPercent: 100,
            circuitBreaker: {
                rollback: true,
            },
            enableECSManagedTags: true,
            propagateTags: PropagatedTagSource.TASK_DEFINITION,
        });

        this.daemon.node.addDependency(configDeployment);
    }
}