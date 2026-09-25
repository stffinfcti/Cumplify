'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  PageHeader,
  Panel,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  ErrorState,
} from '@/components/shared';
import { GuidanceBanner } from '@/components/shared/GuidanceBanner';
import { StatTile } from '@/components/shared/StatTile';
import { useGraphQL } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import { canApprove } from '@/lib/role-matrix';
import { ControlledDocViewer } from '@/components/controlled-doc/ControlledDocViewer';
import { AgentRunButton } from '@/components/studio';
import styles from './page.module.css';

/**
 * /manual — IMS Manual (P2 hero surface).
 * §4 row: 5.2 Policy controlled + communicated; 4.1–4.3 Context/scope.
 * Agent-First: the Generate button IS DocStudio working.
 * Per ims-experience/view-designs.md §8.
 */

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const GET_PROFILE = `query GetOrgProfile { getOrgProfile { id currentVersion payload updatedAt } }`;

const GENERATE_IMS_MANUAL = `mutation GenerateImsManual($input: GenerateImsManualInput) {
  generateImsManual(input: $input) {
    id status standards sections { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
    manualDocumentId gapCount startedAt finishedAt
  }
}`;

const LIST_GENERATION_RUNS = `query ListGenerationRuns($limit: Int) {
  listGenerationRuns(limit: $limit) {
    id status standards sections { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
    manualDocumentId gapCount startedAt finishedAt
  }
}`;

const GET_GENERATION_RUN = `query GetGenerationRun($id: ID!) {
  getGenerationRun(id: $id) {
    id status standards sections { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
    manualDocumentId gapCount startedAt finishedAt
  }
}`;

const GET_DOCUMENT_CONTENT = `query GetDocumentContent($versionId: ID!) {
  getDocumentContent(versionId: $versionId)
}`;

const LIST_DOCUMENT_VERSIONS = `query ListDocumentVersions($documentId: ID!) {
  listDocumentVersions(documentId: $documentId) {
    id documentId versionNo contentRef changeSummary authorId createdAt
  }
}`;

// S3 (Manual Studio): gap burn-down — DocStudio drafts ONE section's prose,
// the manual-section-draft HITL card is the deliverable.
const RUN_MANUAL_SECTION_DRAFT = `mutation RunManualSectionDraft($runId: ID!, $harmonizationKey: String!) {
  runManualSectionDraft(runId: $runId, harmonizationKey: $harmonizationKey) { runId status }
}`;

const MARK_SECTION_REVIEWED = `mutation MarkSectionReviewed($input: MarkSectionReviewedInput!) {
  markSectionReviewed(input: $input) { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
}`;

const SUBMIT_FOR_APPROVAL = `mutation SubmitDocumentForApproval($id: ID!) {
  submitDocumentForApproval(id: $id) { id status }
}`;

const REQUEST_IMS_EXPORT = `mutation RequestImsExport($documentId: ID!) {
  requestImsExport(documentId: $documentId) { url expiresAt }
}`;

const ON_GENERATION_PROGRESS = `subscription OnGenerationProgress($tenantId: ID!) {
  onGenerationProgress(tenantId: $tenantId) { runId type harmonizationKey kind summary }
}`;

// ─── Types ───────────────────────────────────────────────────────────────────

type SectionKind = 'PROSE' | 'GAP' | 'NA_JUSTIFIED' | 'FAILED' | 'PENDING';

interface GenerationSection {
  id: string;
  harmonizationKey: string;
  kind: SectionKind;
  clauseRefs: string;
  contentSha256: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  error: string | null;
}

interface GenerationRun {
  id: string;
  status: 'RUNNING' | 'COMPLETE' | 'FAILED' | 'PARTIAL';
  standards: string[];
  sections: GenerationSection[];
  manualDocumentId: string | null;
  gapCount: number;
  startedAt: string;
  finishedAt: string | null;
}

interface GenerationEvent {
  onGenerationProgress?: {
    runId: string;
    type: string;
    harmonizationKey: string | null;
    kind: SectionKind | null;
    summary: string | null;
  };
}

type PageState = 'loading' | 'no-profile' | 'no-runs' | 'running' | 'complete';

// ─── Component ───────────────────────────────────────────────────────────────

