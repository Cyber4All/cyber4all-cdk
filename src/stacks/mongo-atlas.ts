import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { MongoDBCluster } from "../constructs/mongodb-cluster";
import { MongoDBProject } from "../constructs/mongodb-project";
import { getRegionShortName } from "../shared/names";
import { ENVIRONMENT_TAG } from "../shared/tags";
import { Environment, getEnvironmentName } from "../shared/types";

export interface MongoAtlasStackProps extends StackProps {
    /**
     * Deployment environment. This is used to name and tag resources appropriately.
     */
    readonly environment: Environment;
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
        // set a larger cluster size.
        this.cluster = new MongoDBCluster(this, "MongoDBCluster", {
            projectId: this.project.projectId,
            clusterName: `${this.baseName}-cluster-${this.regionShortName}`,
            flex: props.environment !== Environment.PROD,
            tags: [
                { key: ENVIRONMENT_TAG, value: getEnvironmentName(props.environment) },
            ],
            removalPolicy: props.environment === Environment.PROD ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        });
    }
}
