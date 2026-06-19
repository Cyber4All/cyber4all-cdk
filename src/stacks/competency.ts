import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
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
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const mongoDbUriSecret = EcsSecret.fromSecretsManager(props.mongoCluster.connectionSecret, "MONGODB_URI");

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
                    AWS_API_KEY_SECRET: EcsSecret.fromSecretsManager(competencySecret, "AWS_API_KEY_SECRET"),
                    AWS_JWT_SECRET: EcsSecret.fromSecretsManager(competencySecret, "AWS_JWT_SECRET"),
                    AWS_SERVICE_KEY_SECRET: EcsSecret.fromSecretsManager(competencySecret, "AWS_SERVICE_KEY_SECRET"),
                    OTA_CODE_SECRET: EcsSecret.fromSecretsManager(competencySecret, "OTA_CODE_SECRET"),
                    DB_URI: mongoDbUriSecret,
                    SENDGRID_API_KEY: EcsSecret.fromSecretsManager(props.sendGridSecret, "SENDGRID_API_KEY"),
                },
            },
        });

        const competencyApiService = new EcsService(this, "CompetencyApiService", {
            ...defaultServiceProps,
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
                    AWS_SERVICE_KEY_SECRET: EcsSecret.fromSecretsManager(competencySecret, "AWS_SERVICE_KEY_SECRET"),
                    DB_URI: mongoDbUriSecret,
                },
            },
        });

        new EcsService(this, "CompetencyGatewayService", {
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
                    AWS_SERVICE_KEY_SECRET: EcsSecret.fromSecretsManager(competencySecret, "AWS_SERVICE_KEY_SECRET"),
                },
            },
        });
    }
}
