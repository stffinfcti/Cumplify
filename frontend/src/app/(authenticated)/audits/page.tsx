'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  PageHeader,
  Panel,
  SecondaryButton,
  StatusBadge,
  ClauseChip,
  EmptyState,
  ErrorState,
} from '@/components/shared';
import { StudioShell, AgentRunButton } from '@/components/studio';
import { useGraphQL } from '@/lib/api';
import { errorText } from '@/lib/error-text';
import styles from './page.module.css';

/**
 * /audits — AUDIT STUDIO (S4, studio wave).
 * Doctrine #1: the big button IS the agent — LeadAuditor proposes the most
 * significant finding from the audit's checklist evidence; the
 * audit-finding-write HITL card is the deliverable. Approving a major/minor
 * NC finding ALSO opens the NC in CAPA Studio (cross-studio loop).
 * Scheduling/programmes stay on /m3 (audit planning).
 */

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const LIST_AUDITS = `query ListAudits { listAudits { id programmeId standard scope leadAuditorId plannedDate actualDate status } }`;

const LIST_FINDINGS = `query ListAuditFindings($auditId: ID!) {
  listAuditFindings(auditId: $auditId) { id auditId findingType clauseRef description }
}`;

const LIST_CHECKLISTS = `query ListAuditChecklists($auditId: ID!) {
  listAuditChecklists(auditId: $auditId) { id auditId clauseRef question expectedEvidence }
}`;

const GENERATE_CHECKLIST = `mutation GenerateAuditChecklist($auditId: ID!) {
  generateAuditChecklist(auditId: $auditId) { id clauseRef question }
}`;

const RUN_AUDIT_FINDINGS = `mutation RunAuditFindings($auditId: ID!) {
  runAuditFindings(auditId: $auditId) { runId status }
}`;

const COMPLETE_AUDIT = `mutation CompleteAudit($id: ID!) {
  completeAudit(id: $id) { id status actualDate }
}`;

const GET_AUDIT_READINESS = `query GetAuditReadiness($standard: Standard!) {
  getAuditReadiness(standard: $standard) { id standard clauseRef score assessedAt }
}`;

interface Audit {
  id: string;
  programmeId: string;
  standard: string;
  scope: string;
  leadAuditorId: string;
  plannedDate: string;
  actualDate: string | null;
  status: string;
}

interface Finding {
  id: string;
  findingType: string;
  clauseRef: string;
  description: string;
}

interface ChecklistItem {
  id: string;
  clauseRef: string;
  question: string;
  expectedEvidence: string | null;
}

interface ReadinessScore {
  id: string;
  standard: string;
  clauseRef: string;
  score: number;
  assessedAt: string;
}

