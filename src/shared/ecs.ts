export function getServiceConnectUri(serviceName: string): string {
    return `http://${serviceName}:3000`;
}