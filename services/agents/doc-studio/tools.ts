/**
 * DocStudio tool definitions for Bedrock Converse.
 * Mutating tools (doc-version-control, doc-publish) are HITL-gated.
 * Advisory tools (doc-draft) execute directly.
 */

import type { ToolConfig } from '../../ai-invoker/src/types.js';

export const DOC_STUDIO_TOOLS: ToolConfig[] = [
  {
    toolSpec: {
      name: 'doc-draft',
      description:
        'Draft a COMPLETE controlled document from a described intent (S2 Document Studio). HITL-gated: a human reviews (and can edit) the whole draft before the document is created.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['docType', 'standard', 'title', 'sections', 'rationale'],
          properties: {
            docType: {
              type: 'string',
              description: 'One of: manual | procedure | work_instruction | policy | scope',
            },
            standard: {
              type: 'string',
              description: 'Governing standard: ISO9001 | ISO14001 | ISO45001',
            },
            title: { type: 'string', description: 'Document title' },
            sections: {
              type: 'array',
              description: 'The full drafted body, one entry per section',
              items: {
                type: 'object',
                required: ['clauseRef', 'heading', 'body'],
                properties: {
                  clauseRef: {
                    type: 'string',
                    description: 'Governing clause number of the chosen standard (e.g. 8.5.1)',
                  },
                  heading: { type: 'string', description: 'Section heading' },
                  body: {
                    type: 'string',
                    description:
                      'Drafted prose for this section — facts and practice, no invention',
                  },
                },
              },
            },
            rationale: {
              type: 'string',
              description: 'Why this structure and these clauses — shown to the approver',
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'manual-section-draft',
      description:
        'Propose prose for ONE section of a generated IMS manual (S3 Manual Studio gap burn-down). HITL-gated: a human reviews (and can edit) the section before the manual is re-versioned.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['generationRunId', 'harmonizationKey', 'sentences', 'rationale'],
          properties: {
            generationRunId: {
              type: 'string',
              description: 'The generation run id — copy verbatim from the request',
            },
            harmonizationKey: {
              type: 'string',
              description: 'The section harmonization key — copy verbatim from the request',
            },
            sentences: {
              type: 'array',
              description:
                'The drafted section prose, one entry per sentence. Ground every claim in the org profile facts; where a fact is genuinely missing write "[To be completed: …]" — never invent.',
              items: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string', description: 'One sentence of section prose' },
                },
              },
            },
            rationale: {
              type: 'string',
              description:
                'What this draft covers, which clause intents it answers, and what (if anything) remains bracketed — shown to the approver',
            },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'doc-version-control',
      description:
        'Create a new version of a controlled document. HITL-gated: requires human approval.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['docId', 'changeDescription', 'newVersion'],
          properties: {
            docId: { type: 'string', description: 'ID of the document to version' },
            changeDescription: {
              type: 'string',
              description: 'Summary of changes in this version',
            },
            newVersion: { type: 'string', description: 'New version number (e.g., 2.0, 1.1)' },
          },
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'doc-publish',
      description:
        'Publish an approved document to the controlled document store. HITL-gated: requires human approval.',
      inputSchema: {
        json: {
          type: 'object',
          required: ['docId', 'version', 'effectiveDate'],
          properties: {
            docId: { type: 'string', description: 'ID of the document to publish' },
            version: { type: 'string', description: 'Version to publish' },
            effectiveDate: { type: 'string', description: 'Effective date (ISO 8601)' },
            distribution: {
              type: 'array',
              items: { type: 'string' },
              description: 'Distribution list (role IDs)',
            },
          },
        },
      },
    },
  },
];
