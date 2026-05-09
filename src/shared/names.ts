import { ValidationError } from "aws-cdk-lib";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";

/**
 * Gets the short name for a given AWS region.
 * @param region The AWS region (e.g., "us-east-1").
 * @returns The short name for the region (e.g., "use1").
 * @throws Error if the region is unsupported.
 */
export function getRegionShortName(region: string): string {
    switch (region) {
        case "us-east-1":
            return "use1";
        case "us-east-2":
            return "use2";
        case "us-west-1":
            return "usw1";
        case "us-west-2":
            return "usw2";
        default:
            throw new Error(`Unsupported region: ${region}`);
    }
}

export function getAtlasRegionName(region: string): string {
    switch (region) {
        case "us-east-1":
            return "US_EAST_1";
        case "us-east-2":
            return "US_EAST_2";
        case "us-west-1":
            return "US_WEST_1";
        case "us-west-2":
            return "US_WEST_2";
        default:
            throw new Error(`Unsupported region: ${region}`);
    }
}

export function getImageName(imageRepository: string, scope: Construct): string {
    const imageWithTag = imageRepository.split("/").pop();
    const imageName = imageWithTag?.split(":")[0];

    if (!imageName) {
        throw new ValidationError(lit`EcsService`, "imageRepository must include an image name.", scope);
    }

    return imageName;
}

export function getRecordName(hostName: string, zoneName: string): string | undefined {
    const normalizedHost = hostName.endsWith(".") ? hostName.slice(0, -1) : hostName;
    if (normalizedHost === zoneName) {
        return undefined;
    }

    const suffix = `.${zoneName}`;
    if (normalizedHost.endsWith(suffix)) {
        return normalizedHost.slice(0, -suffix.length);
    }

    return normalizedHost;
}
