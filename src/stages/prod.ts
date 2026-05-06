import { Stage, StageProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Environment } from "../shared/types";
import { CardStack } from "../stacks/card";
import { ClarkStack } from "../stacks/clark";
import { CompetencyStack } from "../stacks/competency";
import { MongoAtlasStack } from "../stacks/mongo-atlas";
import { SharedPlatformStack } from "../stacks/shared-platform";
import { VpcStack } from "../stacks/vpc";

const DOMAIN_NAME = "clark.center";

export class ProdStage extends Stage {
    constructor(scope: Construct, id: string, props?: StageProps) {
        super(scope, id, props);

        const commonProps = { environment: Environment.PROD };

        const vpcStack = new VpcStack(this, "VpcStack", { ...commonProps, domainName: DOMAIN_NAME });
        new MongoAtlasStack(this, "MongoAtlasStack", { ...commonProps, vpc: vpcStack.vpc });
        new SharedPlatformStack(this, "SharedPlatformStack", { ...commonProps, vpc: vpcStack.vpc });
        new ClarkStack(this, "ClarkStack");
        new CompetencyStack(this, "CompetencyStack");
        new CardStack(this, "CardStack");
    }
}
