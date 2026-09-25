'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import {
  PageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  PrimaryButton,
  SecondaryButton,
  type Column,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import styles from './page.module.css';

/**
 * M4 Records Management — view-designs.md §8.
 * Three tabs: (1) Record register (2) Calibration schedule (3) Audit-trail viewer.
 * Tab 1: BLOCKED-ON-OWNER — listRecords query needed.
 * Tab 2: listCalibrationsDue(windowDays: 90).
 * Tab 3: getAuditTrail(entityId) — ProvenanceLink target for the whole app.
 * No subscription (MOD-10 excludes onCalibrationDue by design).
 */

interface CalibrationRecord {
  measuringResourceId: string;
  standardUsed: string;
  result: string;
  nextDue: string;
}

interface AuditEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  actor: string;
  payload: string;
}

const STANDARDS = ['ISO9001', 'ISO14001', 'ISO45001'] as const;

const LIST_CALIBRATIONS_QUERY = `query ListCalibrationsDue($windowDays: Int!) {
  listCalibrationsDue(windowDays: $windowDays) { measuringResourceId standardUsed result nextDue }
}`;

const GET_AUDIT_TRAIL_QUERY = `query GetAuditTrail($entityId: ID!) {
  getAuditTrail(entityId: $entityId) { eventId eventType timestamp actor payload }
}`;

const REGISTER_RECORD_MUTATION = `mutation RegisterRecord($input: RegisterRecordInput!) {
  registerRecord(input: $input) { id standard recordType sourceModule }
}`;

const CREATE_RETENTION_MUTATION = `mutation CreateRetentionPolicy($input: CreateRetentionPolicyInput!) {
  createRetentionPolicy(input: $input) { id recordType retentionYears dispositionRule }
}`;

const RECORD_CALIBRATION_MUTATION = `mutation RecordCalibration($input: RecordCalibrationInput!) {
  recordCalibration(input: $input) { measuringResourceId standardUsed result nextDue }
}`;

