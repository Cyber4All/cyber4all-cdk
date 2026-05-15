/**
 * TODO: These should be the only things that need to be defined once the applications move away
 * from the old way of doing OTEL using the coralogix logger and winston and start
 * using the OTEL libraries directly.
 * 
 * OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.us1.coralogix.com:443
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer send_your_data_key"
OTEL_RESOURCE_ATTRIBUTES="service.name=nodejs-otel-logs-sample,cx.application.name=AppName,cx.subsystem.name=SubName"

And really the apps should define the OTEL_RESOURCE_ATTRIBUTES themselves.
 */


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
