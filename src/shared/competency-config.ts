import { Environment } from "./types";

type CompetencyRuntimeConfig = {
    readonly gatewayUri: string;
    readonly clientUri: string;
    readonly clarkGatewayUri: string;
    readonly lambdaUri: string;
    readonly competencyDomain: string;
};

export function getCompetencyRuntimeConfig(environment: Environment): CompetencyRuntimeConfig {
    switch (environment) {
        case Environment.PROD:
            return {
                gatewayUri: "https://competency-gateway.cybercompetencies.com",
                clientUri: "https://cybercompetencies.com",
                clarkGatewayUri: "https://clark-gateway.clark.center",
                lambdaUri: "https://rpyftcuy3vmb6gleq3edoje3cm0gxaso.lambda-url.us-east-1.on.aws",
                competencyDomain: "cybercompetencies.com",
            };
        case Environment.STAGING:
            return {
                gatewayUri: "https://competency-gateway.yeetbot.click",
                clientUri: "https://cc-ecosystem.yeetbot.click",
                clarkGatewayUri: "https://clark-gateway.yeetbot.click",
                lambdaUri: "https://y3lr757k3zgryh2d3hhutuktbe0godpw.lambda-url.us-east-1.on.aws/",
                competencyDomain: "yeetbot.click",
            };
        default:
            throw new Error(`Unsupported environment: ${environment}`);
    }
}
