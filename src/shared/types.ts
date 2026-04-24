export const Environment = {
    PROD: "prod",
    STAGING: "stg",
} as const;

export type Environment = typeof Environment[keyof typeof Environment];