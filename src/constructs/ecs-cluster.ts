import { Stack } from "aws-cdk-lib";
import { IVpc, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import {
    Cluster,
    ContainerInsights
} from "aws-cdk-lib/aws-ecs";
import { Construct } from "constructs";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";

export interface EcsClusterProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
}

export class EcsCluster extends Construct {
    public readonly cluster: Cluster;
    public readonly serviceSecurityGroup: SecurityGroup;

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: EcsClusterProps) {
        super(scope, id);

        this.baseName = `${props.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(Stack.of(this).region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);

        this.cluster = new Cluster(this, "Cluster", {
            clusterName: `${this.baseName}-cluster-${this.regionShortName}-${this.uniqueSuffix}`,
            vpc: props.vpc,
            defaultCloudMapNamespace: {
                name: `${this.baseName}-namespace-${this.regionShortName}-${this.uniqueSuffix}`,
                useForServiceConnect: true,
            },
            enableFargateCapacityProviders: true,
            containerInsightsV2: ContainerInsights.ENABLED,
        });
    }
}
