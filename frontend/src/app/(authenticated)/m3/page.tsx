'use client';

import { Fragment, useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  PageHeader,
  Panel,
  EmptyState,
  ErrorState,
  PrimaryButton,
  SecondaryButton,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import styles from './page.module.css';

/**
 * M3 Audit Studio — view-designs.md §7.
 * Two stacked panels: (1) Programme overview (2) Readiness heatmap.
 * Programme overview: BLOCKED-ON-OWNER — listAuditProgrammes query needed.
 * Readiness heatmap: getAuditReadiness(standard) for each of 3 standards.
 * Real-time: onFindingRecorded → refetch readiness.
 */

interface ReadinessScore {
  clauseRef: string;
  score: number;
}

const STANDARDS = ['ISO9001', 'ISO14001', 'ISO45001'] as const;
const CLAUSE_FAMILIES = ['4', '5', '6', '7', '8', '9', '10'] as const;

const GET_READINESS_QUERY = `query GetAuditReadiness($standard: Standard!) {
  getAuditReadiness(standard: $standard) { clauseRef score }
}`;

const CREATE_PROGRAMME_MUTATION = `mutation CreateAuditProgramme($input: CreateAuditProgrammeInput!) {
  createAuditProgramme(input: $input) { id standard year }
}`;

const SCHEDULE_AUDIT_MUTATION = `mutation ScheduleAudit($input: ScheduleAuditInput!) {
  scheduleAudit(input: $input) { id programmeId standard scope plannedDate }
}`;

const RECORD_FINDING_MUTATION = `mutation RecordFinding($input: RecordFindingInput!) {
  recordFinding(input: $input) { id auditId findingType clauseRef }
}`;

export default function M3AuditStudioPage() {
  const t = useTranslations('m3');
  const { query, mutate } = useGraphQL();

  const [readiness, setReadiness] = useState<Record<string, ReadinessScore[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [programmeDrawerOpen, setProgrammeDrawerOpen] = useState(false);
  const [scheduleDrawerOpen, setScheduleDrawerOpen] = useState(false);
  const [findingDrawerOpen, setFindingDrawerOpen] = useState(false);

  const fetchReadiness = useCallback(async () => {
    try {
      setError(false);
      const results: Record<string, ReadinessScore[]> = {};
      const promises = STANDARDS.map(async (std) => {
        const data = await query<{ getAuditReadiness: ReadinessScore[] }>(GET_READINESS_QUERY, {
          standard: std,
        });
        results[std] = data.getAuditReadiness;
      });
      await Promise.all(promises);
      setReadiness(results);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchReadiness();
  }, [fetchReadiness]);

  // Real-time: onFindingRecorded → refetch readiness
  useTenantSubscription({
    query: `subscription OnFinding($tenantId: ID!) {
      onFindingRecorded(tenantId: $tenantId) { id auditId findingType clauseRef }
    }`,
    onData: () => fetchReadiness(),
  });

  /** Get the average score for a clause family prefix + standard */
  function getScore(standard: string, family: string): number | null {
    const scores = readiness[standard];
    if (!scores || scores.length === 0) return null;
    const matching = scores.filter((s) => s.clauseRef.startsWith(family));
    if (matching.length === 0) return null;
    return matching.reduce((sum, s) => sum + s.score, 0) / matching.length;
  }

  function getCellClass(score: number | null): string {
    if (score === null) return styles.cellEmpty;
    if (score >= 0.8) return styles.cellSuccess;
    if (score >= 0.5) return styles.cellWarning;
    return styles.cellDanger;
  }

  // FormDrawer field definitions
  const programmeFields: FieldDef[] = useMemo(
    () => [
      {
        name: 'standard',
        label: t('fieldStandard'),
        type: 'select',
        required: true,
        options: STANDARDS.map((s) => ({ value: s, label: s.replace('ISO', 'ISO ') })),
      },
      { name: 'year', label: t('fieldYear'), type: 'text', required: true },
      { name: 'frequencyPlan', label: t('fieldFrequencyPlan'), type: 'text' },
    ],
    [t],
  );

  const scheduleFields: FieldDef[] = useMemo(
    () => [
      { name: 'programmeId', label: t('fieldProgrammeId'), type: 'text', required: true },
      {
        name: 'standard',
        label: t('fieldStandard'),
        type: 'select',
        required: true,
        options: STANDARDS.map((s) => ({ value: s, label: s.replace('ISO', 'ISO ') })),
      },
      { name: 'scope', label: t('fieldScope'), type: 'textarea', required: true },
      { name: 'leadAuditorId', label: t('fieldLeadAuditorId'), type: 'text', required: true },
      { name: 'plannedDate', label: t('fieldPlannedDate'), type: 'date', required: true },
    ],
    [t],
  );

  const findingFields: FieldDef[] = useMemo(
    () => [
      { name: 'auditId', label: t('fieldAuditId'), type: 'text', required: true },
      {
        name: 'findingType',
        label: t('fieldFindingType'),
        type: 'select',
        required: true,
        options: [
          { value: 'MAJOR_NC', label: t('findingMajorNc') },
          { value: 'MINOR_NC', label: t('findingMinorNc') },
          { value: 'OBSERVATION', label: t('findingObservation') },
          { value: 'OFI', label: t('findingOfi') },
        ],
      },
      { name: 'clauseRef', label: t('fieldClauseRef'), type: 'text', required: true },
      { name: 'description', label: t('fieldDescription'), type: 'textarea', required: true },
      { name: 'evidenceRef', label: t('fieldEvidenceRef'), type: 'text' },
    ],
    [t],
  );

  async function handleCreateProgramme(values: Record<string, string | boolean>) {
    // Validate before mutate — Number('abc') is NaN, which GraphQL serializes
    // as a broken Int. Throw so the drawer shows the inline error.
    const year = Number(values.year);
    const now = new Date().getFullYear();
    if (!Number.isInteger(year) || year < now - 10 || year > now + 10) {
      throw new Error(t('yearInvalid'));
    }
    try {
      await mutate(CREATE_PROGRAMME_MUTATION, {
        input: {
          standard: values.standard,
          // CreateAuditProgrammeInput.year is Int! — text fields yield strings
          year,
          frequencyPlan: values.frequencyPlan || undefined,
        },
      });
    } catch {
      setError(true);
    }
  }

  async function handleScheduleAudit(values: Record<string, string | boolean>) {
    try {
      await mutate(SCHEDULE_AUDIT_MUTATION, {
        input: {
          programmeId: values.programmeId,
          // ScheduleAuditInput.standard is Standard! — required, never undefined
          standard: values.standard,
          scope: values.scope,
          leadAuditorId: values.leadAuditorId,
          plannedDate: values.plannedDate,
        },
      });
    } catch {
      setError(true);
    }
  }

  async function handleRecordFinding(values: Record<string, string | boolean>) {
    try {
      await mutate(RECORD_FINDING_MUTATION, {
        input: {
          auditId: values.auditId,
          findingType: values.findingType,
          clauseRef: values.clauseRef,
          description: values.description,
          evidenceRef: values.evidenceRef || undefined,
        },
      });
      await fetchReadiness();
    } catch {
      setError(true);
    }
  }

  // G4: Error state with retry
  if (error && !loading) {
    return <ErrorState onRetry={fetchReadiness} />;
  }

  return (
    <>
      <PageHeader title={t('title')} />

      <div className={styles.panels}>
        {/* Panel 1: Programme overview — BLOCKED-ON-OWNER: listAuditProgrammes needed */}
        <Panel title={t('programmeTitle')} subtitle={t('programmeSubtitle')}>
          {/* BLOCKED-ON-OWNER — listAuditProgrammes query not in schema */}
          <EmptyState message={t('programmeBlocked')} />
          <div className={styles.drawerActions}>
            <PrimaryButton onClick={() => setProgrammeDrawerOpen(true)}>
              {t('createProgramme')}
            </PrimaryButton>
            <SecondaryButton onClick={() => setScheduleDrawerOpen(true)}>
              {t('scheduleAudit')}
            </SecondaryButton>
            <SecondaryButton onClick={() => setFindingDrawerOpen(true)}>
              {t('recordFinding')}
            </SecondaryButton>
          </div>
        </Panel>

        {/* Panel 2: Readiness heatmap */}
        <Panel title={t('readinessTitle')} subtitle={t('readinessSubtitle')}>
          {loading ? (
            <p className={styles.loading}>{t('loading')}</p>
          ) : (
            <div className={styles.heatmapGrid}>
              {/* Header row */}
              <div className={styles.heatmapHeader} />
              {STANDARDS.map((std) => (
                <div key={std} className={styles.heatmapHeader}>
                  {std.replace('ISO', 'ISO ')}
                </div>
              ))}

              {/* Data rows — one per clause family */}
              {CLAUSE_FAMILIES.map((family) => (
                <Fragment key={family}>
                  <div className={styles.heatmapRowLabel}>
                    {t('clauseFamily', { number: family })}
                  </div>
                  {STANDARDS.map((std) => {
                    const score = getScore(std, family);
                    return (
                      <div
                        key={`${std}-${family}`}
                        className={`${styles.heatmapCell} ${getCellClass(score)}`}
                        title={score !== null ? `${(score * 100).toFixed(0)}%` : t('noData')}
                      >
                        {score !== null ? `${(score * 100).toFixed(0)}%` : '—'}
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* FormDrawers */}
      <FormDrawer
        open={programmeDrawerOpen}
        onClose={() => setProgrammeDrawerOpen(false)}
        title={t('createProgramme')}
        fields={programmeFields}
        onSubmit={handleCreateProgramme}
      />
      <FormDrawer
        open={scheduleDrawerOpen}
        onClose={() => setScheduleDrawerOpen(false)}
        title={t('scheduleAudit')}
        fields={scheduleFields}
        onSubmit={handleScheduleAudit}
      />
      <FormDrawer
        open={findingDrawerOpen}
        onClose={() => setFindingDrawerOpen(false)}
        title={t('recordFinding')}
        fields={findingFields}
        onSubmit={handleRecordFinding}
      />
    </>
  );
}
