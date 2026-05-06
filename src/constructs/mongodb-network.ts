// Sets up Private Endpoint service for the MongoDB Atlas Project.
// this allows us to privately communicate between our AWS resources

import { Stack } from "aws-cdk-lib";
import { CfnVPCEndpoint, IVpc, Peer, Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { CfnPrivateEndpointAws, CfnPrivateEndpointService, CfnPrivateEndpointServicePropsCloudProvider, CfnProjectIpAccessList } from "awscdk-resources-mongodbatlas";
import { Construct } from "constructs";
import { getAtlasRegionName, getRegionShortName } from "../shared/names";
import { NAME_TAG } from "../shared/tags";
import { Environment } from "../shared/types";
import { MongoDBProject } from "./mongodb-project";

export interface MongoDBNetworkProps {
    /**
     * Deployment environment. This is used to name and tag resources appropriately.
     */
    readonly environment: Environment;

    /**
     * MongoDB Atlas project to create the private endpoint in.
     */
    readonly project: MongoDBProject;

    /**
     * VPC to peer with MongoDB Atlas private endpoint.
     */
    readonly vpc: IVpc;

    /**
     * Whether to allow all ingress traffic to the MongoDB Project using
     * IP whitelisting.
     * 
     * @default false
     */
    readonly allowAllIngress?: boolean;
}

export class MongoDBNetwork extends Construct {
    public readonly profile: string;

    private readonly baseName: string;
    private readonly regionShortName: string;

    constructor(scope: Construct, id: string, props: MongoDBNetworkProps) {
        super(scope, id);

        const stack = Stack.of(this);
        const region = stack.region;

        this.profile = "default";
        this.baseName = `${props.environment}-cyber4all-mongo-endpoint`;
        this.regionShortName = getRegionShortName(region);


        if (props.allowAllIngress) {
            // Flex clusters don't support private endpoints so we will allow all ingress from
            // 0.0.0.0/0 in the non-prod environments to allow connectivity without needing to
            // set up a peering connection.
            new CfnProjectIpAccessList(this, "AllowAllIngress", {
                profile: this.profile,
                projectId: props.project.projectId,
                accessList: [{
                    // TODO: In the future, if we wanted to restrict based on security group. We could setup a peering
                    // connection between the VPC and Atlas and then whitelist the security group here instead of allowing
                    // all ingress from the entire internet.
                    cidrBlock: "0.0.0.0/0",
                    comment: "Allow all ingress traffic for development and testing"
                }],
            });
            return;
        }

        const endpointService = new CfnPrivateEndpointService(this, "MongoPrivateEndpointService", {
            profile: this.profile,
            projectId: props.project.projectId,
            region: getAtlasRegionName(region),
            cloudProvider: CfnPrivateEndpointServicePropsCloudProvider.AWS,
        });

        const securityGroup = new SecurityGroup(this, "MongoEndpointSecurityGroup", {
            vpc: props.vpc,
            securityGroupName: `${this.baseName}-sg-${this.regionShortName}`,
            description: "Security group for MongoDB Atlas private endpoint",
        });
        for (const subnet of props.vpc.privateSubnets) {
            securityGroup.addIngressRule(Peer.ipv4(subnet.ipv4CidrBlock), Port.tcp(27017), "Allow MongoDB Atlas traffic from VPC private subnet");
        }

        const vpcEndpoint = new CfnVPCEndpoint(this, "AwsVpcEndpoint", {
            vpcId: props.vpc.vpcId,
            vpcEndpointType: "Interface",
            privateDnsEnabled: true,
            serviceName: endpointService.attrEndpointServiceName,
            subnetIds: props.vpc.privateSubnets.map(subnet => subnet.subnetId),
            securityGroupIds: [securityGroup.securityGroupId],
            tags: [
                { key: NAME_TAG, value: `${this.baseName}-${this.regionShortName}` }
            ]
        });

        new CfnPrivateEndpointAws(this, "MongoPrivateEndpoint", {
            profile: this.profile,
            projectId: props.project.projectId,
            endpointServiceId: endpointService.ref,
            id: vpcEndpoint.ref,
            enforceConnectionSuccess: true,
        });
    }
}