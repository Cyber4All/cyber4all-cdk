import { Tag } from "awscdk-resources-mongodbatlas";

export const NAME_TAG = "Name";
export const APPLICATION_TAG = "application";
export const ENVIRONMENT_TAG = "environment";
export const SERVICE_TAG = "service";
export const MANAGED_BY_TAG = "managed-by";
export const REPOSITORY_TAG = "repository";
export const OWNER_TAG = "owner";
export const REPOSITORY_TAG_VALUE = "github.com:cyber4all:cyber4all-cdk";

export const DEFAULT_MONGODB_CLUSTER_TAGS: Tag[] = [
    { key: MANAGED_BY_TAG, value: "aws-cdk" },
    { key: REPOSITORY_TAG, value: REPOSITORY_TAG_VALUE },
    { key: OWNER_TAG, value: "cyber4all" },
    { key: APPLICATION_TAG, value: "shared" },
];

export const DEFAULT_MONGODB_PROJECT_TAGS: Record<string, string> = {
    [MANAGED_BY_TAG]: "aws-cdk",
    [OWNER_TAG]: "cyber4all",
    [APPLICATION_TAG]: "shared",
};
