import { Environment } from "./types";

type ClarkRuntimeConfig = {
    readonly clientUri: string;
    readonly cardClientUri: string;
    readonly clientCookieDomain: string;
    readonly gatewayUri: string;
    readonly standardGuidelinesClientUrl: string;
    readonly clarkReportsBucketName: string;
    readonly clarkFileUploadsBucketName: string;
    readonly knowledgeBaseId: string;
    readonly cognitoIdentityPoolId: string;
    readonly cognitoAdminIdentityPoolId: string;
    readonly clarkDomain: string;
    readonly clarkIssuer: string;
};

export const PROD_CLARK_DOMAIN = "clark.center";
export const STAGING_CLARK_DOMAIN = "staging.clark.center";

export function getClarkRuntimeConfig(environment: Environment): ClarkRuntimeConfig {
    switch (environment) {
        case Environment.PROD:
            return {
                clientUri: `https://${PROD_CLARK_DOMAIN}`,
                cardClientUri: `https://caeresource.${PROD_CLARK_DOMAIN}`,
                clientCookieDomain: PROD_CLARK_DOMAIN,
                gatewayUri: `https://api.${PROD_CLARK_DOMAIN}`,
                standardGuidelinesClientUrl: `https://api.${PROD_CLARK_DOMAIN}`,
                clarkReportsBucketName: "clark-reports",
                clarkFileUploadsBucketName: "clark-prod-file-uploads",
                knowledgeBaseId: "OD56DVFDSD",
                cognitoIdentityPoolId: "us-east-1:1ad4e60a-9773-4a67-92b5-6cc2c7b3328f",
                cognitoAdminIdentityPoolId: "us-east-1:6691336e-11a1-48db-9774-5f5a2c8dc270",
                clarkDomain: PROD_CLARK_DOMAIN,
                clarkIssuer: "C.L.A.R.K. - Cybersecurity Labs and Resource Knowledge-base",
            };
        case Environment.STAGING:
            return {
                clientUri: `https://${STAGING_CLARK_DOMAIN}`,
                cardClientUri: `https://caeresource.${STAGING_CLARK_DOMAIN}`,
                clientCookieDomain: STAGING_CLARK_DOMAIN,
                gatewayUri: `https://api.${STAGING_CLARK_DOMAIN}`,
                standardGuidelinesClientUrl: `https://api.${STAGING_CLARK_DOMAIN}`,
                clarkReportsBucketName: "clark-staging-reports",
                clarkFileUploadsBucketName: "clark-staging-file-uploads",
                knowledgeBaseId: "OD56DVFDSD",
                cognitoIdentityPoolId: "us-east-1:3388292f-c48a-4257-aa55-d1816617b38f",
                cognitoAdminIdentityPoolId: "us-east-1:a265148e-7418-4a40-aee2-78f5ae7cbf43",
                clarkDomain: STAGING_CLARK_DOMAIN,
                clarkIssuer: "C.L.A.R.K. - Cybersecurity Labs and Resource Knowledge-base",
            };
        default:
            throw new Error(`Unsupported environment: ${environment}`);
    }
}
