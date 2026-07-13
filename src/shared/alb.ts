import { ValidationError } from "aws-cdk-lib";
import { ApplicationLoadBalancer, ApplicationProtocol, IApplicationListener } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { lit } from "aws-cdk-lib/core/lib/helpers-internal";
import { Construct } from "constructs";

const listenerRulePriorities = new WeakMap<IApplicationListener, number>();

export function getHttpsListener(scope: Construct, loadBalancer: ApplicationLoadBalancer): IApplicationListener {
    const listener = loadBalancer.listeners.find(
        (candidate) =>
            candidate.port === 443 &&
            candidate.protocol === ApplicationProtocol.HTTPS,
    );

    if (!listener) {
        throw new ValidationError(lit`AlbRouting`, "loadBalancer must include a 443 HTTPS listener.", scope);
    }

    return listener;
}

export function nextListenerRulePriority(listener: IApplicationListener): number {
    const nextPriority = (listenerRulePriorities.get(listener) ?? 0) + 10;
    listenerRulePriorities.set(listener, nextPriority);

    return nextPriority;
}