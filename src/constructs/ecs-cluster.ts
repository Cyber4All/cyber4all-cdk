import { Stack, Tags } from "aws-cdk-lib";
import { AutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import { IConnectable, InstanceType, IVpc, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import {
    AsgCapacityProvider,
    Cluster,
    ContainerInsights,
    EcsOptimizedImage
} from "aws-cdk-lib/aws-ecs";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
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
    public readonly capacityProvider: AsgCapacityProvider;
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

        this.capacityProviderSecurityGroup = new SecurityGroup(this, "AsgSecurityGroup", {
            vpc: props.vpc,
            securityGroupName: `${this.baseName}-asg-sg-${this.regionShortName}-${this.uniqueSuffix}`,
            description: "Security group for ASG instances",
            allowAllOutbound: true,
        });
        Tags.of(this.capacityProviderSecurityGroup).add(
            NAME_TAG,
            `${this.baseName}-asg-sg-${this.regionShortName}-${this.uniqueSuffix}`,
        );
        this.capacityProviderSecurityGroup.addIngressRule(
            this.capacityProviderSecurityGroup,
            EPHEMERAL_PORT_RANGE,
            "Allow ASG instances to communicate",
        );
        this.capacityProviderSecurityGroup.addIngressRule(
            this.capacityProviderSecurityGroup,
            Port.tcp(4317),
            "Allow OTLP gRPC between ASG instances",
        );
        this.capacityProviderSecurityGroup.addIngressRule(
            this.capacityProviderSecurityGroup,
            Port.tcp(4318),
            "Allow OTLP HTTP between ASG instances",
        );
        this.capacityProviderSecurityGroup.addIngressRule(
            this.capacityProviderSecurityGroup,
            Port.tcp(1777),
            "Allow pprof between ASG instances",
        );

        const role = new Role(this, "AsgInstanceRole", {
            roleName: `${this.baseName}-asg-instance-role-${this.regionShortName}-${this.uniqueSuffix}`,
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
        });
        role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2ContainerServiceforEC2Role"));
        role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));

        const autoScalingGroup = new AutoScalingGroup(this, "AutoScalingGroup", {
            autoScalingGroupName: `${this.baseName}-asg-${this.regionShortName}-${this.uniqueSuffix}`,
            vpc: props.vpc,
            instanceType: new InstanceType("t3.medium"),
            machineImage: EcsOptimizedImage.amazonLinux2023(),
            securityGroup: this.capacityProviderSecurityGroup,
            role,
            minCapacity: 0,
            maxCapacity: 5,
        });

        this.capacityProvider = new AsgCapacityProvider(this, "AsgCapacityProvider", {
            capacityProviderName: `${this.baseName}-asg-provider-${this.regionShortName}-${this.uniqueSuffix}`,
            autoScalingGroup,

        });
        this.cluster.addAsgCapacityProvider(this.capacityProvider);
    }

    public allowIngressFromSharedAlb(loadBalancer: IConnectable): void {
        this.capacityProviderSecurityGroup.connections.allowFrom(
            loadBalancer,
            EPHEMERAL_PORT_RANGE,
            "Allow shared ALB traffic to ECS instances",
        );
    }
}
