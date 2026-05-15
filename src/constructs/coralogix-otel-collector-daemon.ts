import { Duration, RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
import {
    CfnDaemon,
    CfnDaemonTaskDefinition
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

export interface CoralogixOtelCollectorDaemonProps {
    readonly cluster: EcsCluster;
    readonly environment: Environment;
    readonly version?: string;
}

export class CoralogixOtelCollectorDaemon extends Construct {
    public readonly taskDefinition: CfnDaemonTaskDefinition;
    public readonly daemon: CfnDaemon;
    public readonly logGroup: ILogGroup;
    public readonly privateKeySecret: ISecret;
    public readonly otelConfigSecret: ISecret;

    constructor(scope: Construct, id: string, props: CoralogixOtelCollectorDaemonProps) {
        super(scope, id);

        const serviceName = "coralogix-otel-collector";
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

        this.taskDefinition = new CfnDaemonTaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            cpu: "256",
            memory: "2048",
            executionRoleArn: executionRole.roleArn,
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
            containerDefinitions: [
                {
                    name: "coralogix-otel-agent",
                    image: `coralogixrepo/coralogix-otel-collector:${props.version ?? DEFAULT_VERSION}`,
                    essential: true,
                    cpu: 256,
                    memory: 2048,
                    privileged: true,
                    command: ["--config", "env:OTEL_CONFIG"],

                    environment: [
                        {
                            name: "CORALOGIX_DOMAIN",
                            value: "coralogix.us",
                        },
                        {
                            name: "APP_NAME",
                            value: "OTEL",
                        },
                        {
                            name: "SUB_SYS",
                            value: "ECS-EC2",
                        },
                        {
                            name: "SAMPLING_PERCENTAGE",
                            value: "10",
                        },
                        {
                            name: "SAMPLER_MODE",
                            value: "proportional",
                        },
                    ],
                    secrets: [
                        {
                            name: "PRIVATE_KEY",
                            valueFrom: `${this.privateKeySecret.secretArn}:PRIVATE_KEY::`,
                        },
                        {
                            name: "OTEL_CONFIG",
                            valueFrom: this.otelConfigSecret.secretArn,
                        },
                    ],
                    mountPoints: [
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
                    ],
                    // Do not add portMappings for Managed Daemons.
                    // The daemon_bridge network namespace exposes the collector locally at 169.254.172.2:<port>.
                    // Your collector config should still bind receivers to 0.0.0.0:4317 and 0.0.0.0:4318.
                    logConfiguration: {
                        logDriver: "awslogs",
                        options: {
                            "awslogs-group": this.logGroup.logGroupName,
                            "awslogs-region": stack.region,
                            "awslogs-stream-prefix": serviceName,
                        },
                    },
                    healthCheck: {
                        command: ["/healthcheck"],
                        interval: Duration.seconds(30).toSeconds(),
                        timeout: Duration.seconds(5).toSeconds(),
                        retries: 3,
                        startPeriod: Duration.seconds(10).toSeconds(),
                    },
                },
            ],
        });

        this.taskDefinition.node.addDependency(executionRole);
        this.taskDefinition.node.addDependency(this.logGroup);
        this.taskDefinition.node.addDependency(this.privateKeySecret);
        this.taskDefinition.node.addDependency(this.otelConfigSecret);

        const capactiyProviderName = props.cluster.capacityProvider.capacityProviderName;
        const capactiyProviderArn = `arn:aws:ecs:${stack.region}:${stack.account}:capacity-provider/${capactiyProviderName}`;

        this.daemon = new CfnDaemon(this, "Daemon", {
            clusterArn: props.cluster.cluster.clusterArn,
            daemonName: resourceName,
            daemonTaskDefinitionArn: this.taskDefinition.attrDaemonTaskDefinitionArn,
            capacityProviderArns: [capactiyProviderArn],
            enableEcsManagedTags: true,
            propagateTags: "DAEMON",
            deploymentConfiguration: {
                drainPercent: 100,
                bakeTimeInMinutes: 5,
            },
        });

        this.daemon.node.addDependency(this.taskDefinition);
    }

    public static getOtlpGrpcEndpoint(): string {
        return `http://${DAEMON_BRIDGE_IPV4}:4317`;
    }

    public static getOtlpHttpEndpoint(): string {
        return `http://${DAEMON_BRIDGE_IPV4}:4318`;
    }
}