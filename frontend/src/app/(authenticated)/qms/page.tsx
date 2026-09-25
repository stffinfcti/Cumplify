'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PageHeader, Panel, PrimaryButton, SecondaryButton, ErrorState } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { GenerationView } from './generation-view';
import { DocumentViewer } from './document-viewer';
import { DiffView } from './diff-view';
import styles from './page.module.css';
import { parseAwsJson } from '@/lib/aws-json';

/**
 * QMS Document Engine — Org Profile Wizard + Clause Registry/Applicability (spec 40, Task 10).
 *
 * Tab 1: Multi-step org profile wizard (ORG-1 full field list; same contract as qms.ts OrgProfileSchema).
 * Tab 2: Clause registry with applicability (ORG-3 named gaps computed from loaded profile, ORG-4 exclusion).
 */

const VALID_STANDARDS = ['ISO9001', 'ISO14001', 'ISO45001'] as const;
const INDUSTRY_TAXONOMY = [
  'Manufacturing',
  'Construction',
  'Healthcare',
  'Technology',
  'Food & Beverage',
  'Chemicals',
  'Automotive',
  'Aerospace',
  'Pharmaceuticals',
  'Energy',
  'Mining',
  'Logistics',
  'Services',
  'Other',
] as const;

interface Site {
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  headcount?: number;
}
interface OrgProfile {
  legalName: string;
  sites: Site[];
  employeeCount: number;
  industry: string;
  productsServices: string;
  coreProcesses: string[];
  designResponsibility: boolean;
  standardsInScope: string[];
  managementRep: string;
  targetCertDate?: string;
  yearFounded?: number;
  outsourcedProcesses?: string[];
  supplyChainShape?: string;
  existingCertifications?: string[];
  manualExists?: boolean;
}

interface ClauseEntry {
  id: string;
  standard: string;
  clauseNo: string;
  clauseTitle: string;
  intentParaphrase: string;
  requiredSources: string;
  sortOrder: number;
}
interface Applicability {
  id: string;
  clauseRegistryId: string;
  applicable: boolean;
  justification: string | null;
}

const GET_PROFILE = `query GetOrgProfile { getOrgProfile { id currentVersion payload updatedAt } }`;
const SAVE_PROFILE = `mutation SaveOrgProfile($input: SaveOrgProfileInput!) { saveOrgProfile(input: $input) { id currentVersion payload updatedAt } }`;
const LIST_REGISTRY = `query ListClauseRegistry($standard: Standard) { listClauseRegistry(standard: $standard) { id standard clauseNo clauseTitle intentParaphrase requiredSources sortOrder } }`;
const LIST_APPLICABILITY = `query ListClauseApplicability { listClauseApplicability { id clauseRegistryId applicable justification } }`;
const SET_APPLICABILITY = `mutation SetClauseApplicability($input: SetClauseApplicabilityInput!) { setClauseApplicability(input: $input) { id clauseRegistryId applicable justification } }`;

const DEFAULT_PROFILE: OrgProfile = {
  legalName: '',
  sites: [{ name: '' }],
  employeeCount: 0,
  industry: '',
  productsServices: '',
  coreProcesses: [''],
  designResponsibility: false,
  standardsInScope: [],
  managementRep: '',
  targetCertDate: '',
};

