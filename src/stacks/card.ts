import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

export class CardStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);
    }
}
