'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  ClauseChip,
  ProvenanceLink,
  PrimaryButton,
  ErrorState,
  type Column,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import { useStandardScope } from '@/lib/standard-scope';
import styles from './page.module.css';

/**
 * /risk — Risk Management register (migrated from M5, P1 CHECKPOINT A).
 * §4 row: 6.1 (Δaspects/Δhazards) — getCrossRegisterRiskView BUILT.
 * StandardSwitch-aware: when scope ≠ IMS, the global toggle IS the filter
 * (local pills hidden); when IMS, local pills show for drill-down.
 * Per ims-experience/view-designs.md §7.
 */

interface Risk {
  id: string;
  description: string;
  category: string;
  standard: string;
  riskRating: number;
  likelihood: number;
  severity: number;
  ownerId: string;
  status: string;
}

const STANDARDS = ['', 'ISO9001', 'ISO14001', 'ISO45001'] as const;
const CATEGORIES = ['', 'QUALITY', 'ENVIRONMENTAL', 'OHS', 'OPPORTUNITY'] as const;

const GET_RISKS_QUERY = `query GetCrossRegisterRiskView($standard: Standard, $category: RiskCategory) {
  getCrossRegisterRiskView(standard: $standard, category: $category) {
    id description category standard riskRating likelihood severity ownerId status
  }
}`;

const CREATE_RISK_MUTATION = `mutation CreateRisk($input: CreateRiskInput!) {
  createRisk(input: $input) { id description category standard riskRating status }
}`;

const ADD_TREATMENT_MUTATION = `mutation AddRiskTreatment($input: AddRiskTreatmentInput!) {
  addRiskTreatment(input: $input) { id actionDesc ownerId dueDate status }
}`;

const CREATE_CHANGE_PLAN_MUTATION = `mutation CreateChangePlan($input: CreateChangePlanInput!) {
  createChangePlan(input: $input) { id standard changeDesc }
}`;

