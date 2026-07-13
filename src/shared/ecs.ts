import { Port } from "aws-cdk-lib/aws-ec2";

export const EPHEMERAL_PORT_RANGE = Port.tcpRange(32768, 65535);

export function getServiceConnectUri(serviceName: string): string {
    return `http://${serviceName}:3000`;
}

export function getServiceConnectUriWithPort(serviceName: string, port: string): string {
    return `http://${serviceName}:${port}`;
}