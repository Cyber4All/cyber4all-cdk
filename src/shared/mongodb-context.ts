import { ValidationError } from "aws-cdk-lib";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";
import { Environment } from "./types";

const MONGODB_ATLAS_PROJECT_ID_CONTEXT_KEY_PREFIX = "mongodbAtlasProjectId";
const MONGODB_ATLAS_PROJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;

export function getMongoDBAtlasProjectIdContextKey(environment: Environment): string {
    return `${MONGODB_ATLAS_PROJECT_ID_CONTEXT_KEY_PREFIX}:${environment}`;
}

export function getMongoDBAtlasProjectIdFromContext(
    scope: Construct,
    environment: Environment,
): string | undefined {
    const contextKey = getMongoDBAtlasProjectIdContextKey(environment);
    const contextValue = scope.node.tryGetContext(contextKey);

    if (contextValue === undefined) {
        return undefined;
    }

    if (typeof contextValue !== "string") {
        throw new ValidationError(lit`MongoDBContext`, `${contextKey} must be a string.`, scope);
    }

    const projectId = contextValue.trim();
    if (!projectId || projectId.startsWith("REPLACE_")) {
        return undefined;
    }

    if (!MONGODB_ATLAS_PROJECT_ID_PATTERN.test(projectId)) {
        throw new ValidationError(lit`MongoDBContext`, `${contextKey} must be a 24-character MongoDB Atlas project id.`, scope);
    }

    return projectId;
}
