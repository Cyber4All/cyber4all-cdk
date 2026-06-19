import {
    AppProtocol,
    ContainerImage,
    Secret as EcsSecret,
    FireLensLogDriver,
    FirelensLogRouterType,
    Protocol,
    TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { CORALOGIX_DOMAIN } from "../shared/coralogix";

export interface OtelEnvironmentOptions {
    /** Application name to use in OTEL_RESOURCE_ATTRIBUTES. Should be the same across all services for easier querying in Coralogix. */
    readonly applicationName: string;
    /** Subsystem name to use in OTEL_RESOURCE_ATTRIBUTES. Should be unique for each service. */
    readonly subsystemName: string;
    /** Whether to enable Node.js auto-instrumentation. Defaults to true. */
    readonly enableNodeAutoInstrumentation?: boolean;
}

export interface OtelSidecarOptions {
    readonly coralogixSecret: ISecret;
    readonly otelConfigBucket: IBucket;
    readonly otelConfigS3Url: string;
}

export function getOtelEnvironment(options: OtelEnvironmentOptions): Record<string, string> {
    const environment: Record<string, string> = {
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
        OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4317",
        OTEL_SERVICE_NAME: options.subsystemName,
        OTEL_RESOURCE_ATTRIBUTES: `cx.application.name=${options.applicationName},cx.subsystem.name=${options.subsystemName}`,
        OTEL_NODE_RESOURCE_DETECTORS: "all",
    };

    if (options.enableNodeAutoInstrumentation ?? true) {
        environment.NODE_OPTIONS = "--require @opentelemetry/auto-instrumentations-node/register";
    }

    return environment;
}

export function addOtelSidecar(taskDefinition: TaskDefinition, options: OtelSidecarOptions): void {
    options.otelConfigBucket.grantRead(taskDefinition.taskRole);

    const sidecar = taskDefinition.addFirelensLogRouter("OtelCollector", {
        containerName: "otel-collector",
        image: ContainerImage.fromRegistry("otel/opentelemetry-collector-contrib"),
        cpu: 0,
        essential: false,
        command: ["--config", options.otelConfigS3Url],
        environment: {
            CORALOGIX_DOMAIN,
        },
        secrets: {
            CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(options.coralogixSecret, "PRIVATE_KEY"),
        },
        logging: new FireLensLogDriver({
            options: {
                Name: "otel-collector",
            },
        }),
        firelensConfig: {
            type: FirelensLogRouterType.FLUENTBIT,
        },
        memoryReservationMiB: 256,
        memoryLimitMiB: 512,
        user: "0",
    });

    sidecar.addPortMappings(
        {
            containerPort: 4317,
            hostPort: 4317,
            name: "otel-collector-4317-tcp",
            protocol: Protocol.TCP,
            appProtocol: AppProtocol.grpc,
        },
        {
            containerPort: 4318,
            hostPort: 4318,
            name: "otel-collector-4318-tcp",
            protocol: Protocol.TCP,
        },
    );
}
