import { App } from "aws-cdk-lib";
import {
    AWS_REGION,
    CYBER4ALL_PROD_ACCOUNT_ID,
    CYBER4ALL_STAGING_ACCOUNT_ID,
} from "./constants";
import { ProdStage } from "./stages/prod";
import { StagingStage } from "./stages/staging";

const app = new App();

new StagingStage(app, "staging", {
    env: {
        account: CYBER4ALL_STAGING_ACCOUNT_ID,
        region: AWS_REGION,
    },
});

new ProdStage(app, "prod", {
    env: {
        account: CYBER4ALL_PROD_ACCOUNT_ID,
        region: AWS_REGION,
    },
});

app.synth();