export default function M4RecordsPage() {
  const t = useTranslations('m4');
  const searchParams = useSearchParams();
  const { query, mutate } = useGraphQL();

  const [tab, setTab] = useState<'records' | 'calibrations' | 'trail'>('records');
  const [calibrations, setCalibrations] = useState<CalibrationRecord[]>([]);
  const [trailEvents, setTrailEvents] = useState<AuditEvent[]>([]);
  const [trailEntityId, setTrailEntityId] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const [registerDrawerOpen, setRegisterDrawerOpen] = useState(false);
  const [retentionDrawerOpen, setRetentionDrawerOpen] = useState(false);
  const [calibrationDrawerOpen, setCalibrationDrawerOpen] = useState(false);

  // Deep-link: read ?trail= and ?eventId= from URL params on mount
  useEffect(() => {
    const trailParam = searchParams.get('trail');
    const eventIdParam = searchParams.get('eventId');
    if (trailParam) {
      setTab('trail');
      setTrailEntityId(trailParam);
      if (eventIdParam) setExpandedEventId(eventIdParam);
    }
  }, [searchParams]);

  // Auto-fetch trail when trailEntityId is set from URL
  useEffect(() => {
    if (trailEntityId && tab === 'trail') {
      fetchTrail(trailEntityId);
    }
    // eslint-disable-next-line -- fetchTrail reference stable via useCallback pattern
  }, [trailEntityId, tab]);

  const fetchCalibrations = useCallback(async () => {
    try {
      setError(false);
      setLoading(true);
      const data = await query<{ listCalibrationsDue: CalibrationRecord[] }>(
        LIST_CALIBRATIONS_QUERY,
        { windowDays: 90 },
      );
      setCalibrations(data.listCalibrationsDue);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  async function fetchTrail(entityId: string) {
    try {
      setError(false);
      setLoading(true);
      const data = await query<{ getAuditTrail: AuditEvent[] }>(GET_AUDIT_TRAIL_QUERY, {
        entityId,
      });
      setTrailEvents(data.getAuditTrail);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // Fetch calibrations when tab switches to calibrations
  useEffect(() => {
    if (tab === 'calibrations') fetchCalibrations();
  }, [tab, fetchCalibrations]);

  const calibrationColumns: Column<CalibrationRecord>[] = useMemo(
    () => [
      {
        key: 'measuringResourceId',
        header: t('colResource'),
        render: (c) => c.measuringResourceId,
      },
      { key: 'standardUsed', header: t('colStandardUsed'), render: (c) => c.standardUsed },
      { key: 'result', header: t('colResult'), render: (c) => c.result },
      {
        key: 'nextDue',
        header: t('colNextDue'),
        render: (c) => new Date(c.nextDue).toLocaleDateString(),
      },
    ],
    [t],
  );

  // FormDrawer field definitions
  const registerFields: FieldDef[] = useMemo(
    () => [
      {
        name: 'standard',
        label: t('fieldStandard'),
        type: 'select',
        required: true,
        options: STANDARDS.map((s) => ({ value: s, label: s.replace('ISO', 'ISO ') })),
      },
      { name: 'recordType', label: t('fieldRecordType'), type: 'text', required: true },
      { name: 'sourceModule', label: t('fieldSourceModule'), type: 'text', required: true },
      { name: 'retentionClass', label: t('fieldRetentionClass'), type: 'text' },
      { name: 's3ObjectRef', label: t('fieldS3ObjectRef'), type: 'text' },
    ],
    [t],
  );

  const retentionFields: FieldDef[] = useMemo(
    () => [
      { name: 'recordType', label: t('fieldRecordType'), type: 'text', required: true },
      { name: 'retentionYears', label: t('fieldRetentionYears'), type: 'text', required: true },
      { name: 'dispositionRule', label: t('fieldDispositionRule'), type: 'text', required: true },
    ],
    [t],
  );

  const calibrationFields: FieldDef[] = useMemo(
    () => [
      { name: 'measuringResourceId', label: t('fieldResourceId'), type: 'text', required: true },
      { name: 'standardUsed', label: t('fieldStandardUsed'), type: 'text', required: true },
      { name: 'traceabilityRef', label: t('fieldTraceabilityRef'), type: 'text' },
      { name: 'result', label: t('fieldResult'), type: 'text', required: true },
      { name: 'nextDue', label: t('fieldNextDue'), type: 'date', required: true },
    ],
    [t],
  );

  async function handleRegisterRecord(values: Record<string, string | boolean>) {
    try {
      await mutate(REGISTER_RECORD_MUTATION, {
        input: {
          // RegisterRecordInput.standard is Standard! — required, never undefined
          standard: values.standard,
          recordType: values.recordType,
          sourceModule: values.sourceModule,
          retentionClass: values.retentionClass || undefined,
          s3ObjectRef: values.s3ObjectRef || undefined,
        },
      });
    } catch {
      setError(true);
    }
  }

  async function handleCreateRetention(values: Record<string, string | boolean>) {
    // Validate before mutate — Number('abc') is NaN, which GraphQL serializes
    // as a broken Int. Throw so the drawer shows the inline error instead of
    // closing (and never sends a NaN arg).
    const retentionYears = Number(values.retentionYears);
    if (!Number.isInteger(retentionYears) || retentionYears <= 0) {
      throw new Error(t('retentionYearsInvalid'));
    }
    try {
      await mutate(CREATE_RETENTION_MUTATION, {
        input: {
          recordType: values.recordType,
          retentionYears,
          dispositionRule: values.dispositionRule,
        },
      });
    } catch {
      setError(true);
    }
  }

  async function handleRecordCalibration(values: Record<string, string | boolean>) {
    try {
      await mutate(RECORD_CALIBRATION_MUTATION, {
        input: {
          measuringResourceId: values.measuringResourceId,
          standardUsed: values.standardUsed,
          traceabilityRef: values.traceabilityRef || undefined,
          result: values.result,
          nextDue: values.nextDue,
        },
      });
      await fetchCalibrations();
    } catch {
      setError(true);
    }
  }

  function handleTrailSearch() {
    if (trailEntityId.trim()) {
      fetchTrail(trailEntityId.trim());
    }
  }

  // G4: Error state with retry
  if (error && !loading) {
    const retryFn = tab === 'calibrations' ? fetchCalibrations : () => fetchTrail(trailEntityId);
    return <ErrorState onRetry={retryFn} />;
  }

  return (
    <>
      <PageHeader title={t('title')} />

      {/* Tab bar */}
      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'records' ? styles.tabActive : ''}`}
          onClick={() => setTab('records')}
        >
          {t('tabRecords')}
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'calibrations' ? styles.tabActive : ''}`}
          onClick={() => setTab('calibrations')}
        >
          {t('tabCalibrations')}
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'trail' ? styles.tabActive : ''}`}
          onClick={() => setTab('trail')}
        >
          {t('tabAuditTrail')}
        </button>
      </div>

      {/* Tab 1: Record register — BLOCKED-ON-OWNER: listRecords query needed */}
      {tab === 'records' && (
        <>
          {/* BLOCKED-ON-OWNER — listRecords query not in schema */}
          <EmptyState message={t('recordsBlocked')} />
          <div className={styles.drawerActions}>
            <PrimaryButton onClick={() => setRegisterDrawerOpen(true)}>
              {t('registerRecord')}
            </PrimaryButton>
            <SecondaryButton onClick={() => setRetentionDrawerOpen(true)}>
              {t('createRetention')}
            </SecondaryButton>
          </div>
        </>
      )}

      {/* Tab 2: Calibration schedule */}
      {tab === 'calibrations' && (
        <>
          {loading ? (
            <p className={styles.loading}>{t('loading')}</p>
          ) : (
            <>
              <DataTable
                columns={calibrationColumns}
                data={[...calibrations].sort(
                  (a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime(),
                )}
                rowKey={(c) => `${c.measuringResourceId}-${c.nextDue}`}
                emptyMessage={t('emptyCalibrations')}
              />
              <div className={styles.drawerActions}>
                <PrimaryButton onClick={() => setCalibrationDrawerOpen(true)}>
                  {t('recordCalibration')}
                </PrimaryButton>
              </div>
            </>
          )}
        </>
      )}

      {/* Tab 3: Audit-trail viewer — ProvenanceLink TARGET */}
      {tab === 'trail' && (
        <>
          <div className={styles.trailSearch}>
            <input
              type="text"
              className={styles.trailInput}
              value={trailEntityId}
              onChange={(e) => setTrailEntityId(e.target.value)}
              placeholder={t('trailSearchPlaceholder')}
              aria-label={t('trailSearchLabel')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTrailSearch();
              }}
            />
            <PrimaryButton onClick={handleTrailSearch}>{t('trailSearchButton')}</PrimaryButton>
          </div>

          {loading ? (
            <p className={styles.loading}>{t('loading')}</p>
          ) : trailEvents.length === 0 ? (
            <EmptyState message={t('emptyTrail')} />
          ) : (
            <div className={styles.eventList}>
              {trailEvents.map((evt) => (
                <div
                  key={evt.eventId}
                  className={styles.eventRow}
                  onClick={() =>
                    setExpandedEventId(expandedEventId === evt.eventId ? null : evt.eventId)
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedEventId(expandedEventId === evt.eventId ? null : evt.eventId);
                    }
                  }}
                  id={evt.eventId}
                >
                  <div className={styles.eventHeader}>
                    <span className={styles.eventType}>{evt.eventType}</span>
                    <span className={styles.eventId}>{evt.eventId}</span>
                    <span className={styles.eventTimestamp}>
                      {new Date(evt.timestamp).toLocaleString()}
                    </span>
                    <span className={styles.eventActor}>{evt.actor}</span>
                  </div>
                  {expandedEventId === evt.eventId && (
                    <pre className={styles.eventPayload}>{evt.payload}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* FormDrawers */}
      <FormDrawer
        open={registerDrawerOpen}
        onClose={() => setRegisterDrawerOpen(false)}
        title={t('registerRecord')}
        fields={registerFields}
        onSubmit={handleRegisterRecord}
      />
      <FormDrawer
        open={retentionDrawerOpen}
        onClose={() => setRetentionDrawerOpen(false)}
        title={t('createRetention')}
        fields={retentionFields}
        onSubmit={handleCreateRetention}
      />
      <FormDrawer
        open={calibrationDrawerOpen}
        onClose={() => setCalibrationDrawerOpen(false)}
        title={t('recordCalibration')}
        fields={calibrationFields}
        onSubmit={handleRecordCalibration}
      />
    </>
  );
}
