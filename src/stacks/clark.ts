import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { EventPattern } from "aws-cdk-lib/aws-events";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import {
    AWS_REGION,
    CLARK_ISSUER,
    CORALOGIX_LOG_URL,
} from "../constants";
import { EcsCluster } from "../constructs/ecs-cluster";
import { EcsService } from "../constructs/ecs-service";
import { EventDrivenEcsTask } from "../constructs/event-driver-ecs-task";
import { SharedAlb } from "../constructs/shared-alb";
import { getClarkRuntimeConfig } from "../shared/clark-config";
import { getServiceConnectUri } from "../shared/ecs";
import { Environment, getEnvironmentName } from "../shared/types";

export interface ClarkStackProps extends StackProps {
    readonly environment: Environment;
    readonly cluster: EcsCluster;
    readonly sharedAlb: SharedAlb;

    // TODO: Find a cleaner way to pass all these secrets without having to add them to the props interface
    readonly dockerHubSecret: ISecret;
    readonly googleSecret: ISecret;
    readonly sendGridSecret: ISecret;
    readonly shortcutSecret: ISecret;
    readonly slackSecret: ISecret;
    readonly mongoConnectionSecret: ISecret;
}

export class ClarkStack extends Stack {
    constructor(scope: Construct, id: string, props: ClarkStackProps) {
        super(scope, id, props);

        const clarkConfig = getClarkRuntimeConfig(props.environment);
        const nodeEnv = getEnvironmentName(props.environment);
        const tag = props.environment === Environment.STAGING ? "staging" : "latest";

        const secretBaseName = `/${props.environment}/cyber4all`;
        const clarkSecret = new Secret(this, "ClarkSecret", {
            secretName: `${secretBaseName}/clark`,
            description: "Clark service secrets (SECRET_KEY, GITHUB_ACCESS_TOKEN).",
            removalPolicy: RemovalPolicy.DESTROY,
        });
        const googleSecret = props.googleSecret;
        const sendGridSecret = props.sendGridSecret;
        const shortcutSecret = props.shortcutSecret;
        const slackSecret = props.slackSecret;
        const mongoDbUriSecret = EcsSecret.fromSecretsManager(props.mongoConnectionSecret, "MONGODB_URI");
        const sharedClarkSecret = EcsSecret.fromSecretsManager(clarkSecret, "SECRET_KEY");

        const defaultServiceProps = {
            environment: props.environment,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster.cluster,
            capacityProviderStrategies: [
                {
                    capacityProvider: props.cluster.capacityProvider.capacityProviderName,
                    weight: 1,
                },
            ],
        };

        const standardGuidelinesService = new EcsService(this, "StandardGuidelinesService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/standard-guidelines:${tag}`,
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
                },
                secrets: {
                    CLARK_DB_URI: mongoDbUriSecret,
                    KEY: sharedClarkSecret,
                },
            },
        });

        const clarkService = new EcsService(this, "ClarkService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/clark-service:${tag}`,
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
                    STANDARD_GUIDELINES_SERVICE_URI: getServiceConnectUri(standardGuidelinesService.serviceName),
                    ISSUER: CLARK_ISSUER,
                    NODE_ENV: nodeEnv,
                },
                secrets: {
                    SECRET_KEY: sharedClarkSecret,
                    CLARK_DB_URI: mongoDbUriSecret,
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
            imageRepository: `cyber4all/hierarchy-service:${tag}`,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    JWT_ISSUER: CLARK_ISSUER,
                    LEARNING_OBJECT_SERVICE_API: getServiceConnectUri(clarkService.serviceName),
                },
                secrets: {
                    JWT_SECRET: sharedClarkSecret,
                    MONGO_DB_URI: mongoDbUriSecret,
                },
            },
        });

        new EcsService(this, "ClarkGatewayService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/clark-gateway:${tag}`,
            albRouting: {
                loadBalancer: props.sharedAlb,
                hostName: `api.${clarkConfig.clarkDomain}`,
            },
            containerOptions: {
                environment: {
                    PORT: "3000",
                    CARD_SERVICE_URI: getServiceConnectUri("cards-service"),
                    CLARK_SERVICE_URI: getServiceConnectUri(clarkService.serviceName),
                    HIERARCHY_SERVICE_URI: getServiceConnectUri(hierarchyService.serviceName),
                    STANDARD_GUIDELINES_SERVICE_URI: getServiceConnectUri(standardGuidelinesService.serviceName),
                    ISSUER: CLARK_ISSUER,
                    NODE_ENV: nodeEnv,
                },
                secrets: {
                    AWS_JWT_SECRET: sharedClarkSecret,
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
            imageRepository: `cyber4all/clark-bundling-service:${tag}`,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster.cluster,
            eventPattern,
            containerOptions: {
                environment: {
                    EPHEMERAL_STORAGE_THRESHOLD: "80",
                    BUCKET: clarkConfig.clarkFileUploadsBucketName,
                    CORALOGIX_LOG_URL,
                    GO_ENV: nodeEnv,
                },
                secrets: {
                    DB_URI: mongoDbUriSecret,
                },
            },
        });
    }
}
