/**
 * FrontendStack — static SPA hosting via S3 + CloudFront (OAC).
 * Design R3 §9: Next.js static export served from private S3 bucket with
 * CloudFront distribution. A viewer-request CloudFront Function maps
 * extensionless routes to their exported .html objects; custom error
 * responses fall back to index.html for unknown paths.
 *
 * Owner lifecycle: separate from ApiStack (keeps it lean).
 * Deploy: pipeline post-step → s3 sync out/ + cloudfront create-invalidation.
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { type EnvConfig } from './env-config.js';
import { MGMT_ACCOUNT } from './env-config.js';

export interface FrontendStackProps extends cdk.StackProps {
  readonly envConfig: EnvConfig;
  readonly apiUrl: string;
  readonly cloudfrontWafArn: string;
}

/**
 * Next.js output:'export' ships routes as flat files (dashboard.html), so
 * /dashboard and /dashboard/ must be rewritten to /dashboard.html at the edge.
 * Without this the request misses S3 and the 403 fallback serves index.html —
 * the wrong page — with a 200 status. Exported for direct unit testing.
 */
export const URL_REWRITE_FN_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  while (uri.length > 1 && uri.endsWith('/')) {
    uri = uri.slice(0, -1);
  }
  if (uri !== '/' && !uri.split('/').pop().includes('.')) {
    uri += '.html';
  }
  request.uri = uri;
  return request;
}`;

export class FrontendStack extends cdk.Stack {
  public readonly distributionId: string;
  public readonly bucketName: string;
  public readonly distributionDomainName: string;
  public readonly distributionDomainOutput: cdk.CfnOutput;
  public readonly bucketNameOutput: cdk.CfnOutput;
  public readonly distributionIdOutput: cdk.CfnOutput;
  public readonly contentDeployRoleArn: string;
  public readonly contentDeployRoleArnOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);
    const { envConfig } = props;

    // Private S3 bucket — no public access, OAC grants CloudFront read
    const bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `cumplify-frontend-${envConfig.envName}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    const urlRewriteFn = new cloudfront.Function(this, 'UrlRewriteFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(URL_REWRITE_FN_CODE),
      comment: 'Map extensionless routes to static-export .html objects',
    });

    // Security headers for the SPA surface. CSP allows the AppSync endpoint,
    // AppSync realtime (subscriptions over wss), and Cognito; everything else
    // stays 'self'. 'unsafe-inline' on script/style is required by the Next.js
    // static export (inlined bootstraps) — tighten when the app moves to
    // external-only scripts.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' https://*.appsync-api.${envConfig.region}.amazonaws.com wss://*.appsync-realtime-api.${envConfig.region}.amazonaws.com https://*.amazoncognito.com https://cognito-identity.${envConfig.region}.amazonaws.com`,
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
    ].join('; ');

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
            override: true,
          },
        ],
      },
    });

    // CloudFront distribution with OAC origin
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [
          {
            function: urlRewriteFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      webAclId: props.cloudfrontWafArn,
      defaultRootObject: 'index.html',
      // Unknown routes (post-rewrite .html miss): 403/404 from S3 → index.html
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      comment: `Cumplify frontend (${envConfig.envName})`,
    });

    this.distributionId = distribution.distributionId;
    this.bucketName = bucket.bucketName;
    this.distributionDomainName = distribution.distributionDomainName;

    // CfnOutputs for readback + pipeline deploy step
    this.bucketNameOutput = new cdk.CfnOutput(this, 'FrontendBucketName', { value: bucket.bucketName });
    this.distributionIdOutput = new cdk.CfnOutput(this, 'FrontendDistributionId', { value: distribution.distributionId });
    this.distributionDomainOutput = new cdk.CfnOutput(this, 'FrontendDistributionDomain', {
      value: distribution.distributionDomainName,
    });

    // ContentDeployRole — per-env role for the pipeline CodeBuild step to
    // sync SPA assets to this bucket + invalidate CloudFront. Trust is
    // condition-gated to mgmt pipeline roles only. (SMOKE-2 design §2.1)
    const contentDeployRole = new iam.Role(this, 'ContentDeployRole', {
      roleName: `cumplify-${envConfig.envName}-frontend-content-deploy`,
      assumedBy: new iam.PrincipalWithConditions(new iam.AnyPrincipal(), {
        StringLike: {
          'aws:PrincipalArn': `arn:aws:iam::${MGMT_ACCOUNT}:role/CumplifyPipeline*`,
        },
      }),
      inlinePolicies: {
        FrontendDeployPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
              resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['cloudfront:CreateInvalidation'],
              resources: [
                `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
              ],
            }),
          ],
        }),
      },
    });
    this.contentDeployRoleArn = contentDeployRole.roleArn;
    this.contentDeployRoleArnOutput = new cdk.CfnOutput(this, 'ContentDeployRoleArn', {
      value: contentDeployRole.roleArn,
    });

    // CDK Nag suppressions
    NagSuppressions.addResourceSuppressions(
      distribution,
      [
        {
          id: 'AwsSolutions-CFR1',
          reason:
            'Geo restrictions not required for P1 (global SaaS, no data-residency constraint yet).',
        },
        {
          id: 'AwsSolutions-CFR3',
          reason:
            'Access logging deferred — CloudFront standard logging costs non-trivial for P1; revisit post-launch.',
        },
        {
          id: 'AwsSolutions-CFR4',
          reason:
            'Custom SSL certificate + domain deferred to post-P1 (using default CloudFront domain for now).',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      bucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'Access logging deferred — CloudFront standard logging provides visibility at the edge layer.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      contentDeployRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 object-level actions (PutObject, DeleteObject) require /*-suffixed resource for s3 sync; scoped to this stack\'s bucket only.',
        },
      ],
      true,
    );
  }
}
