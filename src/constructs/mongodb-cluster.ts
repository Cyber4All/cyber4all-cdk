import { Fn, RemovalPolicy, SecretValue, Stack, Token, ValidationError } from "aws-cdk-lib";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import {
    CfnCluster,
    CfnFlexCluster,
    Tag
} from "awscdk-resources-mongodbatlas";
import { Construct } from "constructs";
import { getAtlasRegionName } from "../shared/names";
import { DEFAULT_MONGODB_CLUSTER_TAGS } from "../shared/tags";

export interface IMongoDBCluster {
    /**
     * Atlas CloudFormation profile name.
     *
     * This maps to the SecretsManager secret:
     * cfn/atlas/profile/{profile}
     */
    readonly profile: string;

    /**
     * Atlas project id where the cluster exists.
     */
    readonly projectId: string;

    /**
     * Atlas cluster name.
     */
    readonly clusterName: string;

    /**
     * Secret containing MongoDB connection details.
     */
    readonly connectionSecret: ISecret;
}

export interface MongoDBClusterProps {
    /**
     * Existing Atlas project id.
     *
     * Use this when the Atlas project is managed outside this construct
     * or shared by multiple clusters.
     */
    readonly projectId: string;

    /**
     * Atlas cluster name.
     */
    readonly clusterName: string;

    /**
     * Whether to create a Flex cluster instead of a standard dedicated cluster.
     */
    readonly flex?: boolean;

    /**
     * Setting for standard dedicated clusters. Ignored if `flex` is true.
     * Required if `flex` is false or undefined.
     * 
     * Example:
     * M10, M20, M30
     * @default - M10 for standard dedicated clusters, not applicable for Flex clusters.
     */
    readonly instanceSize?: string;

    /**
     * Storage capacity available to the cluster expressed in gigabytes.
     * 
     * @default - 10 GB for both standard dedicated and Flex clusters.
     */
    readonly diskSizeGb?: number;

    /**
     * Optional MongoDB major version for the cluster. Only for standard dedicated clusters.
     * Example: "8"
     * 
     * @default - The latest support MongoDB major version will be used.
     */
    readonly mongoDbMajorVersion?: string;

    /**
     * Whether to retain Atlas resources when the stack is destroyed.
     */
    readonly removalPolicy?: RemovalPolicy;

    /**
     * Optional tags to apply to the cluster.
     * 
     * @default - DEFAULT_MONGODB_TAGS are applied by default. Additional tags provided here will be added to the defaults.
     */
    readonly tags?: Tag[];
}

export class MongoDBCluster extends Construct implements IMongoDBCluster {
    public readonly profile: string;
    public readonly projectId: string;
    public readonly clusterName: string;
    public readonly connectionSecret: ISecret;

    public readonly cluster: CfnCluster | CfnFlexCluster;

    constructor(scope: Construct, id: string, props: MongoDBClusterProps) {
        super(scope, id);

        this.profile = "default";
        this.clusterName = props.clusterName;

        if (!props.projectId) {
            throw new ValidationError(lit`MongoDBCluster`, "projectId must be provided.", this);
        }

        if (!props.flex && !props.instanceSize) {
            throw new ValidationError(lit`MongoDBCluster`, "instanceSize is required when flex is false.", this);
        }

        if (props.flex && props.instanceSize) {
            throw new ValidationError(lit`MongoDBCluster`, "instanceSize cannot be specified when flex is true.", this);
        }

        if (props.flex && props.mongoDbMajorVersion) {
            throw new ValidationError(lit`MongoDBCluster`, "mongoDbMajorVersion cannot be specified when flex is true.", this);
        }

        this.projectId = props.projectId;

        // Set the Atlas region name based on the construct's region.
        const stack = Stack.of(this);
        const region = stack.region;
        const atlasRegionName = getAtlasRegionName(region);

        const tags: Tag[] = props.tags ? [...DEFAULT_MONGODB_CLUSTER_TAGS, ...props.tags] : DEFAULT_MONGODB_CLUSTER_TAGS;

        this.cluster = this.createCluster(props, atlasRegionName, tags);

        if (props.removalPolicy === RemovalPolicy.RETAIN) {
            this.cluster.applyRemovalPolicy(RemovalPolicy.RETAIN);
        }

        this.connectionSecret = new Secret(this, "ConnectionSecret", {
            secretName: `/cyber4all/mongodb/${props.clusterName}/connection`,
            description: `Connection details for MongoDB Atlas cluster ${props.clusterName}`,
            secretStringValue: SecretValue.unsafePlainText(
                stack.toJsonString({
                    MONGODB_URI: this.buildConnectionUri(),
                    CLUSTER_NAME: this.clusterName,
                    PROJECT_ID: this.projectId,
                }),
            ),
            removalPolicy: RemovalPolicy.DESTROY,
        });

        this.connectionSecret.node.addDependency(this.cluster);

        // Create a backup
    }

