#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PhoenixDemoStack } from '../lib/phoenix-demo-stack';

const app = new cdk.App();
new PhoenixDemoStack(app, 'PhoenixDemoStack', {
    env: {
        region: 'us-east-1'
    }
});