import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Secret as EcsSecret, ICluster } from "aws-cdk-lib/aws-ecs";
import { EventPattern } from "aws-cdk-lib/aws-events";
import { IHostedZone } from "aws-cdk-lib/aws-route53";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
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
import { SharedAlb } from "../constructs/shared-alb";
import { getClarkRuntimeConfig } from "../shared/clark-config";
import { getServiceConnectUri } from "../shared/ecs";
import { Environment, getEnvironmentName } from "../shared/types";

export interface ClarkStackProps extends StackProps {
    readonly environment: Environment;
    readonly cluster: ICluster;
    readonly dockerHubSecret: ISecret;
    readonly sharedAlb: SharedAlb;
    readonly clarkGatewayHostName: string;
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
        const imageTag = props.environment === Environment.STAGING ? "staging" : "latest";
        const withTag = (repository: string): string => `${repository}:${imageTag}`;

        const standardGuidelinesImage = withTag(STANDARD_GUIDELINES_IMAGE_REPOSITORY);
        const clarkServiceImage = withTag(CLARK_SERVICE_IMAGE_REPOSITORY);
        const hierarchyServiceImage = withTag(HIERARCHY_SERVICE_IMAGE_REPOSITORY);
        const clarkGatewayImage = withTag(CLARK_GATEWAY_IMAGE_REPOSITORY);
        const clarkBundlingImage = withTag(CLARK_BUNDLING_SERVICE_IMAGE_REPOSITORY);

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
                },
                secrets: {
                    CLARK_DB_URI: mongoDbUriSecret,
                    KEY: sharedClarkSecret,
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
            imageRepository: hierarchyServiceImage,
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
        const hostedZone = this.getHostedZone(props, props.clarkGatewayHostName);
        new EcsService(this, "ClarkGatewayService", {
            ...defaultServiceProps,
            imageRepository: clarkGatewayImage,
            albRouting: {
                loadBalancer: props.sharedAlb.loadBalancer,
                hostName: props.clarkGatewayHostName,
                hostedZone,
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
                },
                secrets: {
                    DB_URI: mongoDbUriSecret,
                },
            },
        });
    }

    private getHostedZone(props: ClarkStackProps, hostName: string): IHostedZone {
        const matchingZone = Object.values(props.sharedAlb.hostedZones).find((zone) => hostName.endsWith(zone.zoneName));
        if (!matchingZone) {
            throw new Error(`No hosted zone found for host name ${hostName}`);
        }

        return matchingZone;
    }
}
