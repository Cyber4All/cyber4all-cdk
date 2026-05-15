import { Size, Stack, Tags } from "aws-cdk-lib";
import { IConnectable, IVpc, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import {
    CapacityOptionType,
    Cluster,
    ContainerInsights,
    InstanceMonitoring,
    ManagedInstancesCapacityProvider,
} from "aws-cdk-lib/aws-ecs";
import { InstanceProfile, ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { getRegionShortName } from "../shared/names";
import { NAME_TAG } from "../shared/tags";
import { Environment } from "../shared/types";

const EPHEMERAL_PORT_RANGE = Port.tcpRange(32768, 65535);
const DEFAULT_MIN_VCPU = 2;
const DEFAULT_MIN_MEMORY_MIB = 4096;

export interface EcsClusterProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
}

export class EcsCluster extends Construct {
    public readonly cluster: Cluster;
    public readonly capacityProvider: ManagedInstancesCapacityProvider;
    public readonly capacityProviderSecurityGroup: SecurityGroup;

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
            containerInsightsV2: ContainerInsights.ENABLED,
        });

        this.capacityProviderSecurityGroup = new SecurityGroup(this, "ManagedInstancesSecurityGroup", {
            vpc: props.vpc,
            securityGroupName: `${this.baseName}-ecs-managed-sg-${this.regionShortName}-${this.uniqueSuffix}`,
            description: "Security group for ECS managed instances",
            allowAllOutbound: true,
        });
        Tags.of(this.capacityProviderSecurityGroup).add(
            NAME_TAG,
            `${this.baseName}-ecs-managed-sg-${this.regionShortName}-${this.uniqueSuffix}`,
        );
        this.capacityProviderSecurityGroup.addIngressRule(
            this.capacityProviderSecurityGroup,
            EPHEMERAL_PORT_RANGE,
            "Allow ECS managed instances to communicate",
        );

        const instanceRole = new Role(this, "ManagedInstancesRole", {
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2ContainerServiceforEC2Role"),
                ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
            ],
        });

        const instanceProfile = new InstanceProfile(this, "ManagedInstancesInstanceProfile", {
            role: instanceRole,
            // Requires prefixing the instance profile name with "ecsInstanceRole-" to be recognized by ECS as a valid instance profile for managed instances
            instanceProfileName: `ecsInstanceRole-${this.baseName}-${this.regionShortName}-${this.uniqueSuffix}`,
        });

        const infrastructureRole = new Role(this, "ManagedInstancesInfrastructureRole", {
            roleName: `${this.baseName}-ecs-managed-infra-${this.regionShortName}-${this.uniqueSuffix}`,
            assumedBy: new ServicePrincipal("ecs.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName("AmazonECSInfrastructureRolePolicyForManagedInstances"),
            ],
        });

        const capacityOptionType =
            props.environment === Environment.PROD ? CapacityOptionType.ON_DEMAND : CapacityOptionType.SPOT;

        this.capacityProvider = new ManagedInstancesCapacityProvider(this, "ManagedInstancesCapacityProvider", {
            capacityProviderName: `${this.baseName}-mi-capacity-${this.regionShortName}-${this.uniqueSuffix}`,
            infrastructureRole,
            ec2InstanceProfile: instanceProfile,
            subnets: props.vpc.privateSubnets,
            securityGroups: [this.capacityProviderSecurityGroup],
            instanceRequirements: {
                vCpuCountMin: DEFAULT_MIN_VCPU,
                memoryMin: Size.mebibytes(DEFAULT_MIN_MEMORY_MIB),
            },
            monitoring: InstanceMonitoring.BASIC,
            capacityOptionType,
        });

        this.cluster.addManagedInstancesCapacityProvider(this.capacityProvider);
        // CDK does not mark managed instances as EC2 capacity yet, so flag it explicitly for EC2 services.
        (this.cluster as unknown as { _hasEc2Capacity: boolean })._hasEc2Capacity = true;
        this.cluster.addDefaultCapacityProviderStrategy([
            {
                capacityProvider: this.capacityProvider.capacityProviderName,
                weight: 1,
            },
        ]);
    }

    public allowIngressFromSharedAlb(loadBalancer: IConnectable): void {
        this.capacityProviderSecurityGroup.connections.allowFrom(
            loadBalancer,
            EPHEMERAL_PORT_RANGE,
            "Allow shared ALB traffic to ECS instances",
        );
    }
}
