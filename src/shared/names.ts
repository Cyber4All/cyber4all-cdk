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
