import { PROD_CLARK_DOMAIN, STAGING_CLARK_DOMAIN } from "./clark-config";
import { Environment } from "./types";

type CompetencyRuntimeConfig = {
    readonly gatewayUri: string;
    readonly clientUri: string;
    readonly clarkGatewayUri: string;
    readonly competencyDomain: string;
    readonly securedAuthIssuer: string;
    readonly competencyFileUploadsBucketName: string;
};

export const PROD_COMPETENCY_DOMAIN = "cybercompetencies.com";
export const STAGING_COMPETENCY_DOMAIN = "staging.cybercompetencies.com";

export function getCompetencyRuntimeConfig(environment: Environment): CompetencyRuntimeConfig {
    switch (environment) {
        case Environment.PROD:
            return {
                gatewayUri: `https://api.${PROD_COMPETENCY_DOMAIN}`,
                clientUri: `https://${PROD_COMPETENCY_DOMAIN}`,
                clarkGatewayUri: `https://api.${PROD_CLARK_DOMAIN}`,
                competencyDomain: PROD_COMPETENCY_DOMAIN,
                securedAuthIssuer: "secured-auth-service",
                competencyFileUploadsBucketName: "cc-file-upload-bucket-prod",
            };
        case Environment.STAGING:
            return {
                gatewayUri: `https://api.${STAGING_COMPETENCY_DOMAIN}`,
                clientUri: `https://${STAGING_COMPETENCY_DOMAIN}`,
                clarkGatewayUri: `https://api.${STAGING_CLARK_DOMAIN}`,
                competencyDomain: STAGING_COMPETENCY_DOMAIN,
                securedAuthIssuer: "secured-auth-service",
                competencyFileUploadsBucketName: "cc-file-upload-bucket-staging",
            };
        default:
            throw new Error(`Unsupported environment: ${environment}`);
    }
}
