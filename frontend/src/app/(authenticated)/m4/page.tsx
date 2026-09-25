'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  PageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  type Column,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import styles from './page.module.css';

/**
 * M4 Records Management — view-designs.md §8.
 * Three tabs: (1) Record register (2) Calibration schedule (3) Audit-trail viewer.
 * Tab 1 (FE-8): the record register IS the forms/records surface —
 * listFormTemplates + listFormRecords per template aggregated into one table.
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

interface FormTemplate {
  id: string;
  key: string;
  titleKey: string;
}

interface FormRecord {
  id: string;
  templateId: string;
  status: string;
  completion: { fieldsFilled: number; fieldsTotal: number };
  openedBy: string;
  updatedAt: string;
}

/** One register row: a form record plus its parent template for display. */
interface RegisterRow {
  record: FormRecord;
  template: FormTemplate;
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

const LIST_TEMPLATES = `query ListFormTemplates {
  listFormTemplates { id key titleKey }
}`;

const LIST_RECORDS = `query ListFormRecords($templateId: ID!) {
  listFormRecords(templateId: $templateId) { id templateId status completion { fieldsFilled fieldsTotal } openedBy updatedAt }
}`;

export default function M4RecordsPage() {
  const t = useTranslations('m4');
  const tForms = useTranslations('forms');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { query, mutate } = useGraphQL();

  const [tab, setTab] = useState<'records' | 'calibrations' | 'trail'>('records');
  const [registerRows, setRegisterRows] = useState<RegisterRow[]>([]);
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

  const fetchTrail = useCallback(
    async (entityId: string) => {
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
    },
    [query],
  );

  // Auto-fetch trail when trailEntityId is set from URL
  useEffect(() => {
    if (trailEntityId && tab === 'trail') {
      fetchTrail(trailEntityId);
    }
  }, [trailEntityId, tab, fetchTrail]);

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

  // FE-8: the register aggregates every template's form records into one
  // table — a record only exists under its template in the API surface.
  const fetchRegister = useCallback(async () => {
    try {
      setError(false);
      setLoading(true);
      const { listFormTemplates: templates } = await query<{
        listFormTemplates: FormTemplate[];
      }>(LIST_TEMPLATES);
      const rows = await Promise.all(
        templates.map(async (tpl) => {
          const data = await query<{ listFormRecords: FormRecord[] }>(LIST_RECORDS, {
            templateId: tpl.id,
          });
          return data.listFormRecords.map((record) => ({ record, template: tpl }));
        }),
      );
      setRegisterRows(rows.flat());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Fetch calibrations when tab switches to calibrations
  useEffect(() => {
    if (tab === 'calibrations') fetchCalibrations();
    if (tab === 'records') fetchRegister();
  }, [tab, fetchCalibrations, fetchRegister]);

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

  function tplTitle(tpl: FormTemplate): string {
    try {
      return tForms(tpl.titleKey.replace('forms.', ''));
    } catch {
      return tpl.key;
    }
  }

  const registerColumns: Column<RegisterRow>[] = useMemo(
    () => [
      { key: 'template', header: t('colTemplate'), render: (r) => tplTitle(r.template) },
      {
        key: 'status',
        header: t('colStatus'),
        render: (r) => <StatusBadge status={r.record.status} />,
      },
      {
        key: 'completion',
        header: t('colCompletion'),
        render: (r) => `${r.record.completion.fieldsFilled}/${r.record.completion.fieldsTotal}`,
      },
      { key: 'openedBy', header: t('colOpenedBy'), render: (r) => r.record.openedBy },
      {
        key: 'updatedAt',
        header: t('colUpdated'),
        render: (r) => new Date(r.record.updatedAt).toLocaleDateString(),
      },
    ],
    // eslint-disable-next-line -- tplTitle closes over tForms, only t varies
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

  // Drawer handlers propagate mutation errors — the drawer stays open with
  // the inline error (FE-3: FormDrawer owns close-on-success).
  async function handleRegisterRecord(values: Record<string, string | boolean>) {
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
  }

  async function handleCreateRetention(values: Record<string, string | boolean>) {
    // Validate before mutate — Number('abc') is NaN, which GraphQL serializes
    // as a broken Int. Throw so the drawer shows the inline error instead of
    // closing (and never sends a NaN arg).
    const retentionYears = Number(values.retentionYears);
    if (!Number.isInteger(retentionYears) || retentionYears <= 0) {
      throw new Error(t('retentionYearsInvalid'));
    }
    await mutate(CREATE_RETENTION_MUTATION, {
      input: {
        recordType: values.recordType,
        retentionYears,
        dispositionRule: values.dispositionRule,
      },
    });
  }

  async function handleRecordCalibration(values: Record<string, string | boolean>) {
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
  }

  function handleTrailSearch() {
    if (trailEntityId.trim()) {
      fetchTrail(trailEntityId.trim());
    }
  }

  // G4: Error state with retry
  if (error && !loading) {
    const retryFn =
      tab === 'records'
        ? fetchRegister
        : tab === 'calibrations'
          ? fetchCalibrations
          : () => fetchTrail(trailEntityId);
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

      {/* Tab 1: Record register — every template's form records; a row
          deep-links into the forms surface (?tpl=&rec=) for editing */}
      {tab === 'records' && (
        <>
          {loading ? (
            <p className={styles.loading}>{t('loading')}</p>
          ) : (
            <DataTable
              columns={registerColumns}
              data={registerRows}
              rowKey={(r) => r.record.id}
              onRowClick={(r) =>
                router.push(`/m4/forms?tpl=${r.template.id}&rec=${r.record.id}`)
              }
              emptyMessage={t('emptyRecords')}
            />
          )}
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