export default function ManualPage() {
  const t = useTranslations('manual');
  const router = useRouter();
  const { query, mutate } = useGraphQL();
  const { user } = useAuth();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [activeRun, setActiveRun] = useState<GenerationRun | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentContent, setDocumentContent] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Initial load: profile check + latest run ──────────────────────────────
  const initialize = useCallback(async () => {
    try {
      const [profileData, runsData] = await Promise.all([
        query<{ getOrgProfile: { payload: string } | null }>(GET_PROFILE),
        query<{ listGenerationRuns: GenerationRun[] }>(LIST_GENERATION_RUNS, { limit: 5 }),
      ]);

      if (!profileData.getOrgProfile?.payload) {
        setPageState('no-profile');
        return;
      }

      const runs = runsData.listGenerationRuns;
      if (runs.length === 0) {
        setPageState('no-runs');
        return;
      }

      // listGenerationRuns is deliberately lightweight (sections: [],
      // gapCount: 0) — hydrate the full run before rendering State 3/4.
      // Rendering off the list row zeroed every StatTile and emptied the
      // section list (found live 2026-07-22 at the design gate; masked
      // until then because the dev tenant had no runs).
      const detailData = await query<{ getGenerationRun: GenerationRun | null }>(
        GET_GENERATION_RUN,
        { id: runs[0].id },
      );
      const latest = detailData.getGenerationRun ?? runs[0];
      setActiveRun(latest);
      setDocumentId(latest.manualDocumentId);

      if (latest.status === 'RUNNING') {
        setPageState('running');
      } else {
        setPageState('complete');
        if (latest.manualDocumentId) {
          await loadDocumentContent(latest.manualDocumentId);
        }
      }
    } catch {
      setError('load');
    }
  }, [query]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // ─── Load document content for the viewer ──────────────────────────────────
  async function loadDocumentContent(docId: string) {
    try {
      const versionsData = await query<{
        listDocumentVersions: Array<{ id: string; versionNo: number }>;
      }>(LIST_DOCUMENT_VERSIONS, { documentId: docId });
      const versions = versionsData.listDocumentVersions;
      if (versions.length === 0) return;
      // Latest version
      const latestVersion = versions[0];
      const contentData = await query<{ getDocumentContent: string }>(GET_DOCUMENT_CONTENT, {
        versionId: latestVersion.id,
      });
      setDocumentContent(contentData.getDocumentContent);
    } catch {
      // Content may not be available yet — graceful
    }
  }

  // ─── Refetch active run (for polling) ──────────────────────────────────────
  const refetchActiveRun = useCallback(async () => {
    if (!activeRun) return;
    try {
      const data = await query<{ getGenerationRun: GenerationRun }>(GET_GENERATION_RUN, {
        id: activeRun.id,
      });
      setActiveRun(data.getGenerationRun);
      if (data.getGenerationRun.status !== 'RUNNING') {
        setPageState('complete');
        if (data.getGenerationRun.manualDocumentId) {
          setDocumentId(data.getGenerationRun.manualDocumentId);
          await loadDocumentContent(data.getGenerationRun.manualDocumentId);
        }
      }
    } catch {
      /* fallback: user can retry manually */
    }
  }, [activeRun, query]);

  // ─── Polling fallback: 10s while RUNNING ───────────────────────────────────
  useEffect(() => {
    if (pageState === 'running' && activeRun?.status === 'RUNNING') {
      pollTimer.current = setInterval(refetchActiveRun, 10_000);
    } else {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [pageState, activeRun?.status, refetchActiveRun]);

  // ─── WebSocket: live progress ──────────────────────────────────────────────
  useTenantSubscription<GenerationEvent>({
    query: ON_GENERATION_PROGRESS,
    onData: (data) => {
      const evt = data.onGenerationProgress;
      if (!evt || !activeRun || evt.runId !== activeRun.id) return;
      if (evt.type === 'Generation.RunCompleted') {
        refetchActiveRun();
      } else if (
        evt.type === 'Generation.SectionComposed' ||
        evt.type === 'Generation.SectionFailed'
      ) {
        setActiveRun((prev) => {
          if (!prev) return prev;
          const kind = evt.kind ?? (evt.type === 'Generation.SectionFailed' ? 'FAILED' : 'PROSE');
          const sections = prev.sections.map((s) =>
            s.harmonizationKey === evt.harmonizationKey ? { ...s, kind } : s,
          );
          if (!sections.find((s) => s.harmonizationKey === evt.harmonizationKey)) {
            sections.push({
              id: `pending-${evt.harmonizationKey}`,
              harmonizationKey: evt.harmonizationKey ?? '',
              kind,
              clauseRefs: '[]',
              contentSha256: null,
              reviewedBy: null,
              reviewedAt: null,
              error: evt.type === 'Generation.SectionFailed' ? t('sectionFailed') : null,
            });
          }
          return { ...prev, sections };
        });
      }
    },
    enabled: pageState === 'running' && !!activeRun,
  });

  // ─── Generate action ───────────────────────────────────────────────────────
  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const data = await mutate<{ generateImsManual: GenerationRun }>(GENERATE_IMS_MANUAL, {
        input: {},
      });
      setActiveRun(data.generateImsManual);
      setPageState('running');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('ORG_PROFILE_REQUIRED')) {
        setPageState('no-profile');
      } else if (msg.includes('NO_STANDARDS_IN_SCOPE')) {
        setError('noStandards');
      } else {
        setError('unavailable');
      }
    } finally {
      setGenerating(false);
    }
  }

  // ─── Mark section reviewed ─────────────────────────────────────────────────
  async function handleMarkReviewed(sectionId: string) {
    try {
      const data = await mutate<{ markSectionReviewed: GenerationSection }>(MARK_SECTION_REVIEWED, {
        input: { sectionId },
      });
      setActiveRun((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sections: prev.sections.map((s) => (s.id === sectionId ? data.markSectionReviewed : s)),
        };
      });
    } catch {
      /* server enforces */
    }
  }

  // ─── Submit for approval ───────────────────────────────────────────────────
  async function handleSubmitForApproval() {
    if (!documentId) return;
    setSubmitError(null);
    setSubmitSuccess(false);
    try {
      await mutate(SUBMIT_FOR_APPROVAL, { id: documentId });
      setSubmitSuccess(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('UNREVIEWED_SECTIONS')) setSubmitError(t('unreviewedSections'));
      else if (msg.includes('UNRESOLVED_GAPS')) setSubmitError(t('unresolvedGaps'));
      else if (msg.includes('SoD') || msg.includes('SOD')) setSubmitError(t('sodViolation'));
      else setSubmitError(msg || t('error'));
    }
  }

  // ─── Export ZIP ────────────────────────────────────────────────────────────
  async function handleExport() {
    if (!documentId) return;
    setExportError(null);
    try {
      const data = await mutate<{ requestImsExport: { url: string; expiresAt: string } }>(
        REQUEST_IMS_EXPORT,
        { documentId },
      );
      window.open(data.requestImsExport.url, '_blank');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('Unknown field') || msg.includes('EXPORT_NOT_AVAILABLE')) {
        setExportError(t('exportBlocked'));
      } else {
        setExportError(msg || t('error'));
      }
    }
  }

  // ─── Computed stats ────────────────────────────────────────────────────────
  const stats = activeRun
    ? {
        total: activeRun.sections.length,
        prose: activeRun.sections.filter((s) => s.kind === 'PROSE').length,
        gaps: activeRun.gapCount,
        reviewed: activeRun.sections.filter((s) => s.reviewedBy).length,
      }
    : null;

  // ─── Render ────────────────────────────────────────────────────────────────

  if (error === 'load') return <ErrorState onRetry={initialize} />;

  return (
    <>
      <PageHeader title={t('title')} />

      {/* State 1: No profile */}
      {pageState === 'no-profile' && (
        <GuidanceBanner
          message={t('profileRequired')}
          action={{ label: t('goToSetup'), onClick: () => router.push('/setup') }}
          variant="warning"
        />
      )}

      {/* State 2: Profile exists, no runs */}
      {pageState === 'no-runs' && (
        <div className={styles.generateSection}>
          <GuidanceBanner message={t('readyToGenerate')} variant="info" />
          <PrimaryButton onClick={handleGenerate} disabled={generating}>
            {generating ? t('generating') : t('generate')}
          </PrimaryButton>
        </div>
      )}

      {/* Error states */}
      {error === 'noStandards' && (
        <GuidanceBanner
          message={t('noStandards')}
          action={{ label: t('goToSetup'), onClick: () => router.push('/setup') }}
          variant="warning"
        />
      )}
      {error === 'unavailable' && <ErrorState onRetry={handleGenerate} />}

      {/* State 3: Running */}
      {pageState === 'running' && activeRun && (
        <Panel title={t('generationProgress')} subtitle={t('generationRunning')}>
          <div className={styles.sectionList}>
            {activeRun.sections.map((section) => (
              <div
                key={section.id}
                className={`${styles.sectionRow} ${styles[`kind${section.kind}`] ?? ''}`}
              >
                <span className={styles.sectionKey}>{section.harmonizationKey}</span>
                <StatusBadge
                  status={
                    section.kind === 'PROSE'
                      ? 'APPROVED'
                      : section.kind === 'GAP'
                        ? 'PENDING'
                        : section.kind === 'FAILED'
                          ? 'REJECTED'
                          : 'IN_PROGRESS'
                  }
                />
                {section.error && <span className={styles.sectionError}>{section.error}</span>}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* State 4: Complete */}
      {pageState === 'complete' && activeRun && (
        <>
          {/* StatTile row */}
          {stats && (
            <div className={styles.statRow}>
              <StatTile label={t('statTotal')} value={stats.total} />
              <StatTile label={t('statProse')} value={stats.prose} variant="success" />
              <StatTile
                label={t('statGaps')}
                value={stats.gaps}
                variant={stats.gaps > 0 ? 'warning' : 'success'}
              />
              <StatTile label={t('statReviewed')} value={`${stats.reviewed}/${stats.total}`} />
            </div>
          )}

          {/* Action bar */}
          <div className={styles.actionBar}>
            <SecondaryButton onClick={handleGenerate} disabled={generating}>
              {generating ? t('generating') : t('regenerate')}
            </SecondaryButton>
            <PrimaryButton onClick={handleExport}>{t('exportZip')}</PrimaryButton>
            {user && canApprove(user.role, 'M1') && (
              <PrimaryButton onClick={handleSubmitForApproval}>
                {t('submitForApproval')}
              </PrimaryButton>
            )}
          </div>

          {/* Submit feedback */}
          {submitSuccess && <p className={styles.successMsg}>{t('submitSuccess')}</p>}
          {submitError && <p className={styles.errorMsg}>{submitError}</p>}
          {exportError && <p className={styles.errorMsg}>{exportError}</p>}

          {/* Section review list */}
          <Panel title={t('sections')} className={styles.sectionPanel}>
            <div className={styles.sectionList}>
              {activeRun.sections.map((section) => (
                <div
                  key={section.id}
                  className={`${styles.sectionRow} ${styles[`kind${section.kind}`] ?? ''}`}
                >
                  <span className={styles.sectionKey}>{section.harmonizationKey}</span>
                  <StatusBadge
                    status={
                      section.kind === 'PROSE'
                        ? 'APPROVED'
                        : section.kind === 'GAP'
                          ? 'PENDING'
                          : section.kind === 'FAILED'
                            ? 'REJECTED'
                            : section.kind === 'NA_JUSTIFIED'
                              ? 'CLOSED'
                              : 'DRAFT'
                    }
                  />
                  {section.reviewedBy ? (
                    <span className={styles.reviewed}>{t('reviewed')}</span>
                  ) : (
                    section.kind === 'PROSE' &&
                    user &&
                    canApprove(user.role, 'M1') && (
                      <button
                        type="button"
                        className={styles.reviewBtn}
                        onClick={() => handleMarkReviewed(section.id)}
                      >
                        {t('markReviewed')}
                      </button>
                    )
                  )}
                  {/* S3 gap burn-down: the GAP's big button IS DocStudio.
                      Approval regenerates the manual through GEN-6 with the
                      approved sentences — gapCount drops on refresh. */}
                  {(section.kind === 'GAP' || section.kind === 'FAILED') && (
                    <AgentRunButton
                      label={t('draftSection')}
                      mutation={RUN_MANUAL_SECTION_DRAFT}
                      variables={{
                        runId: activeRun.id,
                        harmonizationKey: section.harmonizationKey,
                      }}
                      agentName="DocStudio"
                      onResolved={initialize}
                    />
                  )}
                </div>
              ))}
            </div>
          </Panel>

          {/* ControlledDocViewer */}
          {documentContent && documentId && (
            <ControlledDocViewer
              contentRaw={documentContent}
              documentId={documentId}
              className={styles.viewer}
            />
          )}
        </>
      )}

      {/* Loading */}
      {pageState === 'loading' && <p className={styles.loading}>{t('loading')}</p>}
    </>
  );
}
