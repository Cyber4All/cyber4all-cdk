import { RemovalPolicy, SecretValue, Stack, StackProps } from "aws-cdk-lib";
import { Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { EventPattern } from "aws-cdk-lib/aws-events";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import {
    AWS_REGION,
} from "../constants";
import { EcsCluster } from "../constructs/ecs-cluster";
import { EcsService } from "../constructs/ecs-service";
import { EventDrivenEcsTask } from "../constructs/event-driven-ecs-task";
import { MongoDBCluster } from "../constructs/mongodb-cluster";
import { SharedAlb } from "../constructs/shared-alb";
import { getClarkRuntimeConfig } from "../shared/clark-config";
import { getServiceConnectUri, getServiceConnectUriWithPort } from "../shared/ecs";
import { Application, Environment, getEnvironmentName } from "../shared/types";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";

export interface ClarkStackProps extends StackProps {
    readonly environment: Environment;
    readonly cluster: EcsCluster;
    readonly sharedAlb: SharedAlb;
    readonly mongoCluster: MongoDBCluster;

    // TODO: Find a cleaner way to pass all these secrets without having to add them to the props interface
    readonly dockerHubSecret: ISecret;
    readonly googleSecret: ISecret;
    readonly sendGridSecret: ISecret;
    readonly shortcutSecret: ISecret;
    readonly slackSecret: ISecret;
    readonly coralogixSecret: ISecret;
    readonly otelConfigBucket: IBucket;
    readonly otelConfigS3Url: string;
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
            secretObjectValue: {
                SECRET_KEY: SecretValue.unsafePlainText("placeholder"),
            },
        });
        const googleSecret = props.googleSecret;
        const sendGridSecret = props.sendGridSecret;
        const shortcutSecret = props.shortcutSecret;
        const slackSecret = props.slackSecret;
        const mongoDbUriSecret = EcsSecret.fromSecretsManager(props.mongoCluster.connectionSecret, "MONGODB_URI");
        const sharedClarkSecret = EcsSecret.fromSecretsManager(clarkSecret, "SECRET_KEY");

        const defaultServiceProps = {
            environment: props.environment,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster.cluster,
            otelSidecarOptions: {
                applicationName: Application.CLARK,
                coralogixSecret: props.coralogixSecret,
                otelConfigBucket: props.otelConfigBucket,
                otelConfigS3Url: props.otelConfigS3Url,
            },
            enableExecuteCommand: props.environment === Environment.STAGING,
        };

        const standardGuidelinesService = new EcsService(this, "StandardGuidelinesService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/standard-guidelines-service:${tag}`,
            mongoCluster: props.mongoCluster,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    KEEP_ALIVE_TIMEOUT: "95000",
                    COOKIE_DOMAIN: `.${clarkConfig.clarkDomain}`,
                    GATEWAY_URI: clarkConfig.gatewayUri,
                    CLIENT_URL: clarkConfig.standardGuidelinesClientUrl,
                    ISSUER: clarkConfig.clarkIssuer,
                    NODE_ENV: nodeEnv,
                    NODE_ENVIRONMENT: nodeEnv,
                    CLARK_DB_NAME: "standard-guidelines",
                },
                secrets: {
                    CLARK_DB_URI: mongoDbUriSecret,
                    KEY: sharedClarkSecret,
                    CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(props.coralogixSecret, "PRIVATE_KEY"),
                },
            },
        });

        const clarkService = new EcsService(this, "ClarkService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/clark-service:${tag}`,
            mongoCluster: props.mongoCluster,
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
                    ISSUER: clarkConfig.clarkIssuer,
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
                },
            },
        });

        clarkService.taskDefinition.taskRole.addToPrincipalPolicy(
            new PolicyStatement({
                actions: [
                    "cognito-identity:GetOpenIdTokenForDeveloperIdentity",
                    "s3:ListBucket",
                    "s3:DeleteObject",
                    "s3:GetObject",
                    "s3:PutObject",
                    "events:PutEvents",

                ],
                resources: [
                    Stack.of(this).formatArn({
                        service: "cognito-identity",
                        resource: "identitypool",
                        resourceName: clarkConfig.cognitoIdentityPoolId,
                    }),
                    Stack.of(this).formatArn({
                        service: "cognito-identity",
                        resource: "identitypool",
                        resourceName: clarkConfig.cognitoAdminIdentityPoolId,
                    }),
                    `arn:aws:s3:::${clarkConfig.clarkFileUploadsBucketName}/*`,
                    `arn:aws:s3:::${clarkConfig.clarkFileUploadsBucketName}`,
                    `arn:aws:s3:::${clarkConfig.clarkReportsBucketName}/*`,
                    Stack.of(this).formatArn({
                        service: "events",
                        resource: "event-bus",
                        resourceName: "default"
                    }),
                ]
            })
        );

        clarkService.taskDefinition.taskRole.addToPrincipalPolicy(
            new PolicyStatement({
                actions: [
                    "bedrock:*",
                    "kendra:*"
                ],
                resources: [
                    "*"
                ]
            })
        )

        const hierarchyService = new EcsService(this, "HierarchyService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/hierarchy-service:${tag}`,
            mongoCluster: props.mongoCluster,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    JWT_ISSUER: clarkConfig.clarkIssuer,
                    LEARNING_OBJECT_SERVICE_API: getServiceConnectUri(clarkService.serviceName),
                },
                secrets: {
                    JWT_SECRET: sharedClarkSecret,
                    MONGO_DB_URI: mongoDbUriSecret,
                },
            },
        });

        const clarkMCPServer = new EcsService(this, "ClarkMCPServer", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/clark-mcp-server:${tag}`,
            containerOptions: {
                environment: {
                    PORT: "8000",
                    DOCLING_BASE_URL: "http://doclingService:5001",
                    GATEWAY_URI: "https://api.staging.clark.center"
                }
            }
        });

        const doclingService = new EcsService(this, "DoclingService", {
            ...defaultServiceProps,
            taskCpu: 2048,
            taskMemoryLimitMiB: 4096,
            imageRepository: `quay.io/docling-project/docling-serve`,
            containerOptions: {
                environment: {
                    PORT: "5001",
                    DOCLING_BASE_URL: "http://localhost:8000",
                    DOCLING_SERVE_ENABLE_UI: "1"
                }
            }
        });

        const clarkGatewayService = new EcsService(this, "ClarkGatewayService", {
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
                    MCP_SERVICE_URI: getServiceConnectUriWithPort(clarkMCPServer.serviceName, "8000"),
                    ISSUER: clarkConfig.clarkIssuer,
                    NODE_ENV: nodeEnv,
                },
                secrets: {
                    AWS_JWT_SECRET: sharedClarkSecret,
                    CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(props.coralogixSecret, "PRIVATE_KEY"),
                },
            },
        });
        clarkService.service.node.addDependency(standardGuidelinesService.service);
        hierarchyService.service.node.addDependency(clarkService.service);
        clarkGatewayService.service.node.addDependency(clarkService.service);
        clarkGatewayService.service.node.addDependency(hierarchyService.service);
        clarkGatewayService.service.node.addDependency(standardGuidelinesService.service);
        doclingService.service.node.addDependency(clarkGatewayService);
        clarkMCPServer.service.node.addDependency(clarkGatewayService);

        const eventPattern: EventPattern = {
            detailType: [
                "clark-bundling-service:create-next-instance",
                "learning-object-service:create-first-instance",
            ],
            source: ["clark-bundling-service-fargate-instance"],
        };

        const bundlingService = new EventDrivenEcsTask(this, "ClarkBundlingService", {
            environment: props.environment,
            imageRepository: `cyber4all/clark-bundling-service:${tag}`,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster.cluster,
            mongoCluster: props.mongoCluster,
            eventPattern,
            containerOptions: {
                environment: {
                    EPHEMERAL_STORAGE_THRESHOLD: "80",
                    BUCKET: clarkConfig.clarkFileUploadsBucketName,
                    GO_ENV: nodeEnv,
                    CORALOGIX_LOG_URL: "https://api.coralogix.us/api/v1/logs",
                    TASK_DEFINITION: "stg-clark-bundling-service-use1-c82606c3"
                },
                secrets: {
                    DB_URI: mongoDbUriSecret,
                    CORALOGIX_PRIVATE_KEY: EcsSecret.fromSecretsManager(props.coralogixSecret, "PRIVATE_KEY"),
                },
            },
            otelSidecarOptions: {
                applicationName: Application.CLARK,
                coralogixSecret: props.coralogixSecret,
                otelConfigBucket: props.otelConfigBucket,
                otelConfigS3Url: props.otelConfigS3Url,
            },
        });

        bundlingService.taskDefinition.taskRole.addToPrincipalPolicy(
            new PolicyStatement({
                actions: [
                    "events:PutEvents",
                    "s3:PutObject",
                    "s3:GetObject",
                    "s3:ListBucket",
                    "s3:DeleteBucket"
                ],
                resources: [
                    `arn:aws:s3:::${clarkConfig.clarkFileUploadsBucketName}/*`,
                    `arn:aws:s3:::${clarkConfig.clarkFileUploadsBucketName}`,
                    Stack.of(this).formatArn({
                        service: "events",
                        resource: "event-bus",
                        resourceName: "default"
                    }),
                ]
            }),
        );
        bundlingService.taskDefinition.taskRole.addToPrincipalPolicy(
            new PolicyStatement({
                actions: [
                    "ecs:DescribeTaskDefinition"
                ],
                resources: [
                    "*"
                ]
            })
        );
    }
}
