'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Panel,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  ErrorState,
} from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { canApprove } from '@/lib/role-matrix';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import styles from './page.module.css';

// ─── GraphQL statements ──────────────────────────────────────────────────────

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

const MARK_SECTION_REVIEWED = `mutation MarkSectionReviewed($input: MarkSectionReviewedInput!) {
  markSectionReviewed(input: $input) { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
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
  clauseRefs: string; // AWSJSON of clause_registry_ids (UUIDs)
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

/** Registry entry shape from listClauseRegistry (passed in from page.tsx) */
export interface RegistryEntry {
  id: string;
  standard: string;
  clauseNo: string;
  clauseTitle: string;
  requiredSources: string; // AWSJSON
}

// ─── GAP source → module link map (keyed by requiredSources values) ──────────

const GAP_SOURCE_LINKS: Record<string, { path: string; labelKey: string }> = {
  'register.training_records': { path: '/forms', labelKey: 'gapLinkTraining' },
  'register.risk_assessments': { path: '/m5', labelKey: 'gapLinkRisk' },
  'register.audit_findings': { path: '/m3', labelKey: 'gapLinkAudit' },
  'register.calibration_records': { path: '/m4', labelKey: 'gapLinkRecords' },
  'register.incident_records': { path: '/m2', labelKey: 'gapLinkCapa' },
  'register.aspects_register': { path: '/m5', labelKey: 'gapLinkRisk' },
  'register.legal_obligations': { path: '/forms', labelKey: 'gapLinkLegal' },
  'register.objectives': { path: '/forms', labelKey: 'gapLinkObjectives' },
};

// ─── Component ───────────────────────────────────────────────────────────────

interface GenerationViewProps {
  onViewDocument: (documentId: string) => void;
  /** Registry map: id → entry. Used for clause number display + GAP CTA. */
  registryMap: Map<string, RegistryEntry>;
}

export function GenerationView({ onViewDocument, registryMap }: GenerationViewProps) {
  const t = useTranslations('qms.generation');
  const { query, mutate } = useGraphQL();
  const { user } = useAuth();

  const [runs, setRuns] = useState<GenerationRun[]>([]);
  const [activeRun, setActiveRun] = useState<GenerationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Load runs ─────────────────────────────────────────────────────────────
  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await query<{ listGenerationRuns: GenerationRun[] }>(LIST_GENERATION_RUNS, {
        limit: 10,
      });
      setRuns(data.listGenerationRuns);
      // Only adopt the newest run when nothing is selected or the selected
      // run vanished — a progress event for a different run must not yank
      // the user off the run they're reading.
      setActiveRun((prev) => {
        if (!prev) return data.listGenerationRuns[0] ?? null;
        return (
          data.listGenerationRuns.find((r) => r.id === prev.id) ??
          data.listGenerationRuns[0] ??
          null
        );
      });
    } catch {
      setError('load');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // ─── Refetch active run ────────────────────────────────────────────────────
  const refetchActiveRun = useCallback(async () => {
    if (!activeRun) return;
    try {
      const data = await query<{ getGenerationRun: GenerationRun }>(GET_GENERATION_RUN, {
        id: activeRun.id,
      });
      setActiveRun(data.getGenerationRun);
      setRuns((prev) =>
        prev.map((r) => (r.id === data.getGenerationRun.id ? data.getGenerationRun : r)),
      );
    } catch {
      /* fallback: user can retry manually */
    }
  }, [activeRun, query]);

  // ─── Polling fallback: 10s while RUNNING ───────────────────────────────────
  useEffect(() => {
    if (activeRun?.status === 'RUNNING') {
      pollTimer.current = setInterval(() => {
        refetchActiveRun();
      }, 10_000);
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
  }, [activeRun?.status, refetchActiveRun]);

  // ─── WebSocket: live progress ──────────────────────────────────────────────
  useTenantSubscription<GenerationEvent>({
    query: ON_GENERATION_PROGRESS,
    onData: (data) => {
      const evt = data.onGenerationProgress;
      if (!evt || !activeRun || evt.runId !== activeRun.id) {
        fetchRuns();
        return;
      }
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
    enabled: !!activeRun && activeRun.status === 'RUNNING',
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
      setRuns((prev) => [data.generateImsManual, ...prev]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('ORG_PROFILE_REQUIRED')) setError('profileRequired');
      else if (msg.includes('NO_STANDARDS_IN_SCOPE')) setError('noStandards');
      else if (msg.includes('GENERATION_UNAVAILABLE')) setError('unavailable');
      else setError('unavailable');
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
      /* server enforces; silent on failure */
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  if (loading) return <p className={styles.loading}>{t('runStatus')}</p>;

  return (
    <div className={styles.generationView} data-testid="generation-view">
      {/* Generate action */}
      <div className={styles.generateAction}>
        <PrimaryButton onClick={handleGenerate} disabled={generating} data-testid="generate-btn">
          {generating ? t('generating') : t('generate')}
        </PrimaryButton>
      </div>

      {/* Typed error states */}
      {error === 'profileRequired' && (
        <div className={styles.errorPanel} data-testid="error-profile-required">
          <p className={styles.errorMsg}>{t('profileRequired')}</p>
          <SecondaryButton data-testid="go-to-profile">{t('goToProfile')}</SecondaryButton>
        </div>
      )}
      {error === 'noStandards' && (
        <div className={styles.errorPanel} data-testid="error-no-standards">
          <p className={styles.errorMsg}>{t('noStandards')}</p>
        </div>
      )}
      {error === 'unavailable' && (
        <div className={styles.errorPanel} data-testid="error-unavailable">
          <p className={styles.errorMsg}>{t('unavailable')}</p>
        </div>
      )}
      {error === 'load' && <ErrorState onRetry={fetchRuns} />}

      {/* Active run view */}
      {activeRun && (
        <Panel title={t('runStatus')}>
          <div className={styles.runHeader}>
            <StatusBadge
              status={
                activeRun.status === 'RUNNING'
                  ? 'IN_PROGRESS'
                  : activeRun.status === 'COMPLETE'
                    ? 'APPROVED'
                    : 'REJECTED'
              }
            />
            <span className={styles.runMeta}>
              {activeRun.sections.length} {t('sectionCount')} &middot; {activeRun.gapCount}{' '}
              {t('gapSection')}
            </span>
            {activeRun.manualDocumentId && (
              <SecondaryButton
                onClick={() => onViewDocument(activeRun.manualDocumentId!)}
                data-testid="view-manual-btn"
              >
                {t('title')}
              </SecondaryButton>
            )}
          </div>

          {/* Section list */}
          <div className={styles.sectionList} data-testid="section-list">
            {activeRun.sections.map((section) => (
              <SectionRow
                key={section.id}
                section={section}
                registryMap={registryMap}
                canReview={!!user && canApprove(user.role, 'M1')}
                onMarkReviewed={handleMarkReviewed}
                t={t}
              />
            ))}
          </div>
        </Panel>
      )}

      {/* Run history (past runs) */}
      {runs.length > 1 && (
        <Panel title={t('runStatus')}>
          <div className={styles.runHistory}>
            {runs.slice(1).map((run) => (
              <button
                key={run.id}
                type="button"
                className={styles.runHistoryItem}
                onClick={() => setActiveRun(run)}
                data-testid={`run-${run.id}`}
              >
                <StatusBadge
                  status={
                    run.status === 'COMPLETE'
                      ? 'APPROVED'
                      : run.status === 'RUNNING'
                        ? 'IN_PROGRESS'
                        : 'REJECTED'
                  }
                />
                <span className={styles.runMeta}>
                  {new Date(run.startedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─── Section Row ─────────────────────────────────────────────────────────────

function SectionRow({
  section,
  registryMap,
  canReview,
  onMarkReviewed,
  t,
}: {
  section: GenerationSection;
  registryMap: Map<string, RegistryEntry>;
  canReview: boolean;
  onMarkReviewed: (id: string) => void;
  t: (key: string) => string;
}) {
  const kindLabel = getKindLabel(section.kind, t);
  const kindClass = getKindClass(section.kind);

  // clauseRefs is AWSJSON of clause_registry_ids (UUIDs) — resolve via registryMap
  let registryIds: string[] = [];
  try {
    registryIds = JSON.parse(section.clauseRefs) as string[];
  } catch {
    /* empty */
  }
  const resolvedEntries = registryIds
    .map((id) => registryMap.get(id))
    .filter(Boolean) as RegistryEntry[];

  // GAP CTA: derive from requiredSources of the resolved registry entries
  const gapSources: Array<{ source: string; link: { path: string; labelKey: string } }> = [];
  if (section.kind === 'GAP') {
    for (const entry of resolvedEntries) {
      let sources: string[] = [];
      try {
        sources = JSON.parse(entry.requiredSources) as string[];
      } catch {
        /* skip */
      }
      for (const src of sources) {
        const link = GAP_SOURCE_LINKS[src];
        if (link && !gapSources.find((g) => g.source === src)) {
          gapSources.push({ source: src, link });
        }
      }
    }
  }

  return (
    <div
      className={`${styles.sectionRow} ${kindClass}`}
      data-testid={`section-${section.harmonizationKey}`}
    >
      <div className={styles.sectionHeader}>
        <span className={styles.sectionKey}>{section.harmonizationKey}</span>
        <span className={`${styles.sectionKind} ${kindClass}`}>{kindLabel}</span>
        {resolvedEntries.length > 0 && (
          <span className={styles.sectionClauses}>
            {resolvedEntries.map((e) => `${e.standard} ${e.clauseNo}`).join(', ')}
          </span>
        )}
      </div>

      {/* GAP CTA links — keyed off requiredSources from registry entries */}
      {section.kind === 'GAP' && gapSources.length > 0 && (
        <div className={styles.gapCta} data-testid={`gap-cta-${section.harmonizationKey}`}>
          {gapSources.map(({ source, link }) => (
            <Link key={source} href={link.path} className={styles.gapLink}>
              {t(link.labelKey)}
            </Link>
          ))}
        </div>
      )}

      {/* Failed section error */}
      {section.kind === 'FAILED' && section.error && (
        <p className={styles.sectionError}>{section.error}</p>
      )}

      {/* Review state */}
      <div className={styles.sectionReview}>
        {section.reviewedBy ? (
          <span
            className={styles.reviewedLabel}
            data-testid={`reviewed-${section.harmonizationKey}`}
          >
            {t('reviewed')} &middot; {section.reviewedBy} &middot;{' '}
            {section.reviewedAt ? new Date(section.reviewedAt).toLocaleDateString() : ''}
          </span>
        ) : (
          <>
            <span className={styles.unreviewedLabel}>{t('unreviewed')}</span>
            {canReview && section.kind === 'PROSE' && (
              <SecondaryButton
                onClick={() => onMarkReviewed(section.id)}
                data-testid={`review-btn-${section.harmonizationKey}`}
              >
                {t('markReviewed')}
              </SecondaryButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function getKindLabel(kind: SectionKind, t: (key: string) => string): string {
  switch (kind) {
    case 'PROSE':
      return t('proseSection');
    case 'GAP':
      return t('gapSection');
    case 'NA_JUSTIFIED':
      return t('naSection');
    case 'FAILED':
      return t('failedSection');
    case 'PENDING':
      return t('pendingSection');
  }
}

function getKindClass(kind: SectionKind): string {
  switch (kind) {
    case 'PROSE':
      return styles.kindProse ?? '';
    case 'GAP':
      return styles.kindGap ?? '';
    case 'NA_JUSTIFIED':
      return styles.kindNa ?? '';
    case 'FAILED':
      return styles.kindFailed ?? '';
    case 'PENDING':
      return styles.kindPending ?? '';
  }
}
