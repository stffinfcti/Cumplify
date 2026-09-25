/**
 * Lambda invoke transport — C-1 one-door enforcement.
 * Agent handlers call the AI Invoker Lambda via LambdaClient/InvokeCommand.
 * They MUST NOT import invoke() or embed() directly from @cumplify/ai-invoker.
 *
 * This is the ONLY way agent handler code reaches Bedrock.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type {
  InvokeRequest,
  InvokeResponse,
  EmbedRequest,
  EmbedResult,
} from '../../ai-invoker/src/types.js';
import type { InvokeFn } from './tool-loop.js';

const lambdaClient = new LambdaClient({});
const AI_INVOKER_ARN = process.env.AI_INVOKER_ARN!;

/**
 * Create an invoke function that calls the AI Invoker Lambda synchronously.
 * Returns the parsed InvokeResponse from the one-door.
 */
export function createInvokeFn(): InvokeFn {
  return async (request: InvokeRequest): Promise<InvokeResponse> => {
    const result = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: AI_INVOKER_ARN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );

    if (result.FunctionError) {
      const errorPayload = result.Payload ? JSON.parse(Buffer.from(result.Payload).toString()) : {};
      throw new Error(
        `AI Invoker error: ${result.FunctionError} — ${errorPayload.errorMessage ?? 'unknown'}`,
      );
    }

    if (!result.Payload) {
      throw new Error('AI Invoker returned empty payload');
    }

    return JSON.parse(Buffer.from(result.Payload).toString()) as InvokeResponse;
  };
}

/** Embed function type — used by handler code to call the embed door */
export type EmbedFn = (request: EmbedRequest) => Promise<EmbedResult>;

/**
 * Create an embed function that calls the AI Invoker Lambda with op:'embed'.
 * Same one-door (AI_INVOKER_ARN), same transport — handlers NEVER import embed.ts.
 * Spec-35 §2.3, EMB-2.
 */
export function createEmbedFn(): EmbedFn {
  return async (request: EmbedRequest): Promise<EmbedResult> => {
    const payload = { op: 'embed' as const, ...request };
    const result = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: AI_INVOKER_ARN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );

    if (result.FunctionError) {
      const errorPayload = result.Payload ? JSON.parse(Buffer.from(result.Payload).toString()) : {};
      throw new Error(
        `AI Invoker embed error: ${result.FunctionError} — ${errorPayload.errorMessage ?? 'unknown'}`,
      );
    }

    if (!result.Payload) {
      throw new Error('AI Invoker embed returned empty payload');
    }

    return JSON.parse(Buffer.from(result.Payload).toString()) as EmbedResult;
  };
}
