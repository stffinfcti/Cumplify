/**
 * RiskSentinel agent handler — direct-invoke only (RS-8, read-surface-
 * completion). No SQS trigger yet (event-triggered hazard/aspect chains
 * are catalogued roadmap, agent-catalog.md:198-212).
 *
 * Flow: m5.ts's runRiskAssessment resolver (ApiStack, has RDS access)
 * fetches the risk row, then lambda:Invoke's this Lambda (RequestResponse
 * would hit AppSync's ~30s resolver ceiling under real Bedrock latency —
 * the CALLER invokes async/Event and returns an immediate AgentRunAck; this
 * handler runs to completion on its own budget, proposing via the HITL gate
 * when done). tool-loop (Converse) -> risk-assessment-write tool -> HITL
 * gate -> approval -> ExecuteWriteback ('risk-assessment-write' case) -> audit.
 *
 * C-1 (BINDING): uses createInvokeFn() Lambda transport. NEVER imports
 * invoke() directly from ai-invoker.
 * AgentHandlerReadOnlyPolicy (T-1): zero RDS/DDB access — every field this
 * handler reasons over MUST already be in the invoke payload's `context`.
 */

import { Logger } from '@aws-lambda-powertools/logger';

import { toolLoop } from '../shared/tool-loop.js';
import { createInvokeFn } from '../shared/invoke-transport.js';
import { assertTenantIdSafe } from '../../api/src/resolvers/shared.js';
import { RISK_SENTINEL_PROMPT } from './prompt.js';
import { RISK_SENTINEL_TOOLS } from './tools.js';

const logger = new Logger({ serviceName: 'risk-sentinel' });
const invokeFn = createInvokeFn();

export interface RiskContext {
  description: string;
  category: string;
  standard: 'ISO9001' | 'ISO14001' | 'ISO45001';
  currentLikelihood: number;
  currentSeverity: number;
  /** Related-register context (hazards/aspects/incidents/CAPAs) — free text, may be empty. */
  relatedContext?: string;
}

export interface RunAssessmentInput {
  tenantId: string;
  runId: string;
  riskId: string;
  /** RS-8 SOD-1: the human who clicked "AI: draft this" — threaded to enterHitlGate. */
  requestedBy: string;
  context: RiskContext;
}

export interface RunAssessmentResult {
  runId: string;
  status: string;
}

export async function runAssessment(input: RunAssessmentInput): Promise<RunAssessmentResult> {
  const { tenantId, riskId, requestedBy, context } = input;
  assertTenantIdSafe(tenantId);

  const userMessage = [
    `Assess this existing risk. Propose an updated likelihood/severity rating via risk-assessment-write, or the SAME rating with an explicit "context insufficient" rationale if you cannot responsibly assess it.`,
    `\nRisk ID: ${riskId}`,
    `Standard: ${context.standard}`,
    `Category: ${context.category}`,
    `Description: ${context.description}`,
    `Current rating: likelihood=${context.currentLikelihood}, severity=${context.currentSeverity}`,
    context.relatedContext ? `\nRelated-register context:\n${context.relatedContext}` : '',
  ].join('\n');

  const result = await toolLoop([{ role: 'user', content: [{ text: userMessage }] }], {
    seat: 'workhorse',
    systemPrompt: RISK_SENTINEL_PROMPT,
    tools: RISK_SENTINEL_TOOLS,
    tenantId,
    agent: 'RiskSentinel',
    module: 'M5',
    feature: 'risk-assessment',
    hitlTools: new Set(['risk-assessment-write']),
    requestedBy,
    invokeFn,
    dispatchTool: async (toolName, toolInput, tid) => {
      logger.warn('RiskSentinel dispatchTool called before registration', {
        toolName,
        tenantId: tid,
        inputKeys: Object.keys(toolInput as Record<string, unknown>),
      });
      throw new Error(`RiskSentinel tool '${toolName}' is not implemented`);
    },
  });

  return {
    runId: input.runId,
    status: result.hitlResult ? 'PENDING_APPROVAL' : 'NO_PROPOSAL',
  };
}

/** Lambda:Invoke entry point (RequestResponse from CAPAGuru-style direct callers, or Event from m5.ts). */
export async function handler(event: RunAssessmentInput): Promise<RunAssessmentResult> {
  return runAssessment(event);
}
