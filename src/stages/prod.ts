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

const CLARK_DOMAIN_NAME = getClarkRuntimeConfig(Environment.PROD).clarkDomain;
const COMPETENCY_DOMAIN_NAME = getCompetencyRuntimeConfig(Environment.PROD).competencyDomain;

export class ProdStage extends Stage {
    constructor(scope: Construct, id: string, props?: StageProps) {
        super(scope, id, props);

        const commonProps = { environment: Environment.PROD };

        const vpcStack = new VpcStack(this, "VpcStack", { ...commonProps, domainName: CLARK_DOMAIN_NAME });
        const mongoAtlasStack = new MongoAtlasStack(this, "MongoAtlasStack", { ...commonProps, vpc: vpcStack.vpc });
        const sharedPlatformStack = new SharedPlatformStack(this, "SharedPlatformStack", {
            ...commonProps,
            vpc: vpcStack.vpc,
            albDomainNames: [CLARK_DOMAIN_NAME, COMPETENCY_DOMAIN_NAME],
        });

        new ClarkStack(this, "ClarkStack", {
            ...commonProps,
            cluster: sharedPlatformStack.cluster,
            dockerHubSecret: sharedPlatformStack.dockerHubSecret,
            sharedAlb: sharedPlatformStack.sharedAlb,
            hostedZones: sharedPlatformStack.albHostedZones,
            clarkGatewayHostName: `clark-gateway.${CLARK_DOMAIN_NAME}`,
            clarkSecret: sharedPlatformStack.clarkSecret,
            coralogixSecret: sharedPlatformStack.coralogixSecret,
            googleSecret: sharedPlatformStack.googleSecret,
            sendGridSecret: sharedPlatformStack.sendGridSecret,
            shortcutSecret: sharedPlatformStack.shortcutSecret,
            slackSecret: sharedPlatformStack.slackSecret,
            mongoConnectionSecret: mongoAtlasStack.cluster.connectionSecret,
        });

        new CompetencyStack(this, "CompetencyStack", {
            ...commonProps,
            cluster: sharedPlatformStack.cluster,
            dockerHubSecret: sharedPlatformStack.dockerHubSecret,
            sharedAlb: sharedPlatformStack.sharedAlb,
            hostedZones: sharedPlatformStack.albHostedZones,
            competencyGatewayHostName: `competency-gateway.${COMPETENCY_DOMAIN_NAME}`,
            competencySecret: sharedPlatformStack.competencySecret,
            coralogixSecret: sharedPlatformStack.coralogixSecret,
            sendGridSecret: sharedPlatformStack.sendGridSecret,
            mongoConnectionSecret: mongoAtlasStack.cluster.connectionSecret,
        });
    }
}
