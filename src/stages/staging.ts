import { Stage, StageProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { getClarkRuntimeConfig } from "../shared/clark-config";
import { getCompetencyRuntimeConfig } from "../shared/competency-config";
import { Environment } from "../shared/types";
import { ClarkStack } from "../stacks/clark";
import { CompetencyStack } from "../stacks/competency";
import { MongoAtlasStack } from "../stacks/mongo-atlas";
import { SharedPlatformStack } from "../stacks/shared-platform";
import { VpcStack } from "../stacks/vpc";

const CLARK_DOMAIN_NAME = getClarkRuntimeConfig(Environment.STAGING).clarkDomain;
const COMPETENCY_DOMAIN_NAME = getCompetencyRuntimeConfig(Environment.STAGING).competencyDomain;

export class StagingStage extends Stage {
    constructor(scope: Construct, id: string, props?: StageProps) {
        super(scope, id, props);

        const commonProps = { environment: Environment.STAGING };

        const vpcStack = new VpcStack(this, "VpcStack", { ...commonProps });

        const mongoAtlasStack = new MongoAtlasStack(this, "MongoAtlasStack", { ...commonProps, vpc: vpcStack.vpc });

        const sharedPlatformStack = new SharedPlatformStack(this, "SharedPlatformStack", {
            ...commonProps,
            vpc: vpcStack.vpc,
            albDomainNames: [CLARK_DOMAIN_NAME, COMPETENCY_DOMAIN_NAME],
        });

        new ClarkStack(this, "ClarkStack", {
            ...commonProps,
            cluster: sharedPlatformStack.cluster.cluster,
            dockerHubSecret: sharedPlatformStack.dockerHubSecret,
            sharedAlb: sharedPlatformStack.sharedAlb,
            googleSecret: sharedPlatformStack.googleSecret,
            sendGridSecret: sharedPlatformStack.sendGridSecret,
            shortcutSecret: sharedPlatformStack.shortcutSecret,
            slackSecret: sharedPlatformStack.slackSecret,
            mongoConnectionSecret: mongoAtlasStack.cluster.connectionSecret,
        });

        new CompetencyStack(this, "CompetencyStack", {
            ...commonProps,
            cluster: sharedPlatformStack.cluster.cluster,
            dockerHubSecret: sharedPlatformStack.dockerHubSecret,
            sharedAlb: sharedPlatformStack.sharedAlb,
            sendGridSecret: sharedPlatformStack.sendGridSecret,
            mongoConnectionSecret: mongoAtlasStack.cluster.connectionSecret,
        });
    }
}
