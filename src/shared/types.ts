export const Environment = {
    PROD: "prod",
    STAGING: "stg",
    DEV: "dev",
} as const;

export type Environment = typeof Environment[keyof typeof Environment];

export function getEnvironmentName(environment: Environment): string {
    switch (environment) {
        case Environment.PROD:
            return "production";
        case Environment.STAGING:
            return "staging";
        case Environment.DEV:
            return "development";
        default:
            throw new Error(`Unknown environment: ${environment}`);
    }
}