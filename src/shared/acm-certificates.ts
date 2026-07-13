import { PROD_CLARK_DOMAIN, STAGING_CLARK_DOMAIN } from "./clark-config";
import { PROD_COMPETENCY_DOMAIN, STAGING_COMPETENCY_DOMAIN } from "./competency-config";

export const ACM_CERTIFICATE_IDS_BY_DOMAIN: Record<string, string> = {
    [PROD_CLARK_DOMAIN]: "c30a38b4-5f60-48fc-ab7a-bec6dba487b7",
    [PROD_COMPETENCY_DOMAIN]: "6f428cd6-0d62-49c6-835d-6a3c6465716d",
    [STAGING_COMPETENCY_DOMAIN]: "cdd09980-7430-467c-91ff-a91a8421e40f",
    [STAGING_CLARK_DOMAIN]: "0122d951-8fec-497b-9916-77a54056f4e5",
};

export function getAcmCertificateIdForDomain(domainName: string): string | undefined {
    return ACM_CERTIFICATE_IDS_BY_DOMAIN[domainName];
}
