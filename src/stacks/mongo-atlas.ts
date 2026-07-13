import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { MongoDBCluster } from "../constructs/mongodb-cluster";
import { MongoDBNetwork } from "../constructs/mongodb-network";
import { MongoDBProject } from "../constructs/mongodb-project";
import { getMongoDBAtlasProjectIdFromContext } from "../shared/mongodb-context";
import { getRegionShortName } from "../shared/names";
import { APPLICATION_TAG, ENVIRONMENT_TAG } from "../shared/tags";
import { Environment, getEnvironmentName } from "../shared/types";

export interface MongoAtlasStackProps extends StackProps {
    /**
     * Deployment environment. This is used to name and tag resources appropriately.
     */
    readonly environment: Environment;

    /**
     * VPC to peer with MongoDB Atlas private endpoint.
     */
    readonly vpc: IVpc;
}

// See docs/mongodb-atlas-cloudformation.md for the MongoDB Atlas CloudFormation setup.
// A profile secret in Secrets Manager has to be configured before deploying.
// https://constructs.dev/packages/awscdk-resources-mongodbatlas/v/4.0.0?lang=typescript
export class MongoAtlasStack extends Stack {
    public readonly project: MongoDBProject;
    public readonly clarkCluster: MongoDBCluster;
    public readonly competencyCluster: MongoDBCluster;

    private readonly baseName: string;
    private readonly regionShortName: string;

    constructor(scope: Construct, id: string, props: MongoAtlasStackProps) {
        super(scope, id, props);

        this.baseName = `${props.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(this.region);


        this.project = new MongoDBProject(this, "MongoDBProject", {
            projectName: `${this.baseName}-project`,
            tags: {
                [ENVIRONMENT_TAG]: getEnvironmentName(props.environment),
            }
        });

        const contextProjectId = getMongoDBAtlasProjectIdFromContext(this, props.environment);
        const clusterProjectId = contextProjectId ?? this.project.projectId;

        new CfnOutput(this, "MongoDBProjectId", {
            value: this.project.projectId,
            description: "MongoDB Atlas project id to copy into CDK context for cross-stack Atlas resources.",
        });

        // Creates a flex cluster for non-prod environments and a dedicated
        // cluster for prod to optimize cost while meeting performance needs.
        this.clarkCluster = new MongoDBCluster(this, "ClarkMongoDBCluster", {
            projectId: clusterProjectId,
            clusterName: `${this.baseName}-clark-cluster-${this.regionShortName}`,
            flex: props.environment !== Environment.PROD,
            instanceSize: props.environment === Environment.PROD ? "M10" : undefined,
            tags: [
                { key: ENVIRONMENT_TAG, value: getEnvironmentName(props.environment) },
                { key: APPLICATION_TAG, value: "clark" },
            ],
            removalPolicy: props.environment === Environment.PROD ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        });
        this.competencyCluster = new MongoDBCluster(this, "CompetencyMongoDBCluster", {
            projectId: clusterProjectId,
            clusterName: `${this.baseName}-competency-cluster-${this.regionShortName}`,
            flex: props.environment !== Environment.PROD,
            instanceSize: props.environment === Environment.PROD ? "M10" : undefined,
            tags: [
                { key: ENVIRONMENT_TAG, value: getEnvironmentName(props.environment) },
                { key: APPLICATION_TAG, value: "competency" },
            ],
            removalPolicy: props.environment === Environment.PROD ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        });

        new MongoDBNetwork(this, "MongoDBNetwork", {
            environment: props.environment,
            project: this.project,
            vpc: props.vpc,
            // Allow all ingress in non-prod for ease of development. In prod, only allow from VPC CIDR.
            // allowAllIngress: props.environment !== Environment.PROD,
            allowAllIngress: true, // TODO: Remove this once we have the peering connection working
        });
    }
}
