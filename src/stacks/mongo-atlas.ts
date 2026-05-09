import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { MongoDBCluster } from "../constructs/mongodb-cluster";
import { MongoDBNetwork } from "../constructs/mongodb-network";
import { MongoDBProject } from "../constructs/mongodb-project";
import { getRegionShortName } from "../shared/names";
import { ENVIRONMENT_TAG } from "../shared/tags";
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
    public readonly cluster: MongoDBCluster;

    private readonly baseName: string;
    private readonly regionShortName: string;

    constructor(scope: Construct, id: string, props: MongoAtlasStackProps) {
        super(scope, id, props);

        this.baseName = `${props?.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(this.region);


        this.project = new MongoDBProject(this, "MongoDBProject", {
            projectName: `${this.baseName}-project`,
            tags: {
                [ENVIRONMENT_TAG]: getEnvironmentName(props.environment),
            }
        });

        // Creates a flex cluster for non-prod environments and a dedicated
        // cluster for prod to optimize cost while meeting performance needs.
        //
        // TODO: In the future if the storage or compute needs increasing we
        // can update the optional props `diskSizeGb` and `instanceSize` to 
        // set a larger base cluster size.
        this.cluster = new MongoDBCluster(this, "MongoDBCluster", {
            projectId: this.project.projectId,
            clusterName: `${this.baseName}-cluster-${this.regionShortName}`,
            flex: props.environment !== Environment.PROD,
            instanceSize: props.environment === Environment.PROD ? "M10" : undefined,
            tags: [
                { key: ENVIRONMENT_TAG, value: getEnvironmentName(props.environment) },
            ],
            removalPolicy: props.environment === Environment.PROD ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        });

        new MongoDBNetwork(this, "MongoDBNetwork", {
            environment: props.environment,
            project: this.project,
            vpc: props.vpc,
            // Allow all ingress in non-prod for ease of development. In prod, only allow from VPC CIDR.
            allowAllIngress: props.environment !== Environment.PROD,
        });
    }
}
