import { RemovalPolicy, SecretValue, Stack, StackProps } from "aws-cdk-lib";
import { Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { EcsCluster } from "../constructs/ecs-cluster";
import { EcsService } from "../constructs/ecs-service";
import { MongoDBCluster } from "../constructs/mongodb-cluster";
import { SharedAlb } from "../constructs/shared-alb";
import { getCompetencyRuntimeConfig } from "../shared/competency-config";
import { getServiceConnectUri } from "../shared/ecs";
import { Application, Environment, getEnvironmentName } from "../shared/types";

export interface CompetencyStackProps extends StackProps {
    readonly environment: Environment;
    readonly cluster: EcsCluster;
    readonly sharedAlb: SharedAlb;
    readonly mongoCluster: MongoDBCluster;

    // TODO: Find a cleaner way to pass all these secrets without having to add them to the props interface
    readonly dockerHubSecret: ISecret;
    readonly sendGridSecret: ISecret;
    readonly coralogixSecret: ISecret;
    readonly otelConfigBucket: IBucket;
    readonly otelConfigS3Url: string;
}

export class CompetencyStack extends Stack {
    constructor(scope: Construct, id: string, props: CompetencyStackProps) {
        super(scope, id, props);

        const competencyConfig = getCompetencyRuntimeConfig(props.environment);
        const nodeEnv = getEnvironmentName(props.environment);
        const tag = props.environment === Environment.STAGING ? "staging" : "latest";

        const competencySecret = new Secret(this, "CompetencySecret", {
            secretName: `/${props.environment}/cyber4all/competency`,
            description: "Competency service secrets (AWS_API_KEY_SECRET, AWS_JWT_SECRET, AWS_SERVICE_KEY_SECRET, OTA_CODE_SECRET).",
            secretObjectValue: {
                AWS_API_KEY_SECRET: SecretValue.unsafePlainText("placeholder"),
                AWS_JWT_SECRET: SecretValue.unsafePlainText("placeholder"),
                AWS_SERVICE_KEY_SECRET: SecretValue.unsafePlainText("placeholder"),
                OTA_CODE_SECRET: SecretValue.unsafePlainText("placeholder"),
            },
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const mongoDbUriSecret = EcsSecret.fromSecretsManager(props.mongoCluster.connectionSecret, "MONGODB_URI");
        const awsApiKeySecret = EcsSecret.fromSecretsManager(competencySecret, "AWS_API_KEY_SECRET");
        const awsJwtSecret = EcsSecret.fromSecretsManager(competencySecret, "AWS_JWT_SECRET");
        const awsServiceKeySecret = EcsSecret.fromSecretsManager(competencySecret, "AWS_SERVICE_KEY_SECRET");
        const otaCodeSecret = EcsSecret.fromSecretsManager(competencySecret, "OTA_CODE_SECRET");
        const sendgridApiKeySecret = EcsSecret.fromSecretsManager(props.sendGridSecret, "SENDGRID_API_KEY");
        const coralogixPrivateKeySecret = EcsSecret.fromSecretsManager(props.coralogixSecret, "PRIVATE_KEY");

        const defaultServiceProps = {
            environment: props.environment,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster.cluster,
            otelSidecarOptions: {
                applicationName: Application.COMPETENCY,
                coralogixSecret: props.coralogixSecret,
                otelConfigBucket: props.otelConfigBucket,
                otelConfigS3Url: props.otelConfigS3Url,
            },
        };

        const securedAuthService = new EcsService(this, "SecuredAuthService", {
            ...defaultServiceProps,
            mongoCluster: props.mongoCluster,
            imageRepository: `cyber4all/secured-auth-service:${tag}`,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    GATEWAY_URI: competencyConfig.gatewayUri,
                    CLIENT_URI: competencyConfig.clientUri,
                    CARD_API: competencyConfig.clarkGatewayUri,
                    DB_NAME: "secured-auth",
                    NODE_ENV: nodeEnv,
                    ISSUER: competencyConfig.securedAuthIssuer,
                },
                secrets: {
                    AWS_API_KEY_SECRET: awsApiKeySecret,
                    AWS_JWT_SECRET: awsJwtSecret,
                    AWS_SERVICE_KEY_SECRET: awsServiceKeySecret,
                    OTA_CODE_SECRET: otaCodeSecret,
                    DB_URI: mongoDbUriSecret,
                    SENDGRID_API_KEY: sendgridApiKeySecret,
                    CORALOGIX_PRIVATE_KEY: coralogixPrivateKeySecret,
                },
            },
        });

        const competencyApiService = new EcsService(this, "CompetencyApiService", {
            ...defaultServiceProps,
            mongoCluster: props.mongoCluster,
            imageRepository: `cyber4all/competency-api:${tag}`,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    PDP_URI: getServiceConnectUri(securedAuthService.serviceName),
                    WF_FRAMEWORK_DB_NAME: "wf-frameworks",
                    NICE_DB_NAME: "nice-framework",
                    DCWF_DB_NAME: "dcwf-db",
                    COMP_DB_NAME: "competency-api",
                    NODE_ENV: nodeEnv,
                },
                secrets: {
                    AWS_SERVICE_KEY_SECRET: awsServiceKeySecret,
                    DB_URI: mongoDbUriSecret,
                    CORALOGIX_PRIVATE_KEY: coralogixPrivateKeySecret,
                },
            },
        });

        const competencyGatewayService = new EcsService(this, "CompetencyGatewayService", {
            ...defaultServiceProps,
            imageRepository: `cyber4all/competency-gateway:${tag}`,
            albRouting: {
                loadBalancer: props.sharedAlb,
                hostName: `api.${competencyConfig.competencyDomain}`,
            },
            containerOptions: {
                environment: {
                    PORT: "3000",
                    PDP_URI: getServiceConnectUri(securedAuthService.serviceName),
                    COMPETENCY_API_URI: getServiceConnectUri(competencyApiService.serviceName),
                    LAMBDA_URI: competencyConfig.lambdaUri,
                    NODE_ENV: nodeEnv,
                },
                secrets: {
                    AWS_SERVICE_KEY_SECRET: awsServiceKeySecret,
                    CORALOGIX_PRIVATE_KEY: coralogixPrivateKeySecret,
                },
            },
        });
        competencyApiService.service.node.addDependency(securedAuthService.service);
        competencyGatewayService.service.node.addDependency(securedAuthService.service);
        competencyGatewayService.service.node.addDependency(competencyApiService.service);
    }
}
