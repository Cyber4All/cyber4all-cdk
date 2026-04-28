import { CfnProject } from "awscdk-resources-mongodbatlas";
import { Construct } from "constructs";
import { MONGODB_ATLAS_ORG_ID } from "../constants";
import { DEFAULT_MONGODB_PROJECT_TAGS } from "../shared/tags";

export interface MongoDBProjectProps {
    /**
     * Atlas CloudFormation profile name.
     * 
     * @default "default"
     */
    profile?: string;

    /**
     * Atlas project name.
     * This must be unique across all Atlas projects in the same organization.
     */
    projectName: string;

    /**
     * Optional tags to add to the Atlas project. These will be merged with 
     * default tags added by the CDK.
     * 
     * @default DEFAULT_MONGODB_PROJECT_TAGS
     */
    tags?: Record<string, string>;
}

export class MongoDBProject extends Construct {
    public readonly profile: string;
    public readonly projectId: string;

    constructor(scope: Construct, id: string, props: MongoDBProjectProps) {
        super(scope, id);

        this.profile = props.profile ?? "default";

        const tags = {
            ...DEFAULT_MONGODB_PROJECT_TAGS,
            ...props.tags,
        }

        const project = new CfnProject(this, "Project", {
            profile: this.profile,
            name: props.projectName,
            orgId: MONGODB_ATLAS_ORG_ID,
            projectSettings: {
                isCollectDatabaseSpecificsStatisticsEnabled: true,
                isDataExplorerEnabled: true,
                isPerformanceAdvisorEnabled: true,
                isSchemaAdvisorEnabled: true,
                isRealtimePerformancePanelEnabled: true,
            },
            tags: tags
        });

        this.projectId = project.attrId;
    }
}