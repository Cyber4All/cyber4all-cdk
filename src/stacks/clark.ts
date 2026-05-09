import { Stack, StackProps } from "aws-cdk-lib";
import { Secret as EcsSecret, ICluster } from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { EventPattern } from "aws-cdk-lib/aws-events";
import { IHostedZone } from "aws-cdk-lib/aws-route53";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import {
    AWS_REGION,
    CLARK_BUNDLING_SERVICE_IMAGE_REPOSITORY,
    CLARK_GATEWAY_IMAGE_REPOSITORY,
    CLARK_ISSUER,
    CLARK_SERVICE_IMAGE_REPOSITORY,
    CORALOGIX_LOG_URL,
    HIERARCHY_SERVICE_IMAGE_REPOSITORY,
    STANDARD_GUIDELINES_IMAGE_REPOSITORY,
} from "../constants";
import { EcsService, EventDrivenEcsTask } from "../constructs/ecs-service";
import { getClarkRuntimeConfig } from "../shared/clark-config";
import {
    buildCoralogixOtelEnv,
    getSubsystemNameFromRepository,
} from "../shared/coralogix";
import { getRegionShortName } from "../shared/names";
import { Environment, getEnvironmentName } from "../shared/types";

export interface ClarkStackProps extends StackProps {
    readonly environment: Environment;
    readonly cluster: ICluster;
    readonly dockerHubSecret: ISecret;
    readonly sharedAlb: ApplicationLoadBalancer;
    readonly hostedZones: Record<string, IHostedZone>;
    readonly clarkGatewayHostName: string;
    readonly clarkSecret: ISecret;
    readonly coralogixSecret: ISecret;
    readonly googleSecret: ISecret;
    readonly sendGridSecret: ISecret;
    readonly shortcutSecret: ISecret;
    readonly slackSecret: ISecret;
    readonly mongoConnectionSecret: ISecret;
}

