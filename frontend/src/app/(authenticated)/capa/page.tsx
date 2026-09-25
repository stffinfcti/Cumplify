'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  ClauseChip,
  ErrorState,
  Panel,
  SecondaryButton,
  type Column,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { StudioShell, AgentRunButton } from '@/components/studio';
import { useGraphQL } from '@/lib/api';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import { NCDetail } from './_detail/NCDetail';
import styles from './page.module.css';
import studioStyles from './studio.module.css';

/**
 * CAPA STUDIO — studio wave S1 (studio-wave-plan.md), absorbing /m2.
 *
 * Studio doctrine:
 * 1. The primary action IS the agent: "Report a problem" → runNcIntake →
 *    CAPAGuru classifies, identifies the clause, sets severity/source and
 *    proposes the full NC — the HitlCard renders inline in the rail and
 *    the human approves/edits. NO manual clause field on the front door.
 * 2. Per-NC agent analysis: runCapaAnalysis proposes the NEXT unresolved
 *    CAPA shall-workflow stage (stage-aware backend, live-witnessed).
 * 3. Audit trail beside the work: getAuditTrail(ncId) in the rail.
 * Manual raise stays available as the demoted secondary path (drawer).
 */

interface Nonconformity {
  id: string;
  standard: string;
  source: string;
  ncType: string;
  description: string;
  clauseRef: string;
  severity: string;
  status: string;
  raisedBy: string;
  raisedAt: string;
}

interface CorrectiveAction {
  id: string;
  ncId: string;
  actionDesc: string;
  ownerId: string;
  dueDate: string;
  status: string;
  containmentFlag: boolean;
}

interface AuditEventRow {
  eventId: string;
  eventType: string;
  actor: string;
  timestamp: string;
}

const LIST_NCS_QUERY = `query ListNCs($standard: Standard, $severity: Severity) {
  listNonconformities(standard: $standard, severity: $severity) { id standard source ncType description clauseRef severity status raisedBy raisedAt }
}`;

const OPEN_CAPAS_QUERY = `query OpenCAPAs($standard: Standard, $severity: Severity) {
  listOpenCAPAs(standard: $standard, severity: $severity) { id ncId actionDesc ownerId dueDate status containmentFlag }
}`;

const RAISE_NC_MUTATION = `mutation RaiseNC($input: RaiseNonconformityInput!) {
  raiseNonconformity(input: $input) { id standard description clauseRef severity status raisedAt }
}`;

const RUN_NC_INTAKE_MUTATION = `mutation RunNcIntake($description: String!, $evidenceNote: String) {
  runNcIntake(description: $description, evidenceNote: $evidenceNote) { runId status }
}`;

const RUN_CAPA_ANALYSIS_MUTATION = `mutation RunCapaAnalysis($ncId: ID!) {
  runCapaAnalysis(ncId: $ncId) { runId status }
}`;

const AUDIT_TRAIL_QUERY = `query AuditTrail($entityId: ID!) {
  getAuditTrail(entityId: $entityId) { eventId eventType actor timestamp }
}`;

