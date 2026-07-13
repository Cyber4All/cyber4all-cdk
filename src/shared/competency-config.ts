import { PROD_CLARK_DOMAIN, STAGING_CLARK_DOMAIN } from "./clark-config";
import { Environment } from "./types";

type CompetencyRuntimeConfig = {
    readonly gatewayUri: string;
    readonly clientUri: string;
    readonly clarkGatewayUri: string;
    readonly lambdaUri: string;
    readonly competencyDomain: string;
    readonly securedAuthIssuer: string;
};

export const PROD_COMPETENCY_DOMAIN = "cybercompetencies.com";
export const STAGING_COMPETENCY_DOMAIN = "staging.cybercompetencies.com";

export function getCompetencyRuntimeConfig(environment: Environment): CompetencyRuntimeConfig {
    switch (environment) {
        case Environment.PROD:
            return {
                gatewayUri: `https://api.${PROD_COMPETENCY_DOMAIN}`,
                clientUri: `https://${PROD_COMPETENCY_DOMAIN}`,
                clarkGatewayUri: `https://api-gateway.${PROD_CLARK_DOMAIN}`, // TODO: Update this to the correct CLARK Gateway URI once old prod is down
                lambdaUri: "https://rpyftcuy3vmb6gleq3edoje3cm0gxaso.lambda-url.us-east-1.on.aws",
                competencyDomain: PROD_COMPETENCY_DOMAIN,
                securedAuthIssuer: "secured-auth-service",
            };
        case Environment.STAGING:
            return {
                gatewayUri: `https://api.${STAGING_COMPETENCY_DOMAIN}`,
                clientUri: `https://${STAGING_COMPETENCY_DOMAIN}`,
                clarkGatewayUri: `https://api.${STAGING_CLARK_DOMAIN}`,
                lambdaUri: "https://y3lr757k3zgryh2d3hhutuktbe0godpw.lambda-url.us-east-1.on.aws/",
                competencyDomain: STAGING_COMPETENCY_DOMAIN,
                securedAuthIssuer: "secured-auth-service",
            };
        default:
            throw new Error(`Unsupported environment: ${environment}`);
    }
}