export default function AuditStudioPage() {
  const t = useTranslations('auditStudio');
  const tErr = useTranslations('errors');
  const router = useRouter();
  const { query, mutate } = useGraphQL();

  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [openAuditId, setOpenAuditId] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [readinessScores, setReadinessScores] = useState<ReadinessScore[]>([]);
  const [loadingReadiness, setLoadingReadiness] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [readinessFetched, setReadinessFetched] = useState(false);

  const fetchAudits = useCallback(async () => {
    try {
      setError(false);
      const data = await query<{ listAudits: Audit[] }>(LIST_AUDITS);
      setAudits(data.listAudits);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchAudits();
  }, [fetchAudits]);

  const fetchDetail = useCallback(
    async (auditId: string) => {
      try {
        const [f, c] = await Promise.all([
          query<{ listAuditFindings: Finding[] }>(LIST_FINDINGS, { auditId }),
          query<{ listAuditChecklists: ChecklistItem[] }>(LIST_CHECKLISTS, { auditId }),
        ]);
        setFindings(f.listAuditFindings);
        setChecklist(c.listAuditChecklists);
      } catch {
        // Detail loads are non-critical — panels show empty states
      }
    },
    [query],
  );

  function toggleAudit(auditId: string) {
    if (openAuditId === auditId) {
      setOpenAuditId(null);
      return;
    }
    setOpenAuditId(auditId);
    setFindings([]);
    setChecklist([]);
    setReadinessScores([]);
    setReadinessError(null);
    setReadinessFetched(false);
    setCompleteError(null);
    fetchDetail(auditId);
  }

  async function handleGenerateChecklist(auditId: string) {
    setGenerating(true);
    setGenError(null);
    try {
      await mutate(GENERATE_CHECKLIST, { auditId });
      await fetchDetail(auditId);
    } catch (e) {
      setGenError(errorText(e, tErr, 'generic'));
    } finally {
      setGenerating(false);
    }
  }

  async function handleCompleteAudit(audit: Audit) {
    setCompleting(true);
    setCompleteError(null);
    try {
      await mutate(COMPLETE_AUDIT, { id: audit.id });
      await fetchAudits();
    } catch (e) {
      setCompleteError(errorText(e, tErr, 'generic'));
    } finally {
      setCompleting(false);
    }
  }

  async function handleFetchReadiness(standard: string) {
    setLoadingReadiness(true);
    setReadinessError(null);
    try {
      const data = await query<{ getAuditReadiness: ReadinessScore[] }>(GET_AUDIT_READINESS, {
        standard,
      });
      setReadinessScores(data.getAuditReadiness);
    } catch (e) {
      setReadinessScores([]);
      setReadinessError(errorText(e, tErr, 'generic'));
    } finally {
      setReadinessFetched(true);
      setLoadingReadiness(false);
    }
  }

  if (error) return <ErrorState onRetry={fetchAudits} />;

  return (
    <>
      <PageHeader title={t('title')} />
      <StudioShell
        railLabel={t('railLabel')}
        rail={
          <div className={styles.rail}>
            <h3 className={styles.railTitle}>{t('railTitle')}</h3>
            <p className={styles.railHint}>{t('railHint')}</p>
            <SecondaryButton onClick={() => router.push('/m3')}>
              {t('goToPlanning')}
            </SecondaryButton>
          </div>
        }
      >
        {loading ? (
          <p className={styles.loading}>{t('loading')}</p>
        ) : audits.length === 0 ? (
          <EmptyState
            message={t('empty')}
            action={
              <SecondaryButton onClick={() => router.push('/m3')}>
                {t('goToPlanning')}
              </SecondaryButton>
            }
          />
        ) : (
          <Panel title={t('auditsTitle')}>
            <div className={styles.auditList}>
              {audits.map((a) => (
                <div key={a.id} className={styles.auditBlock}>
                  <button
                    type="button"
                    className={styles.auditRow}
                    onClick={() => toggleAudit(a.id)}
                    data-testid={`audit-row-${a.id}`}
                  >
                    <span className={styles.scope}>{a.scope}</span>
                    <ClauseChip standard={a.standard} clauseRef={null} />
                    <StatusBadge status={a.status} />
                    <span className={styles.date}>
                      {new Date(a.plannedDate).toLocaleDateString()}
                    </span>
                  </button>

                  {openAuditId === a.id && (
                    <div className={styles.detail}>
                      {/* Checklist */}
                      <div className={styles.detailSection}>
                        <div className={styles.detailHeader}>
                          <span className={styles.detailTitle}>
                            {t('checklist')} ({checklist.length})
                          </span>
                          <SecondaryButton
                            onClick={() => handleGenerateChecklist(a.id)}
                            disabled={generating}
                          >
                            {generating ? t('generating') : t('generateChecklist')}
                          </SecondaryButton>
                        </div>
                        {genError && <p className={styles.errorMsg}>{genError}</p>}
                        {checklist.slice(0, 6).map((c) => (
                          <p key={c.id} className={styles.checklistItem}>
                            <span className={styles.clauseTag}>{c.clauseRef}</span> {c.question}
                          </p>
                        ))}
                        {checklist.length > 6 && (
                          <p className={styles.moreHint}>
                            {t('moreItems', { count: checklist.length - 6 })}
                          </p>
                        )}
                      </div>

                      {/* Findings + the agent front door */}
                      <div className={styles.detailSection}>
                        <div className={styles.detailHeader}>
                          <span className={styles.detailTitle}>
                            {t('findings')} ({findings.length})
                          </span>
                          <AgentRunButton
                            label={t('proposeFinding')}
                            mutation={RUN_AUDIT_FINDINGS}
                            variables={{ auditId: a.id }}
                            agentName="LeadAuditor"
                            onResolved={() => fetchDetail(a.id)}
                          />
                        </div>
                        {findings.length === 0 ? (
                          <p className={styles.emptyHint}>{t('noFindings')}</p>
                        ) : (
                          findings.map((f) => (
                            <div key={f.id} className={styles.findingRow}>
                              <StatusBadge
                                status={
                                  f.findingType === 'MAJOR_NC'
                                    ? 'REJECTED'
                                    : f.findingType === 'MINOR_NC'
                                      ? 'PENDING'
                                      : 'DRAFT'
                                }
                              />
                              <span className={styles.clauseTag}>{f.clauseRef}</span>
                              <span className={styles.findingDesc}>{f.description}</span>
                            </div>
                          ))
                        )}
                      </div>

                      {/* Readiness scoring */}
                      <div className={styles.detailSection}>
                        <div className={styles.detailHeader}>
                          <span className={styles.detailTitle}>{t('readinessTitle')}</span>
                          <SecondaryButton
                            onClick={() => handleFetchReadiness(a.standard)}
                            disabled={loadingReadiness}
                          >
                            {loadingReadiness ? t('loadingReadiness') : t('viewReadiness')}
                          </SecondaryButton>
                        </div>
                        {readinessError && <p className={styles.errorMsg}>{readinessError}</p>}
                        {!readinessError && readinessFetched && readinessScores.length === 0 && (
                          <p className={styles.emptyHint}>{t('readinessEmpty')}</p>
                        )}
                        {readinessScores.length > 0 && (
                          <div className={styles.readinessGrid}>
                            {readinessScores.map((rs) => (
                              <div key={rs.id} className={styles.readinessItem}>
                                <span className={styles.clauseTag}>{rs.clauseRef}</span>
                                <StatusBadge
                                  status={
                                    rs.score >= 100
                                      ? 'APPROVED'
                                      : rs.score > 0
                                        ? 'PENDING'
                                        : 'DRAFT'
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Complete audit action */}
                      {a.status !== 'completed' && (
                        <div className={styles.detailSection}>
                          <div className={styles.detailHeader}>
                            <span className={styles.detailTitle}>{t('completeTitle')}</span>
                            <SecondaryButton
                              onClick={() => handleCompleteAudit(a)}
                              disabled={completing}
                            >
                              {completing ? t('completing') : t('completeAudit')}
                            </SecondaryButton>
                          </div>
                          {completeError && <p className={styles.errorMsg}>{completeError}</p>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}
      </StudioShell>
    </>
  );
}
