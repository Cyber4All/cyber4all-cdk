import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
    AppProtocol,
    AwsLogDriver,
    ContainerImage,
    Ec2Service,
    Ec2TaskDefinition,
    Secret as EcsSecret,
    ICluster,
    NetworkMode,
    PropagatedTagSource,
    Protocol,
} from "aws-cdk-lib/aws-ecs";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { IStringParameter, StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as fs from "node:fs";
import * as path from "node:path";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";

const DEFAULT_VERSION = "v0.5.12";

export interface CoralogixOtelCollectorDaemonProps {
    readonly cluster: ICluster;
    readonly environment: Environment;
    readonly coralogixDomain: string;
    readonly version?: string;
}

export class CoralogixOtelCollectorDaemon extends Construct {
    public readonly taskDefinition: Ec2TaskDefinition;
    public readonly service: Ec2Service;
    public readonly logGroup: ILogGroup;
    public readonly privateKeySecret: ISecret;
    public readonly otelConfigParameter: IStringParameter;

    constructor(scope: Construct, id: string, props: CoralogixOtelCollectorDaemonProps) {
        super(scope, id);

        const serviceName = "coralogix-otel-agent";
        const stack = Stack.of(this);
        const baseName = `${props.environment}-${serviceName}`;
        const regionShortName = getRegionShortName(stack.region);
        const uniqueSuffix = this.node.addr.substring(0, 8);
        const resourceName = `${baseName}-${regionShortName}-${uniqueSuffix}`;
        const secretBaseName = `/${props.environment}/cyber4all`;

        this.privateKeySecret = new Secret(this, "CoralogixPrivateKeySecret", {
            secretName: `${secretBaseName}/coralogix`,
            description: "Coralogix API credentials for log aggregation and analysis.",
            removalPolicy: RemovalPolicy.DESTROY,
        });
        this.otelConfigParameter = new StringParameter(this, "CoralogixOtelConfig", {
            parameterName: `${secretBaseName}/coralogix/otel-config`,
            stringValue: fs.readFileSync(
                path.join(__dirname, "../../assets/coralogix/otel-config.yaml"),
                "utf8",
            ),
        });

        const executionRole = new Role(this, "ExecutionRole", {
            roleName: resourceName,
            assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
            ],
        });

        this.taskDefinition = new Ec2TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            networkMode: NetworkMode.HOST,
            executionRole,
        });

        this.taskDefinition.addVolume({
            name: "hostfs",
            host: { sourcePath: "/var/lib/docker" },
        });
        this.taskDefinition.addVolume({
            name: "docker-socket",
            host: { sourcePath: "/var/run/docker.sock" },
        });

        this.logGroup = new LogGroup(this, "LogGroup", {
            logGroupName: `/ecs/daemon/${resourceName}`,
            retention: RetentionDays.ONE_WEEK,
        });

        const container = this.taskDefinition.addContainer("Collector", {
            containerName: "coralogix-otel-agent",
            image: ContainerImage.fromRegistry(`coralogixrepo/coralogix-otel-collector:${props.version ?? DEFAULT_VERSION}`),
            essential: true,
            cpu: 256,
            memoryLimitMiB: 2048,
            privileged: true,
            command: ["--config", "env:OTEL_CONFIG"],
            environment: {
                CORALOGIX_DOMAIN: props.coralogixDomain,
                APP_NAME: "OTEL",
                SUB_SYS: "ECS-EC2",
                SAMPLING_PERCENTAGE: "10",
                SAMPLER_MODE: "proportional",
            },
            secrets: {
                PRIVATE_KEY: EcsSecret.fromSecretsManager(this.privateKeySecret, "PRIVATE_KEY"),
                OTEL_CONFIG: EcsSecret.fromSsmParameter(this.otelConfigParameter),
            },
            logging: new AwsLogDriver({
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
            },
        );

        container.addPortMappings(
            {
                containerPort: 4317,
                protocol: Protocol.TCP,
                appProtocol: AppProtocol.grpc,
            },
            {
                containerPort: 4318,
                protocol: Protocol.TCP,
            },
            {
                containerPort: 8888,
                protocol: Protocol.TCP,
            },
            {
                containerPort: 1777,
                protocol: Protocol.TCP,
            },
        );

        this.privateKeySecret.grantRead(executionRole);
        this.otelConfigParameter.grantRead(executionRole);

        // App tasks should export OTLP to the container instance IP on 4317/4318 per ECS EC2 daemon pattern.
        this.service = new Ec2Service(this, "Service", {
            cluster: props.cluster,
            serviceName: resourceName,
            taskDefinition: this.taskDefinition,
            daemon: true,
            enableECSManagedTags: true,
            propagateTags: PropagatedTagSource.SERVICE,
            maxHealthyPercent: 100,
            minHealthyPercent: 0,
            circuitBreaker: {
                enable: true,
                rollback: true,
            },
        });
    }
}