    private createCluster(props: MongoDBClusterProps, regionName: string, tags: Tag[]): CfnFlexCluster | CfnCluster {
        const diskSizeGb = props.diskSizeGb ?? 10;
        const instanceSize = props.instanceSize ?? "M10";

        if (props.flex) {
            return new CfnFlexCluster(this, "FlexCluster", {
                profile: this.profile,
                projectId: this.projectId,
                name: props.clusterName,
                providerSettings: {
                    backingProviderName: "AWS",
                    regionName,
                    diskSizeGb,
                },
                backupSettings: {
                    enabled: true,
                },
                terminationProtectionEnabled: props.removalPolicy === RemovalPolicy.RETAIN,
                tags: tags,
            });
        }

        return new CfnCluster(this, "Cluster", {
            profile: this.profile,
            projectId: this.projectId,
            name: props.clusterName,

            // TODO: In the future, we may want to consider using `versionReleaseSystem`: CONTINUOUS
            // to offload MongoDB version management to Atlas. For now, we will specify the major 
            // version to avoid unexpected version upgrades.
            mongoDbMajorVersion: props.mongoDbMajorVersion,

            // Configures backups and point-in-time recovery for the cluster.
            backupEnabled: true,
            pitEnabled: true,
            diskSizeGb: diskSizeGb,

            // Configures the replica sets used by the cluster
            clusterType: "REPLICASET",
            replicationSpecs: [{
                numShards: 1,
                advancedRegionConfigs: [{
                    regionName,
                    priority: 7,
                    autoScaling: {
                        compute: {
                            enabled: true,
                            scaleDownEnabled: true,
                        },
                        diskGb: {
                            enabled: true,
                        },
                    },

                    // This provisions 3-node replica sets in the specified region.
                    // Two will be read replicas and one will be the primary. This
                    // means any of the read replicas can be promoted to the primary
                    // if the current primary fails, providing high availability.
                    electableSpecs: {
                        ebsVolumeType: "STANDARD",
                        instanceSize,
                        nodeCount: 3,
                    },
                }],
            }],
            terminationProtectionEnabled: props.removalPolicy === RemovalPolicy.RETAIN,
            tags: tags,
        });
    }

    /**
     * Constructs the MongoDB connection URI using CloudFormation intrinsic functions to reference 
     * the cluster's connection string attribute.
     * 
     * @returns a MongoDB connection URI for IAM authentication that can be used in the application.
     */
    private buildConnectionUri(): string {
        const standardSrvConnectionString = Token.asString(this.cluster.getAtt("ConnectionStrings.StandardSrv"))

        return Fn.join("", [
            standardSrvConnectionString,
            "/",
            // Encode the $ in the authSource query parameter since CloudFormation
            // does not allow literal $ characters in strings.
            "?authSource=%24external",
            "&authMechanism=MONGODB-AWS",
            `&appName=${encodeURIComponent(this.clusterName)}`,
        ]);
    }
}
