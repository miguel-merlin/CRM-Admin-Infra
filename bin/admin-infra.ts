#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AdminInfraStack } from "../lib/admin-infra-stack";
import { devProps, prodProps } from "../config";

const app = new cdk.App();
const envConfigs = [devProps, prodProps];
envConfigs.forEach((envConfig) => {
  if (envConfig.isDeploy) {
    const stackName = envConfig.stackName;
    new AdminInfraStack(app, stackName, {
      ...envConfig,
      description: `CRM Admin Infra Stack for ${envConfig.environmentType}`,
    });
  }
});

app.synth();
