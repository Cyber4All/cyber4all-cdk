import { RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import { FlowLogDestination, IpAddresses, IVpc, Vpc } from "aws-cdk-lib/aws-ec2";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { IHostedZone } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { getRegionShortName } from "../shared/names";
import { NAME_TAG } from "../shared/tags";
import { Environment } from "../shared/types";

export interface VpcStackProps extends StackProps {
    readonly environment: Environment;
}

export class VpcStack extends Stack {
    public readonly vpc: IVpc;
    public readonly logGroup: ILogGroup;
    public readonly hostedZone: IHostedZone;

    private readonly baseName: string;
    private readonly regionShortName: string;

    constructor(scope: Construct, id: string, props: VpcStackProps) {
        super(scope, id, props);

        this.baseName = `${props.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(this.region);

        this.logGroup = new LogGroup(this, "FlowLogs", {
            logGroupName: `/${props.environment}/cyber4all/vpc/flow-logs`,
            retention: RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY
        });

        this.vpc = new Vpc(this, "Vpc", {
            vpcName: `${this.baseName}-vpc-${this.regionShortName}`,
            ipAddresses: IpAddresses.cidr("10.0.0.0/21"),
            natGateways: 1,
            restrictDefaultSecurityGroup: false,
            flowLogs: {
                "AllTraffic": {
                    destination: FlowLogDestination.toCloudWatchLogs(this.logGroup),
                }
            }
        });

        // Rename the subnets to be more identifiable in the AWS console
        this.vpc.publicSubnets.forEach((subnet) => {
            const availabilityZone = subnet.availabilityZone.split("-").at(-1)?.at(1);
            Tags.of(subnet).add(NAME_TAG, `${this.baseName}-public-subnet-${this.regionShortName}${availabilityZone}`);
        });
        this.vpc.privateSubnets.forEach((subnet) => {
            const availabilityZone = subnet.availabilityZone.split("-").at(-1)?.at(1);
            Tags.of(subnet).add(NAME_TAG, `${this.baseName}-private-subnet-${this.regionShortName}${availabilityZone}`);
        });
    }
}
