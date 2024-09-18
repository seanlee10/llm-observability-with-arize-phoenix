import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class PhoenixDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    /*****************************
     ------------ S3 -------------
    *****************************/
     const bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    /*****************************
     ------------ VPC ------------
    *****************************/
    const vpc = new ec2.Vpc(this, "VPC", {
      maxAzs: 2,
      vpcName: `phoenix-demo-vpc`,
    });

    /*****************************
     ------------ RDS ------------
    *****************************/
    const dbCredential = new secretsmanager.Secret(this, 'DBCredentialsSecret', {
      secretName: `phoenix-demo-db-credential`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    const dbHost = dbCredential.secretValueFromJson("host").unsafeUnwrap();
    const dbPassword = dbCredential.secretValueFromJson("password").unsafeUnwrap();

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: vpc, // use the vpc created above
      allowAllOutbound: true, // allow outbound traffic to anywhere
      securityGroupName: 'phoenix-demo-db-sg'
    });

    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432), // allow inbound traffic on port 5432 (postgres)
      'allow inbound traffic within vpc to the db on port 5432'
    )

    const dbCluster = new rds.DatabaseCluster(this, 'Database', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2
      }),
      writer: rds.ClusterInstance.serverlessV2('writer', {
        autoMinorVersionUpgrade: true,
        publiclyAccessible: false,
        enablePerformanceInsights: false,
        instanceIdentifier: 'phoenix-demo-db-instance-1',
      }),
      credentials: rds.Credentials.fromSecret(dbCredential),
      clusterIdentifier: 'phoenix-demo-db',
      defaultDatabaseName: 'postgres',
      securityGroups: [dbSecurityGroup],
      serverlessV2MinCapacity: 2,
      serverlessV2MaxCapacity: 16,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      backup: {
        retention: cdk.Duration.days(1),
        preferredWindow: '03:15-03:45',
      }
    });

    /*****************************
     ------------ IAM ------------
    *****************************/
    // ECS Task Role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'));
    taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    taskRole.addToPolicy(new iam.PolicyStatement({
      resources: [dbCredential.secretArn],
      actions: ['secretsmanager:GetSecretValue']
    }))

    // ECS Task Execution Role
    const executionRole = new iam.Role(this, 'TaskExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    executionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryFullAccess'));
    executionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'));

    /*****************************
     ------------ ECS ------------
    *****************************/
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: `phoenix-demo-cluster` });
    const logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: '/ecs/phoenix-demo',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
  
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 4096,
      cpu: 2048,
      taskRole,
      executionRole,
    });

    taskDefinition.node.addDependency(dbCredential)
    taskDefinition.node.addDependency(dbCluster)

    taskDefinition.addContainer('Gradio', {
      containerName: 'gradio',
      image: ecs.ContainerImage.fromRegistry('PLACEHOLDER_PLEASE_REPLACE_WITH_YOUR_IMAGE'),
      
      portMappings: [{ containerPort: 7860 }],
      essential: true,
      environment: {
        MODEL_ID: 'anthropic.claude-3-5-sonnet-20240620-v1:0'
      },
      logging: new ecs.AwsLogDriver({
        logGroup: logGroup,
        streamPrefix: 'gradio'
      })
    });

    taskDefinition.addContainer('Phoenix', {
      containerName: 'phoenix',
      image: ecs.ContainerImage.fromRegistry('arizephoenix/phoenix:version-4.26.0'),
      portMappings: [{ containerPort: 6006 }],
      essential: true,
      environment: {
        PHOENIX_SQL_DATABASE_URL: `postgresql://postgres:${dbPassword}@${dbHost}:5432/postgres`
      },
      logging: new ecs.AwsLogDriver({
        logGroup: logGroup,
        streamPrefix: 'phoenix'
      })
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      serviceName: `phoenix-demo-service`,
    });

    const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc,
      crossZoneEnabled: true,
      internetFacing: true,
    });

    lb.logAccessLogs(bucket, 'alb-access-logs');

    const listener1 = lb.addListener('Gradio', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP
    });
    listener1.addTargets('Gradio', { 
      targets: [
        service.loadBalancerTarget({
          containerName: 'gradio',
          containerPort: 7860,
        })
      ],
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP
    });

    const listener2 = lb.addListener('Phoenix', {
      port: 6006,
      protocol: elbv2.ApplicationProtocol.HTTP
    });
    listener2.addTargets('Phoenix', { 
      healthCheck: {
        path: "/healthz"
      },
      targets: [
        service.loadBalancerTarget({
          containerName: 'phoenix',
          containerPort: 6006
        })
      ],
      port: 6006,
      protocol: elbv2.ApplicationProtocol.HTTP
    });

    /*****************************
     ---- SageMaker Notebook -----
    *****************************/
    const notebookRole = new iam.Role(this, 'SageMakerNotebookRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
      ],
    });

    notebookRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'secretsmanager:GetSecretValue'
      ],
      resources: [
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0',
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0',
        dbCredential.secretArn
      ],
    }));

    const notebookSecurityGroup = new ec2.SecurityGroup(this, 'NotebookSecurityGroup', {
      vpc: vpc, // use the vpc created above
      allowAllOutbound: true, // allow outbound traffic to anywhere
      securityGroupName: 'phoenix-demo-notebook-sg'
    });

    notebookSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443), // allow inbound traffic on port 443 (https)
      'allow inbound traffic from anywhere to the notebook on port 443'
    )

    // Create the SageMaker notebook instance
    new sagemaker.CfnNotebookInstance(this, 'SageMakerNotebook', {
      instanceType: 'ml.t3.medium',
      roleArn: notebookRole.roleArn,
      notebookInstanceName: `phoenix-demo-notebook`,
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroupIds: [notebookSecurityGroup.securityGroupId],
      rootAccess: "Disabled"
    });
  }
}
