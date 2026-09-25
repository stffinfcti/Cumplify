/**
 * CAPAGuru tool definitions for Bedrock Converse.
 * Mutating tools (capa-open, capa-verify-effectiveness) are HITL-gated.
 * Advisory tools (capa-rootcause) execute directly.
 */

import type { ToolConfig } from '../../ai-invoker/src/types.js';

export const CAPA_GURU_TOOLS: ToolConfig[] = [
  {
    toolSpec: {
      name: 'rca-write',
      description:
        'Propose a structured root-cause analysis for an existing NC (C1 CAPA Studio RCA): 5 Whys chain, Ishikawa/fishbone categories, or fault tree. HITL-gated: a human reviews the analysis before it becomes a record.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['ncId', 'method', 'findings', 'rootCauseSummary', 'rationale'],
          properties: {
            ncId: { type: 'string', description: 'The NC id — copy verbatim from the request' },
            method: {
              type: 'string',
              description: 'The requested method — copy verbatim: 5why | fishbone | fta',
            },
            findings: {
              type: 'object',
              description:
                'The structured analysis. For 5why: {"whys": [{question, answer}]} — 3 to 5 links, each answer becomes the next question. For fishbone: {"categories": [{category, causes}]} over Man/Method/Machine/Material/Measurement/Environment (omit empty categories). For fta: {"tree": [{event, causes}]}.',
              properties: {
                whys: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['question', 'answer'],
                    properties: {
                      question: { type: 'string' },
                      answer: { type: 'string' },
                    },
                  },
                },
                categories: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['category', 'causes'],
                    properties: {
                      category: { type: 'string' },
                      causes: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                tree: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['event', 'causes'],
                    properties: {
                      event: { type: 'string' },
                      causes: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
            rootCauseSummary: {
              type: 'string',
              description: 'The single root cause the analysis converges on, stated plainly',
            },
            rationale: {
              type: 'string',
              description:
                'For the approver: how the chain/categories were derived from the NC facts, and what evidence would confirm the root cause',
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'nc-draft-write',
      description:
        'Draft a NEW nonconformity from a raw problem report (S1 intake): classify it, identify the governing ISO clause, set severity and source. HITL-gated: a human reviews and can edit every field before the NC is created.',
      inputSchema: {
        json: {
          type: 'object',
          required: [
            'standard',
            'ncType',
            'clauseRef',
            'severity',
            'source',
            'description',
            'rationale',
          ],
          properties: {
            standard: {
              type: 'string',
              description: 'Governing standard: ISO9001 | ISO14001 | ISO45001',
            },
            ncType: {
              type: 'string',
              description: 'One of: nonconforming_output | nc | incident',
            },
            clauseRef: {
              type: 'string',
              description:
                'The governing clause number of the chosen standard (e.g. 8.7 for nonconforming outputs, 10.2 for nonconformity and corrective action)',
            },
            severity: { type: 'string', description: 'One of: low | medium | high | critical' },
            source: {
              type: 'string',
              description: 'One of: audit | incident | complaint | process',
            },
            description: {
              type: 'string',
              description: 'The refined, audit-ready problem statement (facts only, no invention)',
            },
            containmentNote: {
              type: 'string',
              description: 'Optional immediate-containment suggestion',
            },
            rationale: {
              type: 'string',
              description: 'Why this classification and clause — shown to the approver',
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'nc-triage-write',
      description:
        'Reclassify an existing nonconformity (architecture §4 CAPA stage 2: triage). HITL-gated: requires human (QM/EHS Manager) approval before commit.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['ncId', 'classification'],
          properties: {
            ncId: { type: 'string', description: 'ID of the nonconformity' },
            classification: {
              type: 'string',
              description: 'One of: nonconforming_output | nc | incident',
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'capa-open',
      description:
        'Propose a corrective action for a nonconformity. HITL-gated: requires human approval before commit.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['ncId', 'actionDesc', 'suggestedOwnerId', 'dueDate'],
          properties: {
            ncId: { type: 'string', description: 'ID of the nonconformity' },
            actionDesc: {
              type: 'string',
              description: 'Description of the proposed corrective action',
            },
            suggestedOwnerId: {
              type: 'string',
              description: 'Suggested owner (user ID) for the action',
            },
            dueDate: {
              type: 'string',
              description: 'Due date for the corrective action (ISO 8601 timestamp)',
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'capa-rootcause',
      description:
        'Perform structured root-cause analysis (5-why, fishbone). Advisory — no HITL required.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['ncId', 'method'],
          properties: {
            ncId: { type: 'string', description: 'ID of the nonconformity' },
            method: { type: 'string', description: 'Analysis method: 5why | fishbone | fta' },
            findings: { type: 'string', description: 'Root cause findings' },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'capa-verify-effectiveness',
      description: 'Record effectiveness verification for a corrective action. HITL-gated.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['capaId', 'verificationMethod', 'effective'],
          properties: {
            capaId: { type: 'string', description: 'ID of the corrective action' },
            verificationMethod: { type: 'string', description: 'How effectiveness was verified' },
            effective: { type: 'boolean', description: 'Whether the action was effective' },
          },
        },
      },
    },
  },
];
