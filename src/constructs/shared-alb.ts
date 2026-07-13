import { ArnFormat, Stack, Tags, ValidationError } from "aws-cdk-lib";
import { Certificate, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { IVpc, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import {
    ApplicationListener,
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ListenerAction,
    ListenerCertificate,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";
import { getAcmCertificateIdForDomain } from "../shared/acm-certificates";
import { getRegionShortName } from "../shared/names";
import { NAME_TAG } from "../shared/tags";
import { Environment } from "../shared/types";

export interface SharedAlbProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
    readonly albDomainNames: string[];
}

export class SharedAlb extends Construct {
    public readonly loadBalancer: ApplicationLoadBalancer;
    public readonly httpsListener: ApplicationListener;
    public readonly hostedZones: Record<string, IHostedZone> = {};

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: SharedAlbProps) {
        super(scope, id);

        this.baseName = `${props.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(Stack.of(this).region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);

        const loadBalancerSecurityGroup = new SecurityGroup(this, "LoadBalancerSecurityGroup", {
            vpc: props.vpc,
            securityGroupName: `${this.baseName}-alb-sg-${this.regionShortName}-${this.uniqueSuffix}`,
            description: "Security group for shared ALB",
            allowAllOutbound: true,
        });
        Tags.of(loadBalancerSecurityGroup).add(
            NAME_TAG,
            `${this.baseName}-alb-sg-${this.regionShortName}-${this.uniqueSuffix}`,
        );

        this.loadBalancer = new ApplicationLoadBalancer(this, "LoadBalancer", {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${this.baseName}-alb-${this.regionShortName}-${this.uniqueSuffix}`,
            securityGroup: loadBalancerSecurityGroup,
        });

        const certificates = this.importCertificates(props.albDomainNames);
        if (certificates.length === 0) {
            throw new ValidationError(lit`SharedAlb`, "At least one domain name is required for the shared ALB.", this);
        }

        const [primaryCertificate, ...additionalCertificates] = certificates;

        this.httpsListener = this.loadBalancer.addListener("HttpsListener", {
            port: 443,
            protocol: ApplicationProtocol.HTTPS,
            certificates: [primaryCertificate],
            defaultAction: ListenerAction.fixedResponse(404, {
                contentType: "text/plain",
                messageBody: "Not Found",
            }),
            open: true,
        });

        if (additionalCertificates.length > 0) {
            this.httpsListener.addCertificates(
                "AdditionalCertificates",
                additionalCertificates.map((certificate) =>
                    ListenerCertificate.fromCertificateManager(certificate),
                ),
            );
        }

        this.loadBalancer.addListener("HttpRedirectListener", {
            port: 80,
            protocol: ApplicationProtocol.HTTP,
            defaultAction: ListenerAction.redirect({
                protocol: ApplicationProtocol.HTTPS,
                port: "443",
                permanent: true,
            }),
            open: true,
        });
    }

    private importCertificates(domainNames: string[]): ICertificate[] {
        const uniqueDomains = Array.from(new Set(domainNames.filter(Boolean)));

        return uniqueDomains.map((domainName, index) => {
            const hostedZone = HostedZone.fromLookup(this, `AlbHostedZone${index}`, {
                domainName,
            });

            this.hostedZones[domainName] = hostedZone;

            const certificateId = getAcmCertificateIdForDomain(domainName);
            if (!certificateId) {
                throw new ValidationError(lit`AcmCertificate`, `No ACM certificate ID is configured for domain name ${domainName}.`, this);
            }

            return Certificate.fromCertificateArn(this, `AlbCertificate${index}`, Stack.of(this).formatArn({
                service: "acm",
                resource: "certificate",
                resourceName: certificateId,
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            }));
        });
    }
}
