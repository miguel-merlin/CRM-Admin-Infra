import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import {
  Distribution,
  OriginAccessIdentity,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BuildSpec, LinuxBuildImage, Project } from "aws-cdk-lib/aws-codebuild";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  GitHubSourceAction,
  S3DeployAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { CanonicalUserPrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as dotenv from "dotenv";
import path = require("path");

interface AdminInfraStackProps extends StackProps {
  environmentType: string;
  branch: string;
  pipelineName: string;
  bucketName: string;
  pipelineBucket: string;
  publicAccess: boolean;
  indexFile: string;
  errorFile: string;
  githubRepoOwner: string;
  githubRepoName: string;
  githubAccessToken: string;
}

export class AdminInfraStack extends Stack {
  constructor(scope: Construct, id: string, props: AdminInfraStackProps) {
    super(scope, id, props);

    /*------------------------react deployment---------------------------*/
    const webBucket = this._createWebBucket(props);
    const distribution = this._createCloudFrontDistribution(webBucket);

    /*------------------------codepipeline/cicd--------------------------*/
    const { sourceOutput, sourceAction } = this._createSourceAction(props);
    const { buildOutput, buildProject } =
      this._createBuildProject(distribution);
    const buildAction = this._createBuildAction(
      buildProject,
      sourceOutput,
      buildOutput
    );
    const deployAction = this._createDeployAction(buildOutput, webBucket);
    this._createPipeline(
      deployAction,
      sourceAction,
      buildAction,
      props,
      webBucket,
      distribution
    );
    this._outCloudfrontURL(distribution);
    this._outS3BucketURL(webBucket);
  }

  /*--------------------------react deployment---------------------------*/
  private _createWebBucket(props: AdminInfraStackProps) {
    const { bucketName, indexFile, errorFile, publicAccess } = props;

    const webBucket = new Bucket(this, bucketName, {
      websiteIndexDocument: indexFile,
      websiteErrorDocument: errorFile,
      publicReadAccess: publicAccess,
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: BlockPublicAccess.BLOCK_ACLS,
      accessControl: BucketAccessControl.BUCKET_OWNER_FULL_CONTROL,
      encryption: BucketEncryption.S3_MANAGED,
    });

    return webBucket;
  }

  private _createCloudFrontDistribution(bucket: Bucket) {
    const oai = new OriginAccessIdentity(this, "OAI");
    bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("*")],
        principals: [
          new CanonicalUserPrincipal(
            oai.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    );

    const s3Origin = new S3Origin(bucket, {
      originAccessIdentity: oai,
    });

    const distribution = new Distribution(
      this,
      "crm-admin-deployment-distribution",
      {
        defaultBehavior: {
          origin: s3Origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        defaultRootObject: "index.html",
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 404,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(300),
          },
          {
            httpStatus: 403,
            responseHttpStatus: 500,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(300),
          },
        ],
        priceClass: PriceClass.PRICE_CLASS_100,
      }
    );

    return distribution;
  }

  /*--------------------------codepipeline/cicd---------------------------*/
  private _createSourceAction(props: AdminInfraStackProps) {
    const { githubRepoOwner, githubRepoName, githubAccessToken, branch } =
      props;
    const sourceOutput = new Artifact();
    const sourceAction = new GitHubSourceAction({
      actionName: "GitHub",
      owner: githubRepoOwner,
      repo: githubRepoName,
      branch: branch,
      oauthToken: SecretValue.secretsManager(githubAccessToken),
      output: sourceOutput,
    });

    return {
      sourceOutput,
      sourceAction,
    };
  }

  private _createBuildProject(distribution: Distribution) {
    const envVarianbles = loadEnvFile();
    const buildOutput = new Artifact();
    const buildProject = new Project(this, "crm-admin-codebuild-project", {
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": {
              nodejs: "latest",
            },
            commands: ['echo "installing npm dependencies"', "npm install"],
          },
          build: {
            commands: ['echo "building app"', "npm run build"],
          },
          post_build: {
            commands: [
              'echo "creating cloudfront invalidation"',
              `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths '/*'`,
            ],
          },
        },
        artifacts: {
          "base-directory": "dist",
          files: ["**/*"],
        },
      }),
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
        privileged: true,
        environmentVariables: {
          ...envVarianbles,
        },
      },
    });

    buildProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      })
    );

    buildProject.addToRolePolicy(
      new PolicyStatement({
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [buildProject.projectArn],
      })
    );

    return {
      buildOutput,
      buildProject,
    };
  }

  private _createBuildAction(
    buildProject: Project,
    sourceOutput: Artifact,
    buildOutput: Artifact
  ) {
    const buildAction = new CodeBuildAction({
      actionName: "CodeBuild",
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    return buildAction;
  }

  private _createDeployAction(buildOutput: Artifact, bucket: Bucket) {
    const deployAction = new S3DeployAction({
      actionName: "DeployToS3",
      input: buildOutput,
      bucket: bucket,
    });

    return deployAction;
  }

  private _createPipeline(
    deployAction: S3DeployAction,
    sourceAction: GitHubSourceAction,
    buildAction: CodeBuildAction,
    props: AdminInfraStackProps,
    bucket: Bucket,
    distribution: Distribution
  ) {
    const { pipelineName } = props;

    const stages = [
      { stageName: "Source", actions: [sourceAction] },
      { stageName: "Build", actions: [buildAction] },
      { stageName: "Deploy", actions: [deployAction] },
    ];

    const codePipeline = new Pipeline(this, "codepipeline", {
      pipelineName: pipelineName,
      stages,
    });

    codePipeline.node.addDependency(bucket, distribution);
  }

  private _outCloudfrontURL(distribution: Distribution) {
    new CfnOutput(this, "cloudfront-web-url", {
      value: distribution.distributionDomainName,
      description: "cloudfront website url",
    });
  }

  private _outS3BucketURL(bucket: Bucket) {
    new CfnOutput(this, "s3-bucket-web-url", {
      value: bucket.bucketWebsiteUrl,
      description: "s3 bucket website url",
    });
  }
}

function convertEnvVariables(env: dotenv.DotenvParseOutput): {
  [key: string]: { value: string };
} {
  return Object.keys(env).reduce((acc, key) => {
    acc[key] = { value: env[key] };
    return acc;
  }, {} as { [key: string]: { value: string } });
}

function loadEnvFile() {
  const envFilePath = path.join(__dirname, "../config/.env");
  const result = dotenv.config({ path: envFilePath });
  if (result.error) {
    throw result.error;
  }
  if (!result.parsed) {
    throw new Error("Failed to load environment variables from .env file");
  }
  return convertEnvVariables(result.parsed);
}