export default function RiskManagementPage() {
  const t = useTranslations('m5');
  const searchParams = useSearchParams();
  const { query, mutate } = useGraphQL();
  const { standard: globalStandard, isIMS } = useStandardScope();

  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Local standard filter — only active when StandardSwitch is IMS (integrated view)
  const [localFilterStandard, setLocalFilterStandard] = useState('');
  const [filterCategory, setFilterCategory] = useState('');

  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [treatmentDrawerOpen, setTreatmentDrawerOpen] = useState(false);
  const [changePlanDrawerOpen, setChangePlanDrawerOpen] = useState(false);
  const [selectedRisk, setSelectedRisk] = useState<Risk | null>(null);
  const [escalatedId, setEscalatedId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ask chip: consumes ?create=1&title=<>&standard=<> from URL params
  const chipCreate = searchParams.get('create') === '1';
  const chipTitle = searchParams.get('title') ?? '';
  const chipStandard = searchParams.get('standard') ?? '';

  useEffect(() => {
    if (chipCreate) setCreateDrawerOpen(true);
  }, [chipCreate]);

  // Effective standard filter: global toggle overrides when not IMS
  const effectiveStandard = isIMS ? localFilterStandard : globalStandard;

  const fetchRisks = useCallback(async () => {
    try {
      setError(false);
      const vars: Record<string, unknown> = {};
      if (effectiveStandard) vars.standard = effectiveStandard;
      if (filterCategory) vars.category = filterCategory;
      const data = await query<{ getCrossRegisterRiskView: Risk[] }>(GET_RISKS_QUERY, vars);
      setRisks(data.getCrossRegisterRiskView);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, effectiveStandard, filterCategory]);

  useEffect(() => {
    fetchRisks();
  }, [fetchRisks]);

  // Real-time: onRiskEscalated → refetch + flash the escalated row
  useTenantSubscription({
    query: `subscription OnRiskEscalated($tenantId: ID!) {
      onRiskEscalated(tenantId: $tenantId) { id riskRating status }
    }`,
    onData: (data: { onRiskEscalated?: { id: string } }) => {
      fetchRisks();
      if (data.onRiskEscalated?.id) {
        setEscalatedId(data.onRiskEscalated.id);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setEscalatedId(null), 3000);
      }
    },
  });

  function getRatingBadgeStatus(rating: number): string {
    if (rating >= 15) return 'CRITICAL';
    if (rating >= 8) return 'WARNING';
    return 'LOW';
  }

  const columns: Column<Risk>[] = useMemo(
    () => [
      { key: 'description', header: t('colDescription'), render: (r) => r.description },
      { key: 'category', header: t('colCategory'), render: (r) => t(`category${r.category}`) },
      {
        key: 'standard',
        header: t('colStandard'),
        render: (r) => <ClauseChip standard={r.standard} clauseRef={null} />,
      },
      {
        key: 'riskRating',
        header: t('colRiskRating'),
        render: (r) => (
          <ProvenanceLink entityId={r.id}>
            <span className={styles.ratingCell}>
              <span>{r.riskRating}</span>
              <StatusBadge status={getRatingBadgeStatus(r.riskRating)} />
            </span>
          </ProvenanceLink>
        ),
      },
      { key: 'ownerId', header: t('colOwner'), render: (r) => r.ownerId },
      { key: 'status', header: t('colStatus'), render: (r) => <StatusBadge status={r.status} /> },
    ],
    [t],
  );

  // FormDrawer field definitions
  const createFields: FieldDef[] = useMemo(
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
        name: 'category',
        label: t('fieldCategory'),
        type: 'select',
        required: true,
        options: CATEGORIES.filter(Boolean).map((c) => ({ value: c, label: t(`category${c}`) })),
      },
      {
        name: 'description',
        label: t('fieldDescription'),
        type: 'textarea',
        required: true,
        defaultValue: chipTitle,
      },
      { name: 'likelihood', label: t('fieldLikelihood'), type: 'text', required: true },
      { name: 'severity', label: t('fieldSeverity'), type: 'text', required: true },
      { name: 'treatment', label: t('fieldTreatment'), type: 'textarea' },
    ],
    [t, chipTitle, chipStandard],
  );

  const treatmentFields: FieldDef[] = useMemo(
    () => [
      { name: 'actionDesc', label: t('fieldActionDesc'), type: 'textarea', required: true },
      { name: 'ownerId', label: t('fieldOwnerId'), type: 'text', required: true },
      { name: 'dueDate', label: t('fieldDueDate'), type: 'date', required: true },
    ],
    [t],
  );

  const changePlanFields: FieldDef[] = useMemo(
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
      },
      { name: 'changeDesc', label: t('fieldChangeDesc'), type: 'textarea', required: true },
      { name: 'impactAssessment', label: t('fieldImpactAssessment'), type: 'textarea' },
    ],
    [t],
  );

  // Drawer handlers propagate mutation errors — FormDrawer keeps the drawer
  // open and shows the error inline instead of nuking the whole page (FE-3).
  async function handleCreateRisk(values: Record<string, string | boolean>) {
    await mutate(CREATE_RISK_MUTATION, {
      input: {
        standard: values.standard,
        category: values.category,
        description: values.description,
        likelihood: Number(values.likelihood),
        severity: Number(values.severity),
        treatment: values.treatment || undefined,
      },
    });
    await fetchRisks();
  }

  async function handleAddTreatment(values: Record<string, string | boolean>) {
    if (!selectedRisk) return;
    await mutate(ADD_TREATMENT_MUTATION, {
      input: {
        riskId: selectedRisk.id,
        actionDesc: values.actionDesc,
        ownerId: values.ownerId,
        dueDate: values.dueDate,
      },
    });
    await fetchRisks();
  }

  async function handleCreateChangePlan(values: Record<string, string | boolean>) {
    await mutate(CREATE_CHANGE_PLAN_MUTATION, {
      input: {
        standard: values.standard,
        changeDesc: values.changeDesc,
        impactAssessment: values.impactAssessment || undefined,
      },
    });
  }

  // G4: Error state with retry
  if (error && !loading) {
    return <ErrorState onRetry={fetchRisks} />;
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        actions={
          <PrimaryButton onClick={() => setCreateDrawerOpen(true)}>{t('newRisk')}</PrimaryButton>
        }
      />

      {/* Filter bar: standard pills visible only in IMS mode (§7.2) */}
      <div className={styles.filters}>
        {isIMS && (
          <div className={styles.pills}>
            {STANDARDS.map((s) => (
              <button
                key={s || 'all'}
                type="button"
                className={`${styles.pill} ${localFilterStandard === s ? styles.pillActive : ''}`}
                onClick={() => setLocalFilterStandard(s)}
              >
                {s ? s.replace('ISO', 'ISO ') : t('filterAll')}
              </button>
            ))}
          </div>
        )}
        <select
          className={styles.categorySelect}
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          aria-label={t('filterCategory')}
        >
          {CATEGORIES.map((c) => (
            <option key={c || 'all'} value={c}>
              {c ? t(`category${c}`) : t('filterAll')}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className={styles.loading}>{t('loading')}</p>
      ) : (
        <DataTable
          columns={columns}
          data={risks}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedRisk(selectedRisk?.id === r.id ? null : r)}
          emptyMessage={t('emptyRisks')}
        />
      )}

      {/* Row expand: treatments listing BLOCKED (no listRiskTreatments query — ROADMAP) */}
      {selectedRisk && (
        <div
          className={`${styles.detailSection} ${escalatedId === selectedRisk.id ? styles.escalatedFlash : ''}`}
        >
          <h3 className={styles.detailTitle}>{t('treatmentsTitle')}</h3>
          <p className={styles.detailEmpty}>{t('treatmentsBlocked')}</p>
          <div className={styles.detailActions}>
            <PrimaryButton onClick={() => setTreatmentDrawerOpen(true)}>
              {t('addTreatment')}
            </PrimaryButton>
            <PrimaryButton onClick={() => setChangePlanDrawerOpen(true)}>
              {t('createChangePlan')}
            </PrimaryButton>
          </div>
        </div>
      )}

      {/* FormDrawers */}
      <FormDrawer
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        title={t('newRisk')}
        fields={createFields}
        onSubmit={handleCreateRisk}
      />
      <FormDrawer
        open={treatmentDrawerOpen}
        onClose={() => setTreatmentDrawerOpen(false)}
        title={t('addTreatment')}
        fields={treatmentFields}
        onSubmit={handleAddTreatment}
      />
      <FormDrawer
        open={changePlanDrawerOpen}
        onClose={() => setChangePlanDrawerOpen(false)}
        title={t('createChangePlan')}
        fields={changePlanFields}
        onSubmit={handleCreateChangePlan}
      />
    </>
  );
}
