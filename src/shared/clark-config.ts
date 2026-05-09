import { Environment } from "./types";

type ClarkRuntimeConfig = {
    readonly clientUri: string;
    readonly clientCookieDomain: string;
    readonly gatewayUri: string;
    readonly standardGuidelinesClientUrl: string;
    readonly clarkReportsBucketName: string;
    readonly clarkFileUploadsBucketName: string;
    readonly knowledgeBaseId?: string;
    readonly cognitoIdentityPoolId: string;
    readonly cognitoAdminIdentityPoolId: string;
    readonly clarkDomain: string;
};

export function getClarkRuntimeConfig(environment: Environment): ClarkRuntimeConfig {
    switch (environment) {
        case Environment.PROD:
            return {
                clientUri: "https://clark.center",
                clientCookieDomain: "clark.center",
                gatewayUri: "https://clark-gateway.clark.center",
                standardGuidelinesClientUrl: "https://clark-gateway.clark.center",
                clarkReportsBucketName: "clark-reports",
                clarkFileUploadsBucketName: "clark-prod-file-uploads",
                knowledgeBaseId: "OD56DVFDSD",
                cognitoIdentityPoolId: "us-east-1:1ad4e60a-9773-4a67-92b5-6cc2c7b3328f",
                cognitoAdminIdentityPoolId: "us-east-1:6691336e-11a1-48db-9774-5f5a2c8dc270",
                clarkDomain: "clark.center",
            };
        case Environment.STAGING:
            return {
                clientUri: "https://clarkcenter.yeetbot.click",
                clientCookieDomain: "yeetbot.click",
                gatewayUri: "https://clark-gateway.yeetbot.click",
                standardGuidelinesClientUrl: "https://clark-gateway.yeetbot.click",
                clarkReportsBucketName: "clark-staging-reports",
                clarkFileUploadsBucketName: "clark-staging-file-uploads",
                cognitoIdentityPoolId: "us-east-1:3388292f-c48a-4257-aa55-d1816617b38f",
                cognitoAdminIdentityPoolId: "us-east-1:a265148e-7418-4a40-aee2-78f5ae7cbf43",
                clarkDomain: "yeetbot.click",
            };
        default:
            throw new Error(`Unsupported environment: ${environment}`);
    }
}
