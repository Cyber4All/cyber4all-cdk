import { Duration, RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
import {
    Compatibility,
    ContainerImage,
    Ec2Service,
    Secret as EcsSecret,
    LogDriver,
    NetworkMode,
    PropagatedTagSource,
    TaskDefinition
} from "aws-cdk-lib/aws-ecs";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";
import { EcsCluster } from "./ecs-cluster";

const DEFAULT_VERSION = "v0.5.12";
const DAEMON_BRIDGE_IPV4 = "169.254.172.2";

export const CORALOGIX_LOG_URL = "https://api.coralogix.us/api/v1/logs";

export interface CoralogixOtelCollectorDaemonProps {
    readonly cluster: EcsCluster;
    readonly environment: Environment;
    readonly version?: string;
}

export class CoralogixOtelCollectorDaemon extends Construct {
    public readonly taskDefinition: TaskDefinition;
    public readonly daemon: Ec2Service;
    public readonly logGroup: ILogGroup;
    public readonly privateKeySecret: ISecret;
    public readonly otelConfigSecret: ISecret;

    constructor(scope: Construct, id: string, props: CoralogixOtelCollectorDaemonProps) {
        super(scope, id);

        const serviceName = "coralogix-otel";
        const stack = Stack.of(this);
        const baseName = `${props.environment}-${serviceName}`;
        const regionShortName = getRegionShortName(stack.region);
        const uniqueSuffix = this.node.addr.substring(0, 8);
        const resourceName = `${baseName}-${regionShortName}-${uniqueSuffix}`;
        const secretBaseName = `/${props.environment}/cyber4all/coralogix`;

        this.privateKeySecret = new Secret(this, "CoralogixPrivateKeySecret", {
            secretName: secretBaseName,
            description: "Coralogix API credentials for log aggregation and analysis.",
            removalPolicy: RemovalPolicy.DESTROY,
        });

        this.otelConfigSecret = new Secret(this, "CoralogixOtelConfig", {
            secretName: `${secretBaseName}/otel-config`,
            secretStringValue: SecretValue.unsafePlainText(
                fs.readFileSync(
                    path.join(__dirname, "../../assets/otel-config.yaml"),
                    "utf8",
                ),
            ),
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const executionRole = new Role(this, "ExecutionRole", {
            roleName: resourceName,
            assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy",
                ),
            ],
        });

        this.privateKeySecret.grantRead(executionRole);
        this.otelConfigSecret.grantRead(executionRole);

        this.logGroup = new LogGroup(this, "LogGroup", {
            logGroupName: `/ecs/daemon/${resourceName}`,
            retention: RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        this.taskDefinition = new TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            cpu: "256",
            memoryMiB: "2048",
            executionRole: executionRole,
            compatibility: Compatibility.EC2,
            networkMode: NetworkMode.HOST,
            // Do not specify networkMode. Managed Daemons automatically use daemon_bridge.
            // App tasks can send OTLP to http://169.254.172.2:4317 or http://169.254.172.2:4318.
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
            image: ContainerImage.fromRegistry(`coralogixrepo/coralogix-otel-collector:${props.version ?? DEFAULT_VERSION}`),
            essential: true,
            cpu: 256,
            memoryLimitMiB: 2048,
            privileged: true,
            command: ["--config", "env:OTEL_CONFIG"],
            environment: {
                "CORALOGIX_DOMAIN": "coralogix.us",
                "APP_NAME": "OTEL",
                "SUB_SYS": "ECS-EC2",
                "SAMPLING_PERCENTAGE": "10",
                "SAMPLER_MODE": "proportional",
            },
            secrets: {
                "PRIVATE_KEY": EcsSecret.fromSecretsManager(this.privateKeySecret, "PRIVATE_KEY"),
                "OTEL_CONFIG": EcsSecret.fromSecretsManager(this.otelConfigSecret, "OTEL_CONFIG"),
            },
            logging: LogDriver.awsLogs({
                streamPrefix: serviceName,
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
            }
        );

        this.daemon = new Ec2Service(this, "DaemonService", {
            serviceName: resourceName,
            cluster: props.cluster.cluster,
            taskDefinition: this.taskDefinition,
            daemon: true,
            enableECSManagedTags: true,
            propagateTags: PropagatedTagSource.TASK_DEFINITION,
        });
    }

    public static getOtlpGrpcEndpoint(): string {
        return `http://${DAEMON_BRIDGE_IPV4}:4317`;
    }

    public static getOtlpHttpEndpoint(): string {
        return `http://${DAEMON_BRIDGE_IPV4}:4318`;
    }
}