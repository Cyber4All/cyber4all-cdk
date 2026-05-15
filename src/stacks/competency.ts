import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Secret as EcsSecret, ICluster } from "aws-cdk-lib/aws-ecs";
import { IHostedZone } from "aws-cdk-lib/aws-route53";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import {
    COMPETENCY_GATEWAY_IMAGE_REPOSITORY,
    COMPETENCY_SERVICE_IMAGE_REPOSITORY,
    SECURED_AUTH_ISSUER,
    SECURED_AUTH_SERVICE_IMAGE_REPOSITORY,
} from "../constants";
import { EcsService } from "../constructs/ecs-service";
import { SharedAlb } from "../constructs/shared-alb";
import { getCompetencyRuntimeConfig } from "../shared/competency-config";
import { Environment, getEnvironmentName } from "../shared/types";

export interface CompetencyStackProps extends StackProps {
    readonly environment: Environment;
    readonly cluster: ICluster;
    readonly dockerHubSecret: ISecret;
    readonly sharedAlb: SharedAlb;
    readonly competencyGatewayHostName: string;
    readonly sendGridSecret: ISecret;
    readonly mongoConnectionSecret: ISecret;
}

export class CompetencyStack extends Stack {
    constructor(scope: Construct, id: string, props: CompetencyStackProps) {
        super(scope, id, props);

        const competencyConfig = getCompetencyRuntimeConfig(props.environment);
        const nodeEnv = getEnvironmentName(props.environment);
        const imageTag = props.environment === Environment.STAGING ? "staging" : "latest";
        const withTag = (repository: string): string => `${repository}:${imageTag}`;
        const serviceConnectUri = (name: string): string => `http://${name}:3000`;
        const ecsServiceUri = (service: EcsService): string => serviceConnectUri(service.serviceConnectName);

        const securedAuthImage = withTag(SECURED_AUTH_SERVICE_IMAGE_REPOSITORY);
        const competencyApiImage = withTag(COMPETENCY_SERVICE_IMAGE_REPOSITORY);
        const competencyGatewayImage = withTag(COMPETENCY_GATEWAY_IMAGE_REPOSITORY);

        const secretBaseName = `/${props.environment}/cyber4all`;
        const competencySecret = new Secret(this, "CompetencySecret", {
            secretName: `${secretBaseName}/competency`,
            description: "Competency service secrets (AWS_API_KEY_SECRET, AWS_JWT_SECRET, AWS_SERVICE_KEY_SECRET, OTA_CODE_SECRET).",
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const mongoDbUriSecret = EcsSecret.fromSecretsManager(props.mongoConnectionSecret, "MONGODB_URI");

        const defaultServiceProps = {
            environment: props.environment,
            dockerCredentials: props.dockerHubSecret,
            cluster: props.cluster,
        };

        const securedAuthService = new EcsService(this, "SecuredAuthService", {
            ...defaultServiceProps,
            imageRepository: securedAuthImage,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    GATEWAY_URI: competencyConfig.gatewayUri,
                    CLIENT_URI: competencyConfig.clientUri,
                    CARD_API: competencyConfig.clarkGatewayUri,
                    DB_NAME: "secured-auth",
                    NODE_ENV: nodeEnv,
                    ISSUER: SECURED_AUTH_ISSUER,
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
            imageRepository: competencyApiImage,
            containerOptions: {
                environment: {
                    PORT: "3000",
                    PDP_URI: ecsServiceUri(securedAuthService),
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

        const hostedZone = this.getHostedZone(props, props.competencyGatewayHostName);
        new EcsService(this, "CompetencyGatewayService", {
            ...defaultServiceProps,
            imageRepository: competencyGatewayImage,
            albRouting: {
                loadBalancer: props.sharedAlb.loadBalancer,
                hostName: props.competencyGatewayHostName,
                hostedZone,
            },
            containerOptions: {
                environment: {
                    PORT: "3000",
                    PDP_URI: ecsServiceUri(securedAuthService),
                    COMPETENCY_API_URI: ecsServiceUri(competencyApiService),
                    LAMBDA_URI: competencyConfig.lambdaUri,
                    NODE_ENV: nodeEnv,
                },
                secrets: {
                    AWS_SERVICE_KEY_SECRET: EcsSecret.fromSecretsManager(competencySecret, "AWS_SERVICE_KEY_SECRET"),
                },
            },
        });
    }

    private getHostedZone(props: CompetencyStackProps, hostName: string): IHostedZone {
        const matchingZone = Object.values(props.sharedAlb.hostedZones).find((zone) => hostName.endsWith(zone.zoneName));
        if (!matchingZone) {
            throw new Error(`No hosted zone found for host name ${hostName}`);
        }

        return matchingZone;
    }
}