const STANDARDS = ['', 'ISO9001', 'ISO14001', 'ISO45001'] as const;
const SEVERITIES = ['', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const NC_SOURCES = ['AUDIT', 'INCIDENT', 'COMPLAINT', 'PROCESS'] as const;
const NC_TYPES = ['NC', 'NONCONFORMING_OUTPUT', 'INCIDENT'] as const;

export default function CapaStudioPage() {
  const t = useTranslations('m2');
  const tStudio = useTranslations('capaStudio');
  const tStatus = useTranslations('status');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { query, mutate } = useGraphQL();

  const [tab, setTab] = useState<'nc' | 'capa'>('nc');
  const [ncs, setNcs] = useState<Nonconformity[]>([]);
  const [capas, setCapas] = useState<CorrectiveAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filterStandard, setFilterStandard] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedNcId, setSelectedNcId] = useState<string | null>(null);
  // S1 intake state
  const [problemText, setProblemText] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  // Audit trail for the selected NC
  const [trail, setTrail] = useState<AuditEventRow[]>([]);

  useEffect(() => {
    const ncParam = searchParams.get('nc');
    if (ncParam) setSelectedNcId(ncParam);
  }, [searchParams]);

  // Ask chip params (?raise=1&description=<>&standard=<>) — now feed the AGENT intake
  const chipDesc = searchParams.get('description') ?? '';
  const chipStandard = searchParams.get('standard') ?? '';
  const chipRaise = searchParams.get('raise') === '1';

  useEffect(() => {
    if (chipRaise && chipDesc) setProblemText(chipDesc);
  }, [chipRaise, chipDesc]);

  const filterVars = useMemo(() => {
    const vars: Record<string, unknown> = {};
    if (filterStandard) vars.standard = filterStandard;
    if (filterSeverity) vars.severity = filterSeverity;
    return vars;
  }, [filterStandard, filterSeverity]);

  const fetchNCs = useCallback(async () => {
    try {
      setError(false);
      const data = await query<{ listNonconformities: Nonconformity[] }>(
        LIST_NCS_QUERY,
        filterVars,
      );
      setNcs(data.listNonconformities);
    } catch {
      setError(true);
    }
  }, [query, filterVars]);

  const fetchCapas = useCallback(async () => {
    try {
      setError(false);
      const data = await query<{ listOpenCAPAs: CorrectiveAction[] }>(OPEN_CAPAS_QUERY, filterVars);
      setCapas(data.listOpenCAPAs);
    } catch {
      setError(true);
    }
  }, [query, filterVars]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchNCs(), fetchCapas()]);
    setLoading(false);
  }, [fetchNCs, fetchCapas]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useTenantSubscription({
    query: `subscription OnCAPA($tenantId: ID!) {
      onCAPAStatusChanged(tenantId: $tenantId) { id status }
    }`,
    onData: () => {
      fetchNCs();
      fetchCapas();
    },
  });

  // Audit trail for the selected NC (rail panel)
  const fetchTrail = useCallback(async () => {
    if (!selectedNcId) {
      setTrail([]);
      return;
    }
    try {
      const data = await query<{ getAuditTrail: AuditEventRow[] }>(AUDIT_TRAIL_QUERY, {
        entityId: selectedNcId,
      });
      setTrail(data.getAuditTrail);
    } catch {
      setTrail([]);
    }
  }, [query, selectedNcId]);

  useEffect(() => {
    fetchTrail();
  }, [fetchTrail]);

  const ncColumns: Column<Nonconformity>[] = useMemo(
    () => [
      { key: 'description', header: t('colDescription'), render: (nc) => nc.description },
      {
        key: 'severity',
        header: t('colSeverity'),
        render: (nc) => <StatusBadge status={nc.severity} />,
      },
      {
        key: 'standard',
        header: t('colStandard'),
        render: (nc) => <ClauseChip standard={nc.standard} clauseRef={nc.clauseRef} />,
      },
      {
        key: 'raisedAt',
        header: t('colRaisedAt'),
        render: (nc) => new Date(nc.raisedAt).toLocaleDateString(),
      },
      { key: 'status', header: t('colStatus'), render: (nc) => <StatusBadge status={nc.status} /> },
    ],
    [t],
  );

  const capaColumns: Column<CorrectiveAction>[] = useMemo(
    () => [
      { key: 'actionDesc', header: t('colAction'), render: (ca) => ca.actionDesc },
      { key: 'ownerId', header: t('colOwner'), render: (ca) => ca.ownerId },
      {
        key: 'dueDate',
        header: t('colDueDate'),
        render: (ca) => new Date(ca.dueDate).toLocaleDateString(),
      },
      { key: 'status', header: t('colStatus'), render: (ca) => <StatusBadge status={ca.status} /> },
    ],
    [t],
  );

  // Manual fallback drawer — the demoted secondary path
  const drawerFields: FieldDef[] = useMemo(
    () => [
      {
        name: 'standard',
        label: t('fieldStandard'),
        type: 'select',
        required: true,
        options: STANDARDS.filter(Boolean).map((s) => ({
          value: s,
          label: s.replace('ISO', 'ISO '),
        })),
        defaultValue: chipStandard || '',
      },
      {
        name: 'source',
        label: t('fieldSource'),
        type: 'select',
        required: true,
        options: NC_SOURCES.map((s) => ({ value: s, label: s })),
      },
      {
        name: 'ncType',
        label: t('fieldNcType'),
        type: 'select',
        required: true,
        options: NC_TYPES.map((nt) => ({ value: nt, label: nt.replace(/_/g, ' ') })),
      },
      {
        name: 'description',
        label: t('fieldDescription'),
        type: 'textarea',
        required: true,
        defaultValue: chipDesc,
      },
      { name: 'clauseRef', label: t('fieldClauseRef'), type: 'text', required: true },
      {
        name: 'severity',
        label: t('fieldSeverity'),
        type: 'select',
        required: true,
        options: SEVERITIES.filter(Boolean).map((s) => ({ value: s, label: s })),
      },
    ],
    [t, chipDesc, chipStandard],
  );

  // Mutation errors propagate to FormDrawer's submit handler — it keeps the
  // drawer open and renders the error inline (FE-3: the drawer owns the
  // close-on-success contract, callers never re-implement it).
  async function handleRaiseNC(values: Record<string, string | boolean>) {
    await mutate(RAISE_NC_MUTATION, {
      input: {
        standard: values.standard,
        source: values.source,
        ncType: values.ncType,
        description: values.description,
        clauseRef: values.clauseRef,
        severity: values.severity,
      },
    });
    fetchAll();
  }

  function handleSelectNC(nc: Nonconformity) {
    setSelectedNcId(nc.id);
    router.replace(`?nc=${nc.id}`, { scroll: false });
  }

  function handleBackFromDetail() {
    setSelectedNcId(null);
    router.replace('?', { scroll: false });
  }

  const selectedNc = ncs.find((nc) => nc.id === selectedNcId) ?? null;

  // ─── Agent rail ────────────────────────────────────────────────────────────
  const rail = (
    <>
      {/* S1 intake: the front door IS the agent */}
      <Panel title={tStudio('reportProblemTitle')}>
        <p className={studioStyles.railHint}>{tStudio('reportProblemHint')}</p>
        <textarea
          className={studioStyles.intakeInput}
          value={problemText}
          onChange={(e) => setProblemText(e.target.value)}
          placeholder={tStudio('reportPlaceholder')}
          aria-label={tStudio('reportProblemTitle')}
          rows={4}
        />
        <textarea
          className={studioStyles.evidenceInput}
          value={evidenceText}
          onChange={(e) => setEvidenceText(e.target.value)}
          placeholder={tStudio('evidencePlaceholder')}
          aria-label={tStudio('evidencePlaceholder')}
          rows={2}
        />
        <AgentRunButton
          label={tStudio('draftWithAgent')}
          mutation={RUN_NC_INTAKE_MUTATION}
          variables={{
            description: problemText,
            ...(evidenceText.trim() ? { evidenceNote: evidenceText } : {}),
          }}
          agentName="CAPAGuru"
          disabled={!problemText.trim()}
          onResolved={() => {
            setProblemText('');
            setEvidenceText('');
            fetchAll();
          }}
        />
        <SecondaryButton
          className={studioStyles.manualFallback}
          onClick={() => setDrawerOpen(true)}
        >
          {tStudio('raiseManually')}
        </SecondaryButton>
      </Panel>

      {/* Per-NC stage-aware analysis */}
      {selectedNc && (
        <Panel title={tStudio('analyzeTitle')}>
          <p className={studioStyles.railHint}>{tStudio('analyzeHint')}</p>
          <AgentRunButton
            label={tStudio('analyzeNextStep')}
            mutation={RUN_CAPA_ANALYSIS_MUTATION}
            variables={{ ncId: selectedNc.id }}
            agentName="CAPAGuru"
            onResolved={fetchAll}
          />
        </Panel>
      )}

      {/* Audit trail beside the work */}
      {selectedNc && (
        <Panel title={tStudio('auditTrailTitle')}>
          {trail.length === 0 ? (
            <p className={studioStyles.railHint}>{tStudio('auditTrailEmpty')}</p>
          ) : (
            <ul className={studioStyles.trailList}>
              {trail.map((evt) => (
                <li key={evt.eventId} className={studioStyles.trailRow}>
                  <span className={studioStyles.trailType}>{evt.eventType}</span>
                  <span className={studioStyles.trailMeta}>
                    {evt.actor} · {new Date(evt.timestamp).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );

  if (error && !loading && !selectedNcId) {
    return <ErrorState onRetry={fetchAll} />;
  }

  return (
    <>
      <PageHeader title={tStudio('title')} />
      <StudioShell rail={rail} railLabel={tStudio('railLabel')}>
        {selectedNcId ? (
          <NCDetail id={selectedNcId} onBack={handleBackFromDetail} />
        ) : (
          <>
            {/* Tab bar */}
            <div className={styles.tabs}>
              <button
                type="button"
                className={`${styles.tab} ${tab === 'nc' ? styles.tabActive : ''}`}
                onClick={() => setTab('nc')}
              >
                {t('tabNonconformities')}
              </button>
              <button
                type="button"
                className={`${styles.tab} ${tab === 'capa' ? styles.tabActive : ''}`}
                onClick={() => setTab('capa')}
              >
                {t('tabOpenCapas')}
              </button>
            </div>

            {/* Filters */}
            <div className={styles.filters}>
              <div className={styles.pills}>
                {STANDARDS.map((s) => (
                  <button
                    key={s || 'all'}
                    type="button"
                    className={`${styles.pill} ${filterStandard === s ? styles.pillActive : ''}`}
                    onClick={() => setFilterStandard(s)}
                  >
                    {s ? s.replace('ISO', 'ISO ') : t('filterAll')}
                  </button>
                ))}
              </div>
              <select
                className={styles.severitySelect}
                value={filterSeverity}
                onChange={(e) => setFilterSeverity(e.target.value)}
                aria-label={t('filterSeverity')}
              >
                {SEVERITIES.map((s) => (
                  <option key={s || 'all'} value={s}>
                    {s ? tStatus(s) : t('filterAll')}
                  </option>
                ))}
              </select>
            </div>

            {loading ? (
              <p className={styles.loading}>{t('loading')}</p>
            ) : tab === 'nc' ? (
              <DataTable
                columns={ncColumns}
                data={ncs}
                rowKey={(nc) => nc.id}
                onRowClick={handleSelectNC}
                emptyMessage={t('emptyNcList')}
              />
            ) : (
              <DataTable
                columns={capaColumns}
                data={capas}
                rowKey={(ca) => ca.id}
                emptyMessage={t('emptyCapaList')}
              />
            )}
          </>
        )}
      </StudioShell>

      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={t('raiseNc')}
        fields={drawerFields}
        onSubmit={handleRaiseNC}
      />
    </>
  );
}
