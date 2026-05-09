import { RemovalPolicy, Stack, StackProps, ValidationError } from "aws-cdk-lib";
import { Certificate, CertificateValidation, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { InstanceClass, InstanceSize, InstanceType, IVpc } from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerInsights, EcsOptimizedImage, ICluster } from "aws-cdk-lib/aws-ecs";
import {
    ApplicationListener,
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ListenerAction,
    ListenerCertificate,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";
import { getRegionShortName } from "../shared/names";
import { Environment } from "../shared/types";

export interface SharedPlatformStackProps extends StackProps {
    readonly environment: Environment;
    readonly vpc: IVpc;
    readonly albDomainNames: string[];
}

export class SharedPlatformStack extends Stack {
    public readonly cluster: ICluster;
    public readonly sharedAlb: ApplicationLoadBalancer;
    public readonly sharedAlbListener: ApplicationListener;
    public readonly albHostedZones: Record<string, IHostedZone>;

    public readonly dockerHubSecret: ISecret;
    public readonly googleSecret: ISecret;
    public readonly sendGridSecret: ISecret;
    public readonly shortcutSecret: ISecret;
    public readonly coralogixSecret: ISecret;
    public readonly clarkSecret: ISecret;
    public readonly competencySecret: ISecret;
    public readonly slackSecret: ISecret;

    private readonly baseName: string;
    private readonly regionShortName: string;
    private readonly uniqueSuffix: string;

    constructor(scope: Construct, id: string, props: SharedPlatformStackProps) {
        super(scope, id, props);

        this.baseName = `${props?.environment}-cyber4all`;
        this.regionShortName = getRegionShortName(this.region);
        this.uniqueSuffix = this.node.addr.substring(0, 8);
        this.albHostedZones = {};

        this.cluster = new Cluster(this, "EcsCluster", {
            clusterName: `${this.baseName}-cluster-${this.regionShortName}-${this.uniqueSuffix}`,
            vpc: props.vpc,
            capacity: {
                autoScalingGroupName: `${this.baseName}-asg-${this.regionShortName}-${this.uniqueSuffix}`,
                instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
                machineImage: EcsOptimizedImage.amazonLinux2023(),
                maxCapacity: 3,
                ssmSessionPermissions: true
            },
            defaultCloudMapNamespace: {
                name: `${this.baseName}-namespace-${this.regionShortName}-${this.uniqueSuffix}`,
                useForServiceConnect: true
            },
            containerInsightsV2: ContainerInsights.ENABLED
        });

        this.sharedAlb = new ApplicationLoadBalancer(this, "SharedAlb", {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `${this.baseName}-alb-${this.regionShortName}-${this.uniqueSuffix}`,
        });

        const certificates = this.createCertificates(props.albDomainNames);
        if (certificates.length === 0) {
            throw new ValidationError(lit`SharedAlb`, "At least one domain name is required for the shared ALB.", this);
        }

        const [primaryCertificate, ...additionalCertificates] = certificates;

        this.sharedAlbListener = this.sharedAlb.addListener("HttpsListener", {
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
            this.sharedAlbListener.addCertificates(
                "AdditionalCertificates",
                additionalCertificates.map((certificate) =>
                    ListenerCertificate.fromCertificateManager(certificate),
                ),
            );
        }

        this.sharedAlb.addListener("HttpRedirectListener", {
            port: 80,
            protocol: ApplicationProtocol.HTTP,
            defaultAction: ListenerAction.redirect({
                protocol: ApplicationProtocol.HTTPS,
                port: "443",
                permanent: true,
            }),
            open: true,
        });

        // Create secrets in Secrets Manager for the following 3rd party services
        const secretBaseName = `/${props.environment}/cyber4all`;
        this.dockerHubSecret = new Secret(this, "DockerHubSecret", {
            secretName: `${secretBaseName}/dockerhub`,
            description: "Docker Hub credentials for pulling private container images. Should contain 'username' and 'password' fields.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.googleSecret = new Secret(this, "GoogleSecret", {
            secretName: `${secretBaseName}/google`,
            description: "Google credentials for SSO integration.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.sendGridSecret = new Secret(this, "SendGridSecret", {
            secretName: `${secretBaseName}/sendgrid`,
            description: "SendGrid API credentials.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.shortcutSecret = new Secret(this, "ShortcutSecret", {
            secretName: `${secretBaseName}/shortcut`,
            description: "Shortcut API credentials for project and task management integration.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.coralogixSecret = new Secret(this, "CoralogixSecret", {
            secretName: `${secretBaseName}/coralogix`,
            description: "Coralogix API credentials for log aggregation and analysis.",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.clarkSecret = new Secret(this, "ClarkSecret", {
            secretName: `${secretBaseName}/clark`,
            description: "Clark service secrets (SECRET_KEY, GITHUB_ACCESS_TOKEN).",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.competencySecret = new Secret(this, "CompetencySecret", {
            secretName: `${secretBaseName}/competency`,
            description: "Competency service secrets (AWS_API_KEY_SECRET, AWS_JWT_SECRET, AWS_SERVICE_KEY_SECRET, OTA_CODE_SECRET).",
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.slackSecret = new Secret(this, "SlackSecret", {
            secretName: `${secretBaseName}/slack`,
            description: "Slack integration secrets (SLACK_TOKEN, SLACK_URI).",
            removalPolicy: RemovalPolicy.DESTROY
        });
    }

    private createCertificates(domainNames: string[]): ICertificate[] {
        const uniqueDomains = Array.from(new Set(domainNames.filter(Boolean)));

        return uniqueDomains.map((domainName, index) => {
            const hostedZone = HostedZone.fromLookup(this, `AlbHostedZone${index}`, {
                domainName,
            });

            this.albHostedZones[domainName] = hostedZone;

            return new Certificate(this, `AlbCertificate${index}`, {
                domainName,
                subjectAlternativeNames: [`*.${domainName}`],
                validation: CertificateValidation.fromDns(hostedZone),
            });
        });
    }
}