export default function QmsPage() {
  const t = useTranslations('qms');
  const tWizard = useTranslations('qms.wizard');
  const tRegistry = useTranslations('qms.registry');
  const tGen = useTranslations('qms.generation');
  const tViewer = useTranslations('qms.docViewer');
  const { query, mutate } = useGraphQL();

  const [tab, setTab] = useState<'wizard' | 'registry' | 'generation' | 'viewer' | 'diff'>(
    'wizard',
  );
  const [profile, setProfile] = useState<OrgProfile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(0);

  const [clauses, setClauses] = useState<ClauseEntry[]>([]);
  const [applicability, setApplicability] = useState<Map<string, Applicability>>(new Map());
  const [registryLoading, setRegistryLoading] = useState(false);
  const [showAllStandards, setShowAllStandards] = useState(false);

  // Document viewer / diff state
  const [viewDocumentId, setViewDocumentId] = useState<string | null>(null);
  const [diffV1, setDiffV1] = useState<string | null>(null);
  const [diffV2, setDiffV2] = useState<string | null>(null);

  // ─── Wizard: Load profile ──────────────────────────────────────────────────
  const fetchProfile = useCallback(async () => {
    try {
      setError(false);
      const data = await query<{ getOrgProfile: { payload: string } | null }>(GET_PROFILE);
      if (data.getOrgProfile?.payload) setProfile(parseAwsJson(data.getOrgProfile.payload));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const [saveError, setSaveError] = useState('');

  async function handleSaveProfile() {
    if (!profile.legalName.trim()) {
      setSaveError(tWizard('legalNameRequired'));
      return;
    }
    // Validate required numerics before mutate — Number(v)||0 turns 'abc'
    // into a silent 0 the server then stores as the org's real headcount.
    if (!Number.isInteger(profile.employeeCount) || profile.employeeCount <= 0) {
      setSaveError(tWizard('employeeCountInvalid'));
      return;
    }
    if (
      profile.yearFounded !== undefined &&
      (!Number.isInteger(profile.yearFounded) ||
        profile.yearFounded < 1800 ||
        profile.yearFounded > new Date().getFullYear())
    ) {
      setSaveError(tWizard('yearFoundedInvalid'));
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await mutate(SAVE_PROFILE, { input: { payload: JSON.stringify(profile) } });
    } catch {
      setSaveError(tWizard('saveError'));
    } finally {
      setSaving(false);
    }
  }

  // ─── Registry: Load clauses + applicability ────────────────────────────────
  const fetchRegistry = useCallback(async () => {
    try {
      setRegistryLoading(true);
      const [regData, appData] = await Promise.all([
        query<{ listClauseRegistry: ClauseEntry[] }>(LIST_REGISTRY),
        query<{ listClauseApplicability: Applicability[] }>(LIST_APPLICABILITY),
      ]);
      setClauses(regData.listClauseRegistry);
      const appMap = new Map<string, Applicability>();
      for (const a of appData.listClauseApplicability) appMap.set(a.clauseRegistryId, a);
      setApplicability(appMap);
    } catch {
      setError(true);
    } finally {
      setRegistryLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (tab === 'registry' || tab === 'generation') fetchRegistry();
  }, [tab, fetchRegistry]);

  async function handleSetApplicability(
    clauseId: string,
    applicable: boolean,
    justification?: string,
  ) {
    try {
      const result = await mutate<{ setClauseApplicability: Applicability }>(SET_APPLICABILITY, {
        input: {
          clauseRegistryId: clauseId,
          applicable,
          justification: justification || undefined,
        },
      });
      setApplicability((prev) => new Map(prev).set(clauseId, result.setClauseApplicability));
    } catch {
      setError(true);
    }
  }

  // ─── ORG-3: Compute named gaps from loaded profile ─────────────────────────
  function computeNamedGaps(clause: ClauseEntry): string[] {
    let sources: string[] = [];
    try {
      sources = JSON.parse(clause.requiredSources) as string[];
    } catch {
      return [];
    }

    const gaps: string[] = [];
    for (const src of sources) {
      if (src.startsWith('org_profile.')) {
        // Check if the profile field is filled
        const fieldPath = src.replace('org_profile.', '');
        const value = getNestedValue(profile, fieldPath);
        if (
          value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0)
        ) {
          gaps.push(src);
        }
      } else if (src.startsWith('register.')) {
        // Register sources: render "requires <register> data" — server GAP logic is authority
        gaps.push(src);
      }
    }
    return gaps;
  }

  // Filter clauses by standards in scope (Fix 4)
  const filteredClauses = useMemo(() => {
    if (showAllStandards) return clauses;
    if (profile.standardsInScope.length === 0) return clauses;
    return clauses.filter((c) => profile.standardsInScope.includes(c.standard));
  }, [clauses, profile.standardsInScope, showAllStandards]);

  // Registry map by id for GenerationView GAP CTA resolution
  const registryMapById = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        standard: string;
        clauseNo: string;
        clauseTitle: string;
        requiredSources: string;
      }
    >();
    for (const c of clauses) map.set(c.id, c);
    return map;
  }, [clauses]);

  // ─── Render ────────────────────────────────────────────────────────────────
  if (error && !loading) return <ErrorState onRetry={fetchProfile} />;

  // Navigation helpers
  function handleViewDocument(documentId: string) {
    setViewDocumentId(documentId);
    setTab('viewer');
  }
  function handleDiff(docId: string, v1: string, v2: string) {
    setViewDocumentId(docId);
    setDiffV1(v1);
    setDiffV2(v2);
    setTab('diff');
  }

  // Viewer/Diff sub-views render without the full tab chrome
  if (tab === 'viewer' && viewDocumentId) {
    return (
      <>
        <PageHeader title={tViewer('title')} />
        <DocumentViewer
          documentId={viewDocumentId}
          onBack={() => setTab('generation')}
          onDiff={(docId, v1, v2) => handleDiff(docId, v1, v2)}
        />
      </>
    );
  }

  if (tab === 'diff' && diffV1 && diffV2) {
    return (
      <>
        <PageHeader title={tViewer('diffTitle')} />
        <DiffView
          v1={diffV1}
          v2={diffV2}
          onBack={() => {
            setTab('viewer');
          }}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('title')} />
      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'wizard' ? styles.tabActive : ''}`}
          onClick={() => setTab('wizard')}
        >
          {t('tabWizard')}
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'registry' ? styles.tabActive : ''}`}
          onClick={() => setTab('registry')}
        >
          {t('tabRegistry')}
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'generation' ? styles.tabActive : ''}`}
          onClick={() => setTab('generation')}
          data-testid="tab-generation"
        >
          {tGen('title')}
        </button>
      </div>

      {tab === 'wizard' &&
        (loading ? (
          <p className={styles.loading}>{tWizard('loading')}</p>
        ) : (
          <div className={styles.wizardSteps}>
            {/* Step indicators */}
            <div className={styles.tabs}>
              {[tWizard('stepBasic'), tWizard('stepSites'), tWizard('stepScope')].map(
                (label, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`${styles.tab} ${step === i ? styles.tabActive : ''}`}
                    onClick={() => setStep(i)}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>

            {step === 0 && (
              <Panel title={tWizard('stepBasic')}>
                <div className={styles.fieldGroup}>
                  <WizardField
                    label={tWizard('legalName')}
                    required
                    value={profile.legalName}
                    onChange={(v) => setProfile((p) => ({ ...p, legalName: v }))}
                  />
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>
                      {tWizard('industry')}
                      <span className={styles.fieldRequired}>*</span>
                    </label>
                    <select
                      className={styles.fieldInput}
                      value={
                        INDUSTRY_TAXONOMY.includes(
                          profile.industry as (typeof INDUSTRY_TAXONOMY)[number],
                        )
                          ? profile.industry
                          : profile.industry
                            ? 'Other'
                            : ''
                      }
                      onChange={(e) =>
                        setProfile((p) => ({
                          ...p,
                          industry: e.target.value === 'Other' ? '' : e.target.value,
                        }))
                      }
                    >
                      <option value="">—</option>
                      {INDUSTRY_TAXONOMY.map((i) => (
                        <option key={i} value={i}>
                          {i}
                        </option>
                      ))}
                    </select>
                    {(profile.industry === '' ||
                      !INDUSTRY_TAXONOMY.includes(
                        profile.industry as (typeof INDUSTRY_TAXONOMY)[number],
                      )) && (
                      <input
                        type="text"
                        className={styles.fieldInput}
                        placeholder={tWizard('industryOther')}
                        value={
                          INDUSTRY_TAXONOMY.includes(
                            profile.industry as (typeof INDUSTRY_TAXONOMY)[number],
                          )
                            ? ''
                            : profile.industry
                        }
                        onChange={(e) => setProfile((p) => ({ ...p, industry: e.target.value }))}
                        style={{ marginTop: 'var(--space-xs)' }}
                      />
                    )}
                  </div>
                  <WizardField
                    label={tWizard('productsServices')}
                    required
                    value={profile.productsServices}
                    onChange={(v) => setProfile((p) => ({ ...p, productsServices: v }))}
                  />
                  <WizardField
                    label={tWizard('employeeCount')}
                    required
                    value={String(profile.employeeCount || '')}
                    onChange={(v) => setProfile((p) => ({ ...p, employeeCount: Number(v) || 0 }))}
                    type="number"
                  />
                  <WizardField
                    label={tWizard('managementRep')}
                    required
                    value={profile.managementRep}
                    onChange={(v) => setProfile((p) => ({ ...p, managementRep: v }))}
                  />
                  <WizardField
                    label={tWizard('yearFounded')}
                    value={String(profile.yearFounded ?? '')}
                    onChange={(v) =>
                      setProfile((p) => ({ ...p, yearFounded: v ? Number(v) : undefined }))
                    }
                    type="number"
                  />
                  <WizardField
                    label={tWizard('supplyChainShape')}
                    value={profile.supplyChainShape ?? ''}
                    onChange={(v) =>
                      setProfile((p) => ({ ...p, supplyChainShape: v || undefined }))
                    }
                  />
                  <WizardField
                    label={tWizard('existingCertifications')}
                    value={(profile.existingCertifications ?? []).join(', ')}
                    onChange={(v) =>
                      setProfile((p) => ({
                        ...p,
                        existingCertifications: v
                          ? v
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean)
                          : undefined,
                      }))
                    }
                  />
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>{tWizard('manualExists')}</label>
                    <input
                      type="checkbox"
                      checked={profile.manualExists ?? false}
                      onChange={(e) =>
                        setProfile((p) => ({ ...p, manualExists: e.target.checked }))
                      }
                    />
                  </div>
                </div>
              </Panel>
            )}

            {step === 1 && (
              <Panel title={tWizard('stepSites')}>
                <div className={styles.fieldGroup}>
                  {profile.sites.map((site, idx) => (
                    <div key={idx} className={styles.clauseCard}>
                      <WizardField
                        label={`${tWizard('siteName')} ${idx + 1}`}
                        required
                        value={site.name}
                        onChange={(v) => updateSite(idx, 'name', v)}
                      />
                      <WizardField
                        label={tWizard('siteAddress')}
                        value={site.address ?? ''}
                        onChange={(v) => updateSite(idx, 'address', v)}
                      />
                      <WizardField
                        label={tWizard('siteCity')}
                        value={site.city ?? ''}
                        onChange={(v) => updateSite(idx, 'city', v)}
                      />
                      <WizardField
                        label={tWizard('siteState')}
                        value={site.state ?? ''}
                        onChange={(v) => updateSite(idx, 'state', v)}
                      />
                      <WizardField
                        label={tWizard('siteCountry')}
                        value={site.country ?? ''}
                        onChange={(v) => updateSite(idx, 'country', v)}
                      />
                      <WizardField
                        label={tWizard('siteHeadcount')}
                        value={String(site.headcount ?? '')}
                        onChange={(v) => updateSite(idx, 'headcount', v)}
                        type="number"
                      />
                      {profile.sites.length > 1 && (
                        <SecondaryButton
                          onClick={() =>
                            setProfile((p) => ({
                              ...p,
                              sites: p.sites.filter((_, i) => i !== idx),
                            }))
                          }
                        >
                          {tWizard('removeSite')}
                        </SecondaryButton>
                      )}
                    </div>
                  ))}
                  <SecondaryButton
                    onClick={() => setProfile((p) => ({ ...p, sites: [...p.sites, { name: '' }] }))}
                  >
                    {tWizard('addSite')}
                  </SecondaryButton>
                </div>
              </Panel>
            )}

            {step === 2 && (
              <Panel title={tWizard('stepScope')}>
                <div className={styles.fieldGroup}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>
                      {tWizard('standardsInScope')}
                      <span className={styles.fieldRequired}>*</span>
                    </label>
                    {VALID_STANDARDS.map((s) => (
                      <label
                        key={s}
                        style={{
                          display: 'flex',
                          gap: '8px',
                          fontSize: '13px',
                          color: 'var(--color-text-body)',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={profile.standardsInScope.includes(s)}
                          onChange={(e) =>
                            setProfile((p) => ({
                              ...p,
                              standardsInScope: e.target.checked
                                ? [...p.standardsInScope, s]
                                : p.standardsInScope.filter((x) => x !== s),
                            }))
                          }
                        />
                        {s.replace('ISO', 'ISO ')}
                      </label>
                    ))}
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>{tWizard('designResponsibility')}</label>
                    <input
                      type="checkbox"
                      checked={profile.designResponsibility}
                      onChange={(e) =>
                        setProfile((p) => ({ ...p, designResponsibility: e.target.checked }))
                      }
                    />
                  </div>
                  <WizardField
                    label={tWizard('coreProcesses')}
                    required
                    value={profile.coreProcesses.join(', ')}
                    onChange={(v) =>
                      setProfile((p) => ({
                        ...p,
                        coreProcesses: v
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }))
                    }
                  />
                  <WizardField
                    label={tWizard('outsourcedProcesses')}
                    value={(profile.outsourcedProcesses ?? []).join(', ')}
                    onChange={(v) =>
                      setProfile((p) => ({
                        ...p,
                        outsourcedProcesses: v
                          ? v
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean)
                          : undefined,
                      }))
                    }
                  />
                  <WizardField
                    label={tWizard('targetCertDate')}
                    value={profile.targetCertDate ?? ''}
                    onChange={(v) => setProfile((p) => ({ ...p, targetCertDate: v || undefined }))}
                    type="date"
                  />
                </div>
              </Panel>
            )}

            <div className={styles.actions}>
              {step > 0 && (
                <SecondaryButton onClick={() => setStep((s) => s - 1)}>
                  {tWizard('prev')}
                </SecondaryButton>
              )}
              {step < 2 && (
                <PrimaryButton onClick={() => setStep((s) => s + 1)}>
                  {tWizard('next')}
                </PrimaryButton>
              )}
              <PrimaryButton onClick={handleSaveProfile} disabled={saving}>
                {saving ? tWizard('saving') : tWizard('save')}
              </PrimaryButton>
            </div>
            {saveError && <p className={styles.errorMsg}>{saveError}</p>}
          </div>
        ))}

      {tab === 'registry' &&
        (registryLoading ? (
          <p className={styles.loading}>{tRegistry('loading')}</p>
        ) : (
          <>
            <div className={styles.clauseApplicability}>
              <label
                style={{
                  fontSize: '13px',
                  color: 'var(--color-text-secondary)',
                  display: 'flex',
                  gap: '6px',
                  alignItems: 'center',
                }}
              >
                <input
                  type="checkbox"
                  checked={showAllStandards}
                  onChange={(e) => setShowAllStandards(e.target.checked)}
                />
                {tRegistry('showAll')}
              </label>
            </div>
            <div className={styles.clauseList} data-testid="clause-list">
              {filteredClauses.map((clause) => (
                <ClauseCard
                  key={clause.id}
                  clause={clause}
                  applicability={applicability.get(clause.id)}
                  onSetApplicability={handleSetApplicability}
                  tRegistry={tRegistry}
                  namedGaps={computeNamedGaps(clause)}
                />
              ))}
            </div>
          </>
        ))}

      {tab === 'generation' && (
        <GenerationView onViewDocument={handleViewDocument} registryMap={registryMapById} />
      )}
    </>
  );

  function updateSite(idx: number, field: string, value: string) {
    setProfile((p) => ({
      ...p,
      sites: p.sites.map((s, i) =>
        i === idx
          ? {
              ...s,
              [field]:
                field === 'headcount' ? (value ? Number(value) : undefined) : value || undefined,
            }
          : s,
      ),
    }));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const p of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}

function WizardField({
  label,
  required,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>
        {label}
        {required && <span className={styles.fieldRequired}>*</span>}
      </label>
      <input
        type={type}
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ─── ClauseCard (ORG-3 computed named gaps + ORG-4 exclusion) ─────────────────

function ClauseCard({
  clause,
  applicability: app,
  onSetApplicability,
  tRegistry,
  namedGaps,
}: {
  clause: ClauseEntry;
  applicability: Applicability | undefined;
  onSetApplicability: (id: string, applicable: boolean, justification?: string) => void;
  tRegistry: (key: string) => string;
  namedGaps: string[];
}) {
  const [justification, setJustification] = useState(app?.justification ?? '');
  const isExcluded = app?.applicable === false;

  return (
    <div className={styles.clauseCard} data-testid={`clause-${clause.clauseNo}`}>
      <div className={styles.clauseHeader}>
        <span className={styles.clauseNo}>{clause.clauseNo}</span>
        <span className={styles.clauseTitle}>{clause.clauseTitle}</span>
      </div>
      <p className={styles.clauseIntent}>{clause.intentParaphrase}</p>

      {/* ORG-3: Named gaps COMPUTED from loaded profile (not listing everything) */}
      {namedGaps.length > 0 && (
        <div className={styles.clauseGaps} data-testid={`gaps-${clause.clauseNo}`}>
          <strong>{tRegistry('namedGaps')}:</strong>
          {namedGaps.map((gap, i) => (
            <div key={i} className={styles.clauseGapItem}>
              {gap.startsWith('register.')
                ? tRegistry('requiresRegisterData').replace(
                    '{register}',
                    gap.replace('register.', ''),
                  )
                : gap}
            </div>
          ))}
        </div>
      )}

      {/* ORG-4: Applicability — exclude ONLY with justification */}
      <div className={styles.clauseApplicability}>
        {isExcluded ? (
          <>
            <span className={styles.naJustified}>
              {tRegistry('naJustified')}: {app?.justification}
            </span>
            <SecondaryButton onClick={() => onSetApplicability(clause.id, true)}>
              {tRegistry('markApplicable')}
            </SecondaryButton>
          </>
        ) : (
          <>
            <input
              type="text"
              className={`${styles.fieldInput} ${styles.justificationInput}`}
              placeholder={tRegistry('justificationPlaceholder')}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              data-testid={`justification-${clause.clauseNo}`}
            />
            <SecondaryButton
              onClick={() => {
                if (justification.trim()) onSetApplicability(clause.id, false, justification);
              }}
              disabled={!justification.trim()}
              data-testid={`exclude-btn-${clause.clauseNo}`}
            >
              {tRegistry('markExcluded')}
            </SecondaryButton>
          </>
        )}
      </div>
    </div>
  );
}
