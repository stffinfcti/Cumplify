/**
 * CloudFormation Custom Resource handler for ISO KB Seeder.
 * FIX-P12-3: replaces AwsCustomResource (which swallowed FunctionError) with
 * CFN-direct protocol — FAILED seeds now FAIL the deploy as designed (ACC-5).
 *
 * Protocol: cfn-response via HTTPS PUT to the pre-signed ResponseURL.
 * Create/Update → seed → SUCCESS or FAILED.
 * Delete → no-op SUCCESS (index outlives stack; collection is DataStack's).
 * Internal deadline ~280s so CFN never waits the 1-hour CR timeout.
 * Response ALWAYS sent (try/catch around everything).
 */

import { Logger } from '@aws-lambda-powertools/logger';
import https from 'node:https';
import url from 'node:url';
import { seed, type SeederResult } from './handler.js';

const logger = new Logger({ serviceName: 'iso-kb-seeder-cfn' });

const INTERNAL_DEADLINE_MS = 280_000; // 280s < Lambda 300s timeout

export interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  ResourceType: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties?: {
    SourceHash?: string;
    ServiceToken?: string;
  };
}

interface CfnResponse {
  Status: 'SUCCESS' | 'FAILED';
  Reason?: string;
  PhysicalResourceId: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  Data?: Record<string, string | number>;
}

/**
 * CFN Custom Resource Lambda entry point.
 * ALWAYS sends a response to the ResponseURL — even on unexpected errors.
 */
export async function handler(event: CfnEvent): Promise<void> {
  const physicalId = event.PhysicalResourceId ?? `iso-kb-seed-${event.RequestId}`;

  logger.info('CFN event received', {
    requestType: event.RequestType,
    logicalId: event.LogicalResourceId,
    sourceHash: event.ResourceProperties?.SourceHash,
  });

  // Delete → no-op (index outlives stack; collection is DataStack's)
  if (event.RequestType === 'Delete') {
    await sendCfnResponse(event, {
      Status: 'SUCCESS',
      PhysicalResourceId: physicalId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
    });
    return;
  }

  // Create / Update → run the seed with an internal deadline
  try {
    const result = await Promise.race<SeederResult>([seed(), rejectAfter(INTERNAL_DEADLINE_MS)]);

    logger.info('Seed completed', { status: result.status, contentHash: result.contentHash });

    await sendCfnResponse(event, {
      Status: 'SUCCESS',
      PhysicalResourceId: `iso-kb-seed-${result.contentHash.slice(0, 12)}`,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {
        ContentHash: result.contentHash,
        ChunksIndexed: result.chunksIndexed ?? 0,
        Status: result.status,
      },
    });
  } catch (err) {
    const reason = (err as Error).message ?? 'Unknown error';
    logger.error('Seed FAILED', { reason });

    await sendCfnResponse(event, {
      Status: 'FAILED',
      Reason: reason.slice(0, 1000),
      PhysicalResourceId: physicalId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
    });
  }
}

/**
 * Internal deadline — rejects the promise after ms to ensure we always respond.
 */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Internal deadline exceeded (${ms}ms)`)), ms),
  );
}

/**
 * Send cfn-response via HTTPS PUT to the pre-signed S3 URL.
 * MUST succeed — if this fails, CFN waits the full timeout (1 hour).
 */
async function sendCfnResponse(event: CfnEvent, response: CfnResponse): Promise<void> {
  const body = JSON.stringify(response);
  const parsedUrl = url.parse(event.ResponseURL);

  const options: https.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'content-type': '',
      'content-length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      logger.info('CFN response sent', { status: res.statusCode, cfnStatus: response.Status });
      resolve();
    });
    req.on('error', (err) => {
      logger.error('CFN response send FAILED', { error: err.message });
      reject(err);
    });
    req.write(body);
    req.end();
  });
}