export class ClarkStack extends Stack {
    constructor(scope: Construct, id: string, props: ClarkStackProps) {
        super(scope, id, props);

        const envPrefix = props.environment;
        const clarkConfig = getClarkRuntimeConfig(props.environment);
        const regionShortName = getRegionShortName(Stack.of(this).region);
        const nodeEnv = getEnvironmentName(props.environment);
        const imageTag = props.environment === Environment.STAGING ? "staging" : "latest";
        const withTag = (repository: string): string => `${repository}:${imageTag}`;
        const coralogixAppName = `clark-${nodeEnv}`;
        const serviceName = (name: string): string => `${envPrefix}-${name}-${regionShortName}`;
        const serviceConnectUri = (name: string): string => `http://${name}:3000`;
        const ecsServiceUri = (service: EcsService): string => serviceConnectUri(service.serviceConnectName);

        const standardGuidelinesImage = withTag(STANDARD_GUIDELINES_IMAGE_REPOSITORY);
        const clarkServiceImage = withTag(CLARK_SERVICE_IMAGE_REPOSITORY);
        const hierarchyServiceImage = withTag(HIERARCHY_SERVICE_IMAGE_REPOSITORY);
        const clarkGatewayImage = withTag(CLARK_GATEWAY_IMAGE_REPOSITORY);
        const clarkBundlingImage = withTag(CLARK_BUNDLING_SERVICE_IMAGE_REPOSITORY);

        const standardGuidelinesSubsystem = getSubsystemNameFromRepository(standardGuidelinesImage);
        const clarkServiceSubsystem = getSubsystemNameFromRepository(clarkServiceImage);
        const hierarchyServiceSubsystem = getSubsystemNameFromRepository(hierarchyServiceImage);
        const clarkGatewaySubsystem = getSubsystemNameFromRepository(clarkGatewayImage);
        const clarkBundlingSubsystem = getSubsystemNameFromRepository(clarkBundlingImage);

        const coralogixSecrets = {
            CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(
                props.coralogixSecret,
                "CORALOGIX_PRIVATE_KEY",
            ),
            OTEL_EXPORTER_OTLP_HEADERS: EcsSecret.fromSecretsManager(
                props.coralogixSecret,
                "OTEL_EXPORTER_OTLP_HEADERS",
            ),
        };
        const clarkSecret = props.clarkSecret;
        const googleSecret = props.googleSecret;
        const sendGridSecret = props.sendGridSecret;
        const shortcutSecret = props.shortcutSecret;
        const slackSecret = props.slackSecret;
        const mongoDbUriSecret = EcsSecret.fromSecretsManager(props.mongoConnectionSecret, "MONGODB_URI");
        const sharedClarkSecret = EcsSecret.fromSecretsManager(clarkSecret, "SECRET_KEY");

        const defaultServiceProps = {
            environment: props.environment,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster,
        };

        const standardGuidelinesService = new EcsService(this, "StandardGuidelinesService", {
            ...defaultServiceProps,
            imageRepository: standardGuidelinesImage,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    KEEP_ALIVE_TIMEOUT: "95000",
                    COOKIE_DOMAIN: `.${clarkConfig.clarkDomain}`,
                    GATEWAY_URI: clarkConfig.gatewayUri,
                    CLIENT_URL: clarkConfig.standardGuidelinesClientUrl,
                    ISSUER: CLARK_ISSUER,
                    NODE_ENV: nodeEnv,
                    NODE_ENVIRONMENT: nodeEnv,
                    CLARK_DB_NAME: "standard-guidelines",
                    OTEL_SERVICE_NAME: serviceName("standard-guidelines"),
                    ...buildCoralogixOtelEnv(coralogixAppName, standardGuidelinesSubsystem),
                },
                secrets: {
                    CLARK_DB_URI: mongoDbUriSecret,
                    KEY: sharedClarkSecret,
                    OTEL_EXPORTER_OTLP_HEADERS: coralogixSecrets.OTEL_EXPORTER_OTLP_HEADERS,
                },
            },
        });

        const clarkService = new EcsService(this, "ClarkService", {
            ...defaultServiceProps,
            imageRepository: clarkServiceImage,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    AWS_REGION,
                    COGNITO_REGION: AWS_REGION,
                    COGNITO_IDENTITY_POOL_ID: clarkConfig.cognitoIdentityPoolId,
                    COGNITO_ADMIN_IDENTITY_POOL_ID: clarkConfig.cognitoAdminIdentityPoolId,
                    GATEWAY_URI: clarkConfig.gatewayUri,
                    CLIENT_URI: clarkConfig.clientUri,
                    CLIENT_COOKIE_DOMAIN: clarkConfig.clientCookieDomain,
                    BUCKET_NAME: clarkConfig.clarkFileUploadsBucketName,
                    CLARK_REPORTS_BUCKET_NAME: clarkConfig.clarkReportsBucketName,
                    STANDARD_GUIDELINES_SERVICE_URI: ecsServiceUri(standardGuidelinesService),
                    ISSUER: CLARK_ISSUER,
                    NODE_ENV: nodeEnv,
                    OTEL_SERVICE_NAME: serviceName("clark-service"),
                    ...buildCoralogixOtelEnv(coralogixAppName, clarkServiceSubsystem),
                    ...(clarkConfig.knowledgeBaseId ? { KNOWLEDGE_BASE_ID: clarkConfig.knowledgeBaseId } : {}),
                },
                secrets: {
                    AWS_JWT_SECRET: sharedClarkSecret,
                    CAPTCHA_SECRET: sharedClarkSecret,
                    SESSION_SECRET: sharedClarkSecret,
                    CLARK_DB_URI: mongoDbUriSecret,
                    CORALOGIX_PRIVATE_KEY: coralogixSecrets.CORALOGIX_PRIVATE_KEY,
                    OTEL_EXPORTER_OTLP_HEADERS: coralogixSecrets.OTEL_EXPORTER_OTLP_HEADERS,
                    GOOGLE_CLIENT_ID: EcsSecret.fromSecretsManager(googleSecret, "GOOGLE_CLIENT_ID"),
                    GOOGLE_CLIENT_SECRET: EcsSecret.fromSecretsManager(googleSecret, "GOOGLE_CLIENT_SECRET"),
                    GOOGLE_PRIVATE_KEY: EcsSecret.fromSecretsManager(googleSecret, "GOOGLE_PRIVATE_KEY"),
                    GOOGLE_SERVICE_ACCOUNT_EMAIL: EcsSecret.fromSecretsManager(
                        googleSecret,
                        "GOOGLE_SERVICE_ACCOUNT_EMAIL",
                    ),
                    SENDGRID_API_KEY: EcsSecret.fromSecretsManager(sendGridSecret, "SENDGRID_API_KEY"),
                    SENDGRID_VERIFIED_USER_API_KEY: EcsSecret.fromSecretsManager(
                        sendGridSecret,
                        "SENDGRID_VERIFIED_USER_API_KEY",
                    ),
                    SHORTCUT_API_KEY: EcsSecret.fromSecretsManager(shortcutSecret, "SHORTCUT_API_KEY"),
                    SLACK_TOKEN: EcsSecret.fromSecretsManager(slackSecret, "SLACK_TOKEN"),
                    SLACK_URI: EcsSecret.fromSecretsManager(slackSecret, "SLACK_URI"),
                    GITHUB_ACCESS_TOKEN: EcsSecret.fromSecretsManager(clarkSecret, "GITHUB_ACCESS_TOKEN"),
                },
            },
        });

        const hierarchyService = new EcsService(this, "HierarchyService", {
            ...defaultServiceProps,
            imageRepository: hierarchyServiceImage,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    JWT_ISSUER: CLARK_ISSUER,
                    LEARNING_OBJECT_SERVICE_API: ecsServiceUri(clarkService),
                    OTEL_SERVICE_NAME: serviceName("hierarchy-service"),
                    ...buildCoralogixOtelEnv(coralogixAppName, hierarchyServiceSubsystem),
                },
                secrets: {
                    JWT_SECRET: sharedClarkSecret,
                    MONGO_DB_URI: mongoDbUriSecret,
                    OTEL_EXPORTER_OTLP_HEADERS: coralogixSecrets.OTEL_EXPORTER_OTLP_HEADERS,
                },
            },
        });
        const hostedZone = this.getHostedZone(props, props.clarkGatewayHostName);
        new EcsService(this, "ClarkGatewayService", {
            ...defaultServiceProps,
            imageRepository: clarkGatewayImage,
            albRouting: {
                loadBalancer: props.sharedAlb,
                hostName: props.clarkGatewayHostName,
                hostedZone,
            },
            containerOptions: {
                environment: {
                    PORT: "3000",
                    CARD_SERVICE_URI: serviceConnectUri("cards-service"),
                    CLARK_SERVICE_URI: ecsServiceUri(clarkService),
                    HIERARCHY_SERVICE_URI: ecsServiceUri(hierarchyService),
                    STANDARD_GUIDELINES_SERVICE_URI: ecsServiceUri(standardGuidelinesService),
                    ISSUER: CLARK_ISSUER,
                    NODE_ENV: nodeEnv,
                    OTEL_SERVICE_NAME: serviceName("clark-gateway"),
                    ...buildCoralogixOtelEnv(coralogixAppName, clarkGatewaySubsystem),
                },
                secrets: {
                    AWS_JWT_SECRET: sharedClarkSecret,
                    ...coralogixSecrets,
                },
            },
        });

        const eventPattern: EventPattern = {
            detailType: [
                "clark-bundling-service:create-next-instance",
                "learning-object-service:create-first-instance",
            ],
            source: ["clark-bundling-service-fargate-instance"],
        };

        new EventDrivenEcsTask(this, "ClarkBundlingService", {
            environment: props.environment,
            imageRepository: clarkBundlingImage,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster,
            eventPattern,
            containerOptions: {
                environment: {
                    EPHEMERAL_STORAGE_THRESHOLD: "80",
                    BUCKET: clarkConfig.clarkFileUploadsBucketName,
                    CORALOGIX_LOG_URL,
                    GO_ENV: nodeEnv,
                    OTEL_SERVICE_NAME: serviceName("clark-bundling"),
                    ...buildCoralogixOtelEnv(coralogixAppName, clarkBundlingSubsystem),
                },
                secrets: {
                    CORALOGIX_PRIVATE_KEY: coralogixSecrets.CORALOGIX_PRIVATE_KEY,
                    OTEL_EXPORTER_OTLP_HEADERS: coralogixSecrets.OTEL_EXPORTER_OTLP_HEADERS,
                    DB_URI: mongoDbUriSecret,
                },
            },
        });
    }

    private getHostedZone(props: ClarkStackProps, hostName: string): IHostedZone {
        const matchingZone = Object.values(props.hostedZones).find((zone) => hostName.endsWith(zone.zoneName));
        if (!matchingZone) {
            throw new Error(`No hosted zone found for host name ${hostName}`);
        }

        return matchingZone;
    }
}
