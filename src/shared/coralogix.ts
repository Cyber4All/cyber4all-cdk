export const CORALOGIX_OTEL_ENV = {
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
    OTEL_NODE_RESOURCE_DETECTORS: "all",
    NODE_OPTIONS: "--require @opentelemetry/auto-instrumentations-node/register",
};

export function buildCoralogixResourceAttributes(applicationName: string, subsystemName: string): string {
    return `cx.application.name=${applicationName}, cx.subsystem.name=${subsystemName}`;
}

export function buildCoralogixOtelEnv(applicationName: string, subsystemName: string): Record<string, string> {
    return {
        ...CORALOGIX_OTEL_ENV,
        OTEL_RESOURCE_ATTRIBUTES: buildCoralogixResourceAttributes(applicationName, subsystemName),
    };
}

export function getSubsystemNameFromRepository(imageRepository: string): string {
    const imageWithTag = imageRepository.split("/").pop();
    const imageName = imageWithTag?.split(":")[0];

    if (!imageName) {
        throw new Error(`Unable to determine image name from repository: ${imageRepository}`);
    }

    return imageName;
}
