import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import {
    AppProtocol,
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
import {
    ManagedPolicy,
    PolicyStatement,
    Role,
    ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
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

export const CORALOGIX_LOG_URL = "https://api.coralogix.us/api/v1/logs";

const DEFAULT_VERSION = "v0.5.12";
const DEFAULT_CONFIG_KEY = "coralogix/coralogix-otel-config.yaml";

export interface CoralogixOtelCollectorServiceProps {
    readonly cluster: EcsCluster;
    readonly environment: Environment;
    readonly desiredCount?: number;
}

export class CoralogixOtelCollectorService extends Construct {
    public readonly taskDefinition: TaskDefinition;
    public readonly service: Ec2Service;
    public readonly logGroup: ILogGroup;
    public readonly privateKeySecret: ISecret;
    public readonly configBucket: IBucket;
    public readonly serviceName: string;

    constructor(scope: Construct, id: string, props: CoralogixOtelCollectorServiceProps) {
        super(scope, id);

        const stack = Stack.of(this);
        const regionShortName = getRegionShortName(stack.region);

        const logicalServiceName = "coralogix-otel";
        const resourceBaseName = `${props.environment}-${logicalServiceName}`;
        const uniqueSuffix = this.node.addr.substring(0, 8);
        const resourceName = `${resourceBaseName}-${regionShortName}-${uniqueSuffix}`;

        this.serviceName = logicalServiceName;

        const configPath = path.join(__dirname, "../../assets/coralogix-otel-config.yaml");
        const configKey = DEFAULT_CONFIG_KEY;

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
            sources: [Source.data(configKey, fs.readFileSync(configPath, "utf8"))],
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

        taskAndExecutionRole.addToPolicy(
            new PolicyStatement({
                actions: ["ec2:DescribeTags"],
                resources: ["*"],
            }),
        );

        this.privateKeySecret.grantRead(taskAndExecutionRole);
        this.configBucket.grantRead(taskAndExecutionRole);

        this.logGroup = new LogGroup(this, "LogGroup", {
            logGroupName: `/ecs/service/${resourceName}`,
            retention: RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const s3ConfigUrl = `s3://${this.configBucket.bucketName}.s3.${stack.region}.amazonaws.com/${configKey}`;

        this.taskDefinition = new TaskDefinition(this, "TaskDefinition", {
            family: resourceName,
            cpu: "512",
            memoryMiB: "1024",
            executionRole: taskAndExecutionRole,
            taskRole: taskAndExecutionRole,
            compatibility: Compatibility.EC2,
            networkMode: NetworkMode.BRIDGE,
        });

        const container = this.taskDefinition.addContainer("OtelCollector", {
            containerName: "coralogix-otel-agent",
            image: ContainerImage.fromRegistry(
                `otel/opentelemetry-collector-contrib:0.102.1`,
            ),
            essential: true,
            cpu: 0,
            memoryLimitMiB: 1024,
            entryPoint: ["sh", "-c"],
            command: [`exec /cdot --config ${s3ConfigUrl}`],
            environment: {
                CORALOGIX_DOMAIN: "coralogix.us",
                CLUSTER_NAME: props.cluster.cluster.clusterName,
            },
            secrets: {
                CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(this.privateKeySecret),
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
                name: "otlp-grpc",
                protocol: Protocol.TCP,
                appProtocol: AppProtocol.grpc,
            },
            {
                containerPort: 4318,
                name: "otlp-http",
                protocol: Protocol.TCP,
                appProtocol: AppProtocol.http,
            },
            {
                containerPort: 8888,
                name: "metrics",
                protocol: Protocol.TCP,
                appProtocol: AppProtocol.http,
            },
        );

        this.service = new Ec2Service(this, "Service", {
            serviceName: resourceName,
            cluster: props.cluster.cluster,
            taskDefinition: this.taskDefinition,
            desiredCount: props.desiredCount ?? 1,
            minHealthyPercent: 50,
            maxHealthyPercent: 200,
            circuitBreaker: {
                rollback: true,
            },
            enableECSManagedTags: true,
            propagateTags: PropagatedTagSource.TASK_DEFINITION,
            serviceConnectConfiguration: {
                services: [
                    {
                        portMappingName: "otlp-http",
                        dnsName: logicalServiceName,
                        port: 4318,
                    },
                    {
                        portMappingName: "otlp-grpc",
                        dnsName: `${logicalServiceName}-grpc`,
                        port: 4317,
                    },
                ],
            },
        });

        this.service.node.addDependency(configDeployment);
    }
}