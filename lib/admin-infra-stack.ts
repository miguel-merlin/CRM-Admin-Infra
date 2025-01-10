import * as cdk from "aws-cdk-lib";
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

interface ReactDeploymentCICDStackProps extends cdk.StackProps {
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

export class AdminInfraStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: ReactDeploymentCICDStackProps
  ) {
    super(scope, id, props);
    const webBucket = this._createWebBucket(props);
    const distribution = this._createCloudFrontDistribution(webBucket);

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
    this._outCloudfrontUrl(distribution);
    this._outS3BucketUrl(webBucket);
  }

  private _createWebBucket(props: ReactDeploymentCICDStackProps) {
    const { bucketName, indexFile, errorFile, publicAccess } = props;
    const webBucket = new Bucket(this, bucketName, {
      websiteIndexDocument: indexFile,
      websiteErrorDocument: errorFile,
      publicReadAccess: publicAccess,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
    const s3origin = new S3Origin(bucket, {
      originAccessIdentity: oai,
    });

    const distribution = new Distribution(
      this,
      "react-deployment-distribution",
      {
        defaultBehavior: {
          origin: s3origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        defaultRootObject: "index.html",
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 404,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.seconds(300),
          },
          {
            httpStatus: 403,
            responseHttpStatus: 500,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.seconds(300),
          },
        ],
        priceClass: PriceClass.PRICE_CLASS_100,
      }
    );
    return distribution;
  }

  private _createSourceAction(props: ReactDeploymentCICDStackProps) {
    const { githubRepoOwner, githubRepoName, githubAccessToken, branch } =
      props;
    const sourceOutput = new Artifact();
    const sourceAction = new GitHubSourceAction({
      actionName: "GitHub_Source",
      owner: githubRepoOwner,
      repo: githubRepoName,
      branch: branch,
      oauthToken: cdk.SecretValue.secretsManager(githubAccessToken),
      output: sourceOutput,
    });

    return {
      sourceOutput,
      sourceAction,
    };
  }

  private _createBuildProject(distribution: Distribution) {
    const buildOutput = new Artifact();
    const buildProject = new Project(this, "react-code-build-project", {
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            commands: ['echo "installing npm dependencies"', "npm install"],
          },
          build: {
            commands: ['echo "building react app"', "npm run build"],
          },
          post_build: {
            commands: [
              'echo "creating cloudfront invalidation"',
              `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths '/*'`,
            ],
          },
          arfifacts: {
            "base-directory": "dist",
            files: ["**/*"],
          },
        },
      }),
      environment: {
        buildImage: LinuxBuildImage.STANDARD_5_0,
      },
    });

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
      actionName: "DeploytToS3",
      input: buildOutput,
      bucket: bucket,
    });
    return deployAction;
  }

  private _createPipeline(
    deployAction: S3DeployAction,
    sourceAction: GitHubSourceAction,
    buildAction: CodeBuildAction,
    props: ReactDeploymentCICDStackProps,
    bucket: Bucket,
    distribution: Distribution
  ) {
    const { pipelineName, pipelineBucket } = props;
    const getPipelineBucket = Bucket.fromBucketName(
      this,
      "pipeline-existing-artifact-bucket",
      pipelineBucket
    );
    const stages = [
      { stageName: "Source", actions: [sourceAction] },
      { stageName: "Build", actions: [buildAction] },
      { stageName: "Deploy", actions: [deployAction] },
    ];

    const codePipeline = new Pipeline(this, "admincodepipeline", {
      pipelineName: pipelineName,
      artifactBucket: getPipelineBucket,
      stages,
    });
    codePipeline.node.addDependency(bucket, distribution);
  }

  private _outCloudfrontUrl(distribution: Distribution) {
    new cdk.CfnOutput(this, "cloudfront-web-url", {
      value: distribution.distributionDomainName,
      description: "cloudfront website url",
    });
  }
  private _outS3BucketUrl(bucket: Bucket) {
    new cdk.CfnOutput(this, "s3-bucket-url", {
      value: bucket.bucketWebsiteUrl,
      description: "s3 bucket url",
    });
  }
}
