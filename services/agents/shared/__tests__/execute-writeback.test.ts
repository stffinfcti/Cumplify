/**
 * ExecuteWriteback dispatch tests — pinned to migration schemas (H-4, Task 8R).
 *
 * Validates that dispatchToolWrite SQL matches the actual migration column definitions
 * and CHECK constraints. Tests do NOT call RDS — they validate the SQL strings
 * produced by each tool handler against the schema source-of-truth.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WRITEBACK_CODE = readFileSync(resolve(__dirname, '../execute-writeback.ts'), 'utf-8');

const MIGRATION_003 = readFileSync(
  resolve(__dirname, '../../../api/migrations/003_m2_capa.sql'),
  'utf-8',
);

const MIGRATION_004 = readFileSync(
  resolve(__dirname, '../../../api/migrations/004_m3_audit_studio.sql'),
  'utf-8',
);

const MIGRATION_006 = readFileSync(
  resolve(__dirname, '../../../api/migrations/006_m5_risk_management.sql'),
  'utf-8',
);

describe('execute-writeback dispatch: schema pinning', () => {
  describe('capa-open (m2.corrective_actions)', () => {
    it('includes due_date in INSERT (NOT NULL, no default in 003)', () => {
      // Migration defines: due_date TIMESTAMPTZ NOT NULL (no DEFAULT)
      expect(MIGRATION_003).toContain('due_date TIMESTAMPTZ NOT NULL');
      expect(MIGRATION_003).not.toMatch(/due_date\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT/);
      // Writeback INSERT must include due_date
      expect(WRITEBACK_CODE).toMatch(/INSERT INTO m2\.corrective_actions.*due_date/s);
    });

    it('includes created_by in INSERT (NOT NULL in 003)', () => {
      expect(MIGRATION_003).toContain('created_by TEXT NOT NULL');
      expect(WRITEBACK_CODE).toMatch(/INSERT INTO m2\.corrective_actions.*created_by/s);
    });

    it('uses full actor identity (not hardcoded agent name) for created_by', () => {
      // M-2: should use :actor parameter, not a hardcoded 'agent:CAPAGuru'
      expect(WRITEBACK_CODE).not.toMatch(/executeCapaOpen[\s\S]*?'agent:CAPAGuru'/);
      // Should reference the actor parameter
      expect(WRITEBACK_CODE).toMatch(/executeCapaOpen[\s\S]*?:actor/);
    });
  });

  describe('audit-checklist-gen (m3.audit_checklists)', () => {
    it('includes created_by in INSERT (NOT NULL in 004)', () => {
      expect(MIGRATION_004).toContain('created_by TEXT NOT NULL');
      // The checklist INSERT must include created_by
      expect(WRITEBACK_CODE).toMatch(/INSERT INTO m3\.audit_checklists.*created_by/s);
    });
  });

  describe('audit-finding-write (m3.audit_findings)', () => {
    it('CHECK constraint uses underscore values: major_nc, minor_nc', () => {
      expect(MIGRATION_004).toContain("'major_nc'");
      expect(MIGRATION_004).toContain("'minor_nc'");
      expect(MIGRATION_004).toContain("'observation'");
      expect(MIGRATION_004).toContain("'ofi'");
    });

    it('maps hyphenated finding types to underscore at dispatch layer', () => {
      // The code must have a mapping from major-nc → major_nc
      expect(WRITEBACK_CODE).toContain("'major-nc': 'major_nc'");
      expect(WRITEBACK_CODE).toContain("'minor-nc': 'minor_nc'");
    });

    it('calls mapFindingType before SQL execution', () => {
      expect(WRITEBACK_CODE).toMatch(/executeAuditFindingWrite[\s\S]*?mapFindingType/);
    });
  });

  describe('doc-draft (S2 studio wave, m1.documents + version-1 + S3 content)', () => {
    const fnBody = () =>
      WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeDocDraft'),
        WRITEBACK_CODE.indexOf('async function executeDocPublish'),
      );

    it('INSERTs the document AND its version-1 row — creation, never update', () => {
      expect(fnBody()).toMatch(/INSERT INTO m1\.documents/);
      expect(fnBody()).toMatch(/INSERT INTO m1\.document_versions/);
      expect(fnBody()).not.toContain('UPDATE ');
    });

    it("writes the ContentJson to S3 in the generation-plane shape (sentences[].text — editor/viewer compatible) under the versionContentKey scheme, born 'draft'", () => {
      expect(fnBody()).toContain('PutObjectCommand');
      expect(fnBody()).toContain('sentences: [{ text: s.body }]');
      expect(fnBody()).toContain('/documents/${documentId}/v1.json');
      expect(fnBody()).toContain("'draft'");
    });

    it('S3 put happens BEFORE the version-row insert — a failed put rolls the txn back, no dangling content_ref', () => {
      const body = fnBody();
      expect(body.indexOf('PutObjectCommand')).toBeLessThan(
        body.indexOf('INSERT INTO m1.document_versions'),
      );
    });

    it('scopes tenant via current_setting and refuses an empty draft', () => {
      expect(fnBody()).toContain("current_setting('app.tenant_id')");
      expect(fnBody()).toContain('DOC_DRAFT_EMPTY');
    });
  });

  describe('nc-draft-write (S1 studio wave, m2.nonconformities)', () => {
    const fnBody = () =>
      WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeNcDraftWrite'),
        WRITEBACK_CODE.indexOf('async function executeNcTriageWrite'),
      );

    it('INSERTs a NEW nonconformity — stage-1 intake creates, never updates', () => {
      expect(fnBody()).toMatch(/INSERT INTO m2\.nonconformities/);
      expect(fnBody()).not.toContain('UPDATE ');
    });

    it('scopes tenant_id via current_setting (RLS pattern) and mirrors raiseNonconformity columns', () => {
      expect(fnBody()).toContain("current_setting('app.tenant_id')");
      for (const col of [
        'standard',
        'source',
        'nc_type',
        'description',
        'clause_ref',
        'severity',
        'raised_by',
      ]) {
        expect(fnBody()).toContain(col);
      }
      // Born open, like every human-raised NC (migration 003 status CHECK)
      expect(fnBody()).toContain("'open'");
    });

    it('actor lands in raised_by/created_by — the dual-attribution writeback actor string', () => {
      expect(fnBody()).toContain(':actor');
    });
  });

  describe('nc-triage-write (RS-8, m2.nonconformities)', () => {
    it('UPDATEs nc_type, never INSERTs a new row (this is a reclassification, not a create)', () => {
      const fnBody = WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeNcTriageWrite'),
        WRITEBACK_CODE.indexOf('async function executeRiskAssessmentWrite'),
      );
      expect(fnBody).toMatch(/UPDATE m2\.nonconformities SET nc_type/);
      expect(fnBody).not.toContain('INSERT INTO');
    });

    it('scopes to tenant via current_setting (RLS pattern, matches every other tool here)', () => {
      const fnBody = WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeNcTriageWrite'),
        WRITEBACK_CODE.indexOf('async function executeRiskAssessmentWrite'),
      );
      expect(fnBody).toContain("tenant_id = current_setting('app.tenant_id')");
    });

    it('passes classification straight through — the DB CHECK constraint is the validation backstop', () => {
      // migration 003: nc_type CHECK (nc_type IN ('nonconforming_output','nc','incident'))
      expect(MIGRATION_003).toContain('nc_type TEXT NOT NULL CHECK (nc_type IN');
      const fnBody = WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeNcTriageWrite'),
        WRITEBACK_CODE.indexOf('async function executeRiskAssessmentWrite'),
      );
      expect(fnBody).toContain(':classification');
    });
  });

  describe('risk-assessment-write (RS-8, m5.risks)', () => {
    it('UPDATEs likelihood/severity, never INSERTs a new row (this is an assessment, not a create)', () => {
      const fnBody = WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeRiskAssessmentWrite'),
        WRITEBACK_CODE.indexOf('/**\n * H-3'),
      );
      expect(fnBody).toMatch(/UPDATE m5\.risks SET likelihood = :likelihood, severity = :severity/);
      expect(fnBody).not.toContain('INSERT INTO');
    });

    it("likelihood/severity match migration 006's CHECK(1-5) columns", () => {
      expect(MIGRATION_006).toContain(
        'likelihood INTEGER NOT NULL CHECK (likelihood BETWEEN 1 AND 5)',
      );
      expect(MIGRATION_006).toContain('severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5)');
    });

    it('refreshes risk_register_view in the SAME transaction (createRisk/agentAssessRisk pattern)', () => {
      const fnBody = WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function executeRiskAssessmentWrite'),
        WRITEBACK_CODE.indexOf('/**\n * H-3'),
      );
      expect(fnBody).toContain('m5_views.refresh_risk_register_view()');
      // Same transactionId threaded to the refresh call, not a fresh one.
      expect(fnBody).toContain(
        'transactionId,\n      sql: `SELECT m5_views.refresh_risk_register_view()`',
      );
    });
  });

  describe('ct-governance-write', () => {
    it('is BLOCKED-ON-DESIGN (no m1.roles_responsibilities in any migration)', () => {
      // Writeback correctly blocks ct-governance-write
      expect(WRITEBACK_CODE).toContain('BLOCKED-ON-DESIGN');
      expect(WRITEBACK_CODE).toMatch(/ct-governance-write[\s\S]*?throw new Error/);
    });
  });

  describe('dispatch switch completeness', () => {
    it('covers all HITL tools declared by handlers', () => {
      const hitlTools = [
        'capa-open',
        'capa-verify-effectiveness',
        'doc-publish',
        'doc-version-control',
        'audit-finding-write',
        'audit-checklist-gen',
        'records-retention-schedule',
        'doc-draft',
        'manual-section-draft',
        'nc-draft-write',
        'rca-write',
        'nc-triage-write',
        'risk-assessment-write',
        'ct-governance-write',
      ];
      for (const tool of hitlTools) {
        expect(WRITEBACK_CODE).toContain(`case '${tool}':`);
      }
    });

    describe('audit-finding-write cross-studio NC spawn (S4)', () => {
      it('major/minor NC findings ALSO insert an m2 nonconformity in the SAME txn (source audit, severity mapped)', () => {
        const body = WRITEBACK_CODE.slice(
          WRITEBACK_CODE.indexOf('async function executeAuditFindingWrite'),
          WRITEBACK_CODE.indexOf('async function executeChecklistGen'),
        );
        expect(body).toContain("findingType === 'major_nc' || findingType === 'minor_nc'");
        expect(body).toMatch(/INSERT INTO m2\.nonconformities[\s\S]*?'audit'/);
        expect(body).toContain("findingType === 'major_nc' ? 'high' : 'medium'");
        // Same transactionId on BOTH statements — both rows or neither
        expect((body.match(/transactionId,/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(body).toContain('spawnedNcId');
      });

      it('observations and OFIs never spawn NCs', () => {
        const body = WRITEBACK_CODE.slice(
          WRITEBACK_CODE.indexOf('async function executeAuditFindingWrite'),
          WRITEBACK_CODE.indexOf('async function executeChecklistGen'),
        );
        // The NC insert is guarded by the major/minor check ONLY
        expect(body).not.toContain("'observation' ||");
        expect(body).not.toContain("'ofi' ||");
      });
    });

    describe('rca-write (C1 CAPA Studio RCA — m2.root_cause_analyses, 003)', () => {
      it('INSERT matches migration 003 columns; method validated against the CHECK', () => {
        expect(MIGRATION_003).toContain(
          "method TEXT NOT NULL CHECK (method IN ('5why', 'fishbone', 'fta'))",
        );
        expect(WRITEBACK_CODE).toMatch(
          /INSERT INTO m2\.root_cause_analyses \(tenant_id, nc_id, method, findings, root_cause_summary, created_by\)/,
        );
        // Fail-closed on unknown methods BEFORE SQL
        expect(WRITEBACK_CODE).toContain("['5why', 'fishbone', 'fta'].includes(method)");
        // Structured findings stored as JSON text (findings TEXT NOT NULL)
        expect(WRITEBACK_CODE).toMatch(/executeRcaWrite[\s\S]*?JSON\.stringify\(findings\)/);
        // Tenant scoping via the RLS setting, never a payload value
        expect(WRITEBACK_CODE).toMatch(
          /INSERT INTO m2\.root_cause_analyses[\s\S]*?current_setting\('app\.tenant_id'\)/,
        );
      });

      it('audits under M2', () => {
        expect(WRITEBACK_CODE).toMatch(/'rca-write': 'M2'/);
      });
    });

    describe('manual-section-draft (S3 Manual Studio — delegation semantics)', () => {
      it('delegates to the GEN-6 engine with the approved sentences as override (no SQL forked here)', () => {
        // The one writeback that must NOT write m1/qms SQL directly — the
        // regeneration engine owns the version derivation.
        expect(WRITEBACK_CODE).toMatch(
          /executeManualSectionDraft[\s\S]*?FunctionName: REGEN_FN_NAME/,
        );
        expect(WRITEBACK_CODE).toMatch(/executeManualSectionDraft[\s\S]*?override: \{ sentences/);
        // Actor (agent+human) threads through to the engine's version author
        expect(WRITEBACK_CODE).toMatch(/executeManualSectionDraft[\s\S]*?actor,/);
        // No direct SQL inside the executor body (delegation, not duplication)
        const body = WRITEBACK_CODE.split('async function executeManualSectionDraft')[1].split(
          'async function ',
        )[0];
        expect(body).not.toContain('INSERT INTO');
        expect(body).not.toContain('UPDATE ');
      });

      it('guards: empty sentences, missing target, unconfigured engine all throw typed errors', () => {
        expect(WRITEBACK_CODE).toContain('MANUAL_SECTION_DRAFT_EMPTY');
        expect(WRITEBACK_CODE).toContain('MANUAL_SECTION_DRAFT_MISSING_TARGET');
        expect(WRITEBACK_CODE).toContain('REGEN_FN_UNCONFIGURED');
      });

      it('audits under M1', () => {
        expect(WRITEBACK_CODE).toMatch(/'manual-section-draft': 'M1'/);
      });
    });

    it('throws on unknown tools (never silently drops)', () => {
      expect(WRITEBACK_CODE).toContain('Unknown writeback tool:');
    });
  });

  describe('DB_NAME configuration (C-3e)', () => {
    it('defaults to postgres (matching api-core DATABASE setting)', () => {
      expect(WRITEBACK_CODE).toContain("DB_NAME = process.env.DB_NAME ?? 'postgres'");
    });
  });

  describe('Aurora resume-retry (M-1)', () => {
    it('wraps BeginTransaction in withResumeRetry', () => {
      expect(WRITEBACK_CODE).toMatch(/withResumeRetry.*BeginTransactionCommand/s);
    });

    it('handles DatabaseResumingException', () => {
      expect(WRITEBACK_CODE).toContain('DatabaseResumingException');
    });
  });

  describe('Audit event emission (H-3)', () => {
    it('uses publish() from eventing publisher (not hand-rolled PutEvents)', () => {
      expect(WRITEBACK_CODE).toContain("from '../../eventing/src/publisher.js'");
      expect(WRITEBACK_CODE).toContain('await publish(');
    });

    it('uses ULID for eventId (not timestamp-based)', () => {
      expect(WRITEBACK_CODE).toContain("import { ulid } from 'ulid'");
      expect(WRITEBACK_CODE).toContain('const eventId = ulid()');
      // The eventId assignment should NOT use Date.now() or timestamp patterns
      const eventIdLine = WRITEBACK_CODE.split('\n').find((l) => l.includes('const eventId ='));
      expect(eventIdLine).toContain('ulid()');
      expect(eventIdLine).not.toContain('Date.now');
    });

    it('resolves standard from proposedAction context (not hardcoded ISO9001)', () => {
      expect(WRITEBACK_CODE).toContain('resolveStandard');
      // The emit function should pass opts.standard (a variable), not a literal 'ISO9001'
      // Check that the call to publish uses opts.standard not a hardcoded string
      const emitFnBody = WRITEBACK_CODE.slice(
        WRITEBACK_CODE.indexOf('async function emitWritebackAuditEvent'),
        WRITEBACK_CODE.lastIndexOf('}'),
      );
      // The standard field in the publish call should reference opts.standard
      expect(emitFnBody).toContain('standard: opts.standard');
    });
  });
});

// ─── Approval-gate behavior (BUG-15) ─────────────────────────────────────────
// The gate previously checked approvalResult.approved — a field the real
// approval Lambda NEVER sends (its SendTaskSuccess output is the owner-signed
// design §2.3 contract {decision, approverSub, ...}) — so every live human
// APPROVE was silently treated as rejected while the SFN reported success.
// These tests execute the real handler against the signed contract.
import { handler as writebackHandler } from '../execute-writeback.js';

describe('execute-writeback approval gate (signed contract — BUG-15)', () => {
  const baseInput = {
    tenantId: 'tenant-gate',
    agentName: 'CAPAGuru',
    proposedAction: {
      tool: 'capa-open',
      args: { ncId: 'nc-1', actionDesc: 'proposed', suggestedOwnerId: 'o', dueDate: '2026-08-01' },
    },
    hitlItemId: '01GATE',
  };

  it('SEND_BACK short-circuits to REJECTED without touching RDS', async () => {
    const res = await writebackHandler({
      ...baseInput,
      approvalResult: { decision: 'SEND_BACK', approverSub: 'sub-1' },
    } as never);
    expect(res).toEqual({ status: 'REJECTED' });
  });

  it('the legacy {approved:true} shape no longer approves (contract cutover pin)', async () => {
    // If someone re-introduces a producer of the old shape, it must fail
    // CLOSED (rejected), never silently write.
    const res = await writebackHandler({
      ...baseInput,
      approvalResult: { approved: true, approver: 'sub-1', role: 'r', timestamp: 't' },
    } as never);
    expect(res).toEqual({ status: 'REJECTED' });
  });

  it('source: gate checks decision === APPROVE and actor uses approverSub', () => {
    expect(WRITEBACK_CODE).toContain("approvalResult.decision !== 'APPROVE'");
    expect(WRITEBACK_CODE).toContain('approvalResult.approverSub');
    expect(WRITEBACK_CODE).not.toMatch(/approvalResult\.approved\b/);
  });

  it('source: editedPayload overrides proposed args field-by-field (approve-with-edits)', () => {
    expect(WRITEBACK_CODE).toContain('...proposedAction.args, ...approvalResult.editedPayload');
    expect(WRITEBACK_CODE).toContain('dispatchToolWrite(effectiveAction');
  });
});
