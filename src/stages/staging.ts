import { Stage, StageProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Environment } from "../shared/types";
import { MongoAtlasStack } from "../stacks/mongo-atlas";

const DOMAIN_NAME = "yeetbot.click";

export class StagingStage extends Stage {
    constructor(scope: Construct, id: string, props?: StageProps) {
        super(scope, id, props);

        const commonProps = { environment: Environment.STAGING };

        // const vpcStack = new VpcStack(this, "VpcStack", { ...commonProps, domainName: DOMAIN_NAME });
        new MongoAtlasStack(this, "MongoAtlasStack", { ...commonProps });
        // new SharedPlatformStack(this, "SharedPlatformStack", { ...commonProps, vpc: vpcStack.vpc });
        // new ClarkStack(this, "ClarkStack");
        // new CompetencyStack(this, "CompetencyStack");
        // new CardStack(this, "CardStack");
    }
}
