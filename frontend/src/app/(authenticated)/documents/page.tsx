'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  PageHeader,
  Panel,
  DataTable,
  StatusBadge,
  ClauseChip,
  ProvenanceLink,
  PrimaryButton,
  SecondaryButton,
  ErrorState,
  type Column,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import { useStandardScope } from '@/lib/standard-scope';
import { canApprove } from '@/lib/role-matrix';
import { ControlledDocViewer } from '@/components/controlled-doc';
import { StudioShell, AgentRunButton } from '@/components/studio';
import { DocumentEditor } from '@/components/document-editor';
import styles from './page.module.css';
import { parseAwsJson } from '@/lib/aws-json';

/**
 * /documents — Clause-family browser + M1 absorption.
 * §4 row: 5.2 Policy controlled + communicated.
 * Per ims-experience/view-designs.md §10.
 *
 * Clause-family grouping (4-10) uses Document.clauseRefs when available (RS-1).
 * Graceful degradation: renders flat list without clause grouping until RS-1 lands.
 * StandardSwitch-aware: filters by global scope when not IMS.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface Document {
  id: string;
  standard: string;
  docType: string;
  title: string;
  status: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  clauseRefs?: string[] | null;
}

interface DocumentVersion {
  id: string;
  documentId: string;
  versionNo: number;
  contentRef: string;
  changeSummary: string;
  authorId: string;
  createdAt: string;
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const LIST_QUERY = `query ListDocs($standard: Standard, $status: DocumentStatus) {
  listDocuments(standard: $standard, status: $status) { id standard docType title status ownerId createdAt updatedAt clauseRefs }
}`;

const CREATE_MUTATION = `mutation CreateDraft($input: CreateDocumentDraftInput!) {
  createDocumentDraft(input: $input) { id standard docType title status }
}`;

const RUN_DOC_DRAFT_MUTATION = `mutation RunDocDraft($intent: String!) {
  runDocDraft(intent: $intent) { runId status }
}`;

const LIST_VERSIONS = `query ListVersions($documentId: ID!) {
  listDocumentVersions(documentId: $documentId) { id documentId versionNo contentRef changeSummary authorId createdAt }
}`;

const GET_CONTENT = `query GetDocumentContent($versionId: ID!) {
  getDocumentContent(versionId: $versionId)
}`;

const SUBMIT_MUTATION = `mutation Submit($id: ID!) {
  submitDocumentForApproval(id: $id) { id status }
}`;

const APPROVE_MUTATION = `mutation Approve($input: ApproveDocumentVersionInput!) {
  approveDocumentVersion(input: $input) { id decision }
}`;

const SAVE_SECTION_EDIT = `mutation SaveDocumentSectionEdit($input: SaveDocumentSectionEditInput!) {
  saveDocumentSectionEdit(input: $input) { id versionNo changeSummary createdAt }
}`;

const PUBLISH_MUTATION = `mutation Publish($versionId: ID!) {
  publishControlledDocument(versionId: $versionId) { id status }
}`;

const STANDARDS = ['', 'ISO9001', 'ISO14001', 'ISO45001'] as const;
const STATUSES = ['', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'OBSOLETE'] as const;
const DOC_TYPES = ['MANUAL', 'PROCEDURE', 'WORK_INSTRUCTION', 'POLICY', 'SCOPE'] as const;

/** ISO clause families for grouping (4–10) */
const CLAUSE_FAMILIES: Array<{ prefix: string; label: string }> = [
  { prefix: '4', label: '4 Context of the Organization' },
  { prefix: '5', label: '5 Leadership' },
  { prefix: '6', label: '6 Planning' },
  { prefix: '7', label: '7 Support' },
  { prefix: '8', label: '8 Operation' },
  { prefix: '9', label: '9 Performance Evaluation' },
  { prefix: '10', label: '10 Improvement' },
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const t = useTranslations('documentsPage');
  const tStudio = useTranslations('docStudio');
  const tM1 = useTranslations('m1');
  const tStatus = useTranslations('status');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { query, mutate } = useGraphQL();
  const { user } = useAuth();
  const { standard: globalStandard, isIMS } = useStandardScope();

  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [localFilterStandard, setLocalFilterStandard] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  // S2: Document Studio intent (the front door is the agent)
  const [intentText, setIntentText] = useState('');

  // Detail state
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [documentContent, setDocumentContent] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState<{ entityId: string } | null>(null);

  // Ask chip params
  const chipTitle = searchParams.get('title') ?? '';
  const chipStandard = searchParams.get('standard') ?? '';
  const chipDraft = searchParams.get('draft') === '1';

  useEffect(() => {
    if (chipDraft) setDrawerOpen(true);
  }, [chipDraft]);

  // ─── Detail view ───────────────────────────────────────────────────────────
  const openDetail = useCallback(
    async (doc: Document) => {
      setSelectedDoc(doc);
      setDetailLoading(true);
      setDocumentContent(null);
      router.replace(`?doc=${doc.id}`, { scroll: false });

      try {
        const vData = await query<{ listDocumentVersions: DocumentVersion[] }>(LIST_VERSIONS, {
          documentId: doc.id,
        });
        setVersions(vData.listDocumentVersions);

        if (vData.listDocumentVersions.length > 0) {
          // "latest" = max(versionNo) — never assume the API returns sorted rows
          const latest = [...vData.listDocumentVersions].sort(
            (a, b) => b.versionNo - a.versionNo,
          )[0];
          try {
            const cData = await query<{ getDocumentContent: string }>(GET_CONTENT, {
              versionId: latest.id,
            });
            setDocumentContent(cData.getDocumentContent);
          } catch {
            // Content may not be available — graceful
          }
        }
      } catch {
        // Non-critical
      } finally {
        setDetailLoading(false);
      }
    },
    [router, query],
  );

  // URL-sync for detail: a shared ?doc=<id> link restores the detail view
  // once the document list has loaded (the param must map to a real row).
  const docParam = searchParams.get('doc');
  useEffect(() => {
    if (docParam && !selectedDoc && docs.length > 0) {
      const match = docs.find((d) => d.id === docParam);
      if (match) void openDetail(match);
    }
  }, [docParam, docs, selectedDoc, openDetail]);

  const effectiveStandard = isIMS ? localFilterStandard : globalStandard;

  const fetchDocs = useCallback(async () => {
    try {
      setError(false);
      const vars: Record<string, unknown> = {};
      if (effectiveStandard) vars.standard = effectiveStandard;
      if (filterStatus) vars.status = filterStatus;
      const data = await query<{ listDocuments: Document[] }>(LIST_QUERY, vars);
      setDocs(data.listDocuments);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, effectiveStandard, filterStatus]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  // Real-time: onDocumentStatusChanged patches list
  useTenantSubscription({
    query: `subscription OnDoc($tenantId: ID!) {
      onDocumentStatusChanged(tenantId: $tenantId) { id status standard }
    }`,
    onData: () => fetchDocs(),
  });

  // ─── Clause-family grouping (RS-1 graceful degradation) ────────────────────
  const hasClauseRefs = docs.some((d) => d.clauseRefs && d.clauseRefs.length > 0);

  const groupedDocs = useMemo(() => {
    if (!hasClauseRefs) return null; // flat list fallback
    const groups = new Map<string, Document[]>();
    const ungrouped: Document[] = [];

    for (const doc of docs) {
      if (!doc.clauseRefs || doc.clauseRefs.length === 0) {
        ungrouped.push(doc);
        continue;
      }
      // Group by first clause family prefix
      const firstRef = doc.clauseRefs[0];
      const familyPrefix = firstRef.split('.')[0];
      const family = CLAUSE_FAMILIES.find((f) => f.prefix === familyPrefix);
      if (family) {
        const list = groups.get(family.label) ?? [];
        list.push(doc);
        groups.set(family.label, list);
      } else {
        ungrouped.push(doc);
      }
    }
    if (ungrouped.length > 0) {
      groups.set(t('ungrouped'), ungrouped);
    }
    return groups;
  }, [docs, hasClauseRefs, t]);

  function closeDetail() {
    setSelectedDoc(null);
    setVersions([]);
    setDocumentContent(null);
    router.replace('?', { scroll: false });
  }

  // ─── Detail actions ────────────────────────────────────────────────────────
  const latestVersion = useMemo(() => {
    if (versions.length === 0) return null;
    return [...versions].sort((a, b) => b.versionNo - a.versionNo)[0];
  }, [versions]);

  const canAct = user ? canApprove(user.role, 'M1') : false;

  function showToast(entityId: string) {
    setToast({ entityId });
    setTimeout(() => setToast(null), 5000);
  }

  async function handleSubmit() {
    if (!selectedDoc) return;
    setActionLoading(true);
    try {
      const r = await mutate<{ submitDocumentForApproval: { id: string } }>(SUBMIT_MUTATION, {
        id: selectedDoc.id,
      });
      showToast(r.submitDocumentForApproval.id);
      await fetchDocs();
    } catch {
      setError(true);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleApprove() {
    if (!latestVersion) return;
    setActionLoading(true);
    try {
      const r = await mutate<{ approveDocumentVersion: { id: string } }>(APPROVE_MUTATION, {
        input: { versionId: latestVersion.id, decision: 'APPROVED' },
      });
      showToast(r.approveDocumentVersion.id);
      await fetchDocs();
    } catch {
      setError(true);
    } finally {
      setActionLoading(false);
    }
  }

  async function handlePublish() {
    if (!latestVersion) return;
    setActionLoading(true);
    try {
      const r = await mutate<{ publishControlledDocument: { id: string } }>(PUBLISH_MUTATION, {
        versionId: latestVersion.id,
      });
      showToast(r.publishControlledDocument.id);
      await fetchDocs();
    } catch {
      setError(true);
    } finally {
      setActionLoading(false);
    }
  }

  // ─── Table columns ─────────────────────────────────────────────────────────
  const columns: Column<Document>[] = useMemo(
    () => [
      { key: 'title', header: tM1('colTitle'), render: (d) => d.title },
      { key: 'status', header: tM1('colStatus'), render: (d) => <StatusBadge status={d.status} /> },
      {
        key: 'standard',
        header: tM1('colStandard'),
        render: (d) => <ClauseChip standard={d.standard} clauseRef={null} />,
      },
      { key: 'docType', header: tM1('colType'), render: (d) => d.docType.replace(/_/g, ' ') },
      {
        key: 'updatedAt',
        header: tM1('colUpdated'),
        render: (d) => (
          <ProvenanceLink entityId={d.id}>
            {new Date(d.updatedAt).toLocaleDateString()}
          </ProvenanceLink>
        ),
      },
    ],
    [tM1],
  );

  const drawerFields: FieldDef[] = useMemo(
    () => [
      {
        name: 'standard',
        label: tM1('fieldStandard'),
        type: 'select',
        required: true,
        options: STANDARDS.filter(Boolean).map((s) => ({
          value: s,
          label: s.replace('ISO', 'ISO '),
        })),
        defaultValue: chipStandard || '',
      },
      {
        name: 'docType',
        label: tM1('fieldDocType'),
        type: 'select',
        required: true,
        options: DOC_TYPES.map((dt) => ({ value: dt, label: dt.replace(/_/g, ' ') })),
      },
      {
        name: 'title',
        label: tM1('fieldTitle'),
        type: 'text',
        required: true,
        defaultValue: chipTitle,
      },
    ],
    [tM1, chipTitle, chipStandard],
  );

  async function handleCreate(values: Record<string, string | boolean>) {
    await mutate(CREATE_MUTATION, {
      input: { standard: values.standard, docType: values.docType, title: values.title },
    });
    fetchDocs();
  }

  // ─── Detail view render ────────────────────────────────────────────────────
  if (selectedDoc) {
    return (
      <>
        <PageHeader
          title={selectedDoc.title}
          actions={
            <div className={styles.actions}>
              <SecondaryButton onClick={closeDetail}>{tM1('back')}</SecondaryButton>
              {selectedDoc.status === 'DRAFT' && canAct && (
                <PrimaryButton onClick={handleSubmit} disabled={actionLoading}>
                  {tM1('submitForApproval')}
                </PrimaryButton>
              )}
              {selectedDoc.status === 'IN_REVIEW' && canAct && (
                <PrimaryButton onClick={handleApprove} disabled={actionLoading || !latestVersion}>
                  {tM1('approveVersion')}
                </PrimaryButton>
              )}
              {selectedDoc.status === 'APPROVED' && canAct && (
                <PrimaryButton onClick={handlePublish} disabled={actionLoading || !latestVersion}>
                  {tM1('publish')}
                </PrimaryButton>
              )}
            </div>
          }
        />
        <div className={styles.meta}>
          <StatusBadge status={selectedDoc.status} />
          <ClauseChip standard={selectedDoc.standard} clauseRef={null} />
          <span className={styles.docType}>{selectedDoc.docType.replace(/_/g, ' ')}</span>
        </div>

        <div className={styles.detailLayout}>
          <div className={styles.detailMain}>
            {detailLoading && <p className={styles.loading}>{tM1('loading')}</p>}
            {/* DRAFT status: DocumentEditor (Collaboration Law — §13) */}
            {!detailLoading && selectedDoc.status === 'DRAFT' && documentContent && (
              <DocumentEditor
                sections={(() => {
                  try {
                    // parseAwsJson, NOT bare JSON.parse: the AWSJSON field
                    // arrives as a parsed object (post-2026-07-22 API) or a
                    // string (legacy) — bare parse yielded [] in BOTH worlds,
                    // rendering an empty editor (found at the design gate).
                    const parsed = parseAwsJson<{ sections?: unknown[] }>(documentContent);
                    return (parsed.sections ?? []) as never[];
                  } catch {
                    return [];
                  }
                })()}
                runId={selectedDoc.id}
                documentId={selectedDoc.id}
                versionId={latestVersion?.id ?? null}
                onSaved={() => openDetail(selectedDoc)}
                onConverge={async (harmonizationKey, content) => {
                  // A converged section is durable state: persist it as a
                  // new version immediately, same door the manual save uses.
                  if (!latestVersion?.id) return;
                  await mutate(SAVE_SECTION_EDIT, {
                    input: {
                      versionId: latestVersion.id,
                      harmonizationKey,
                      body: content,
                    },
                  });
                  openDetail(selectedDoc);
                }}
              />
            )}
            {/* Non-DRAFT status: ControlledDocViewer (§7-compliant, read-only) */}
            {!detailLoading && selectedDoc.status !== 'DRAFT' && documentContent && (
              <ControlledDocViewer
                contentRaw={documentContent}
                documentId={selectedDoc.id}
                versionNo={latestVersion?.versionNo}
                generatedAt={latestVersion?.createdAt}
              />
            )}
            {!detailLoading && !documentContent && (
              <Panel title={tM1('content')}>
                <p>{tM1('contentPlaceholder')}</p>
              </Panel>
            )}
          </div>

          <div className={styles.detailRail}>
            <Panel title={tM1('versionHistory')}>
              {versions.length === 0 ? (
                <p className={styles.compareHint}>{tM1('noVersions')}</p>
              ) : (
                <div className={styles.versionList}>
                  {versions.map((v) => (
                    <div key={v.id} className={styles.versionRow}>
                      <span className={styles.versionNo}>v{v.versionNo}</span>
                      <span className={styles.versionSummary}>{v.changeSummary}</span>
                      <span className={styles.versionDate}>
                        {new Date(v.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>

        {toast && (
          <div className={styles.toast}>
            <ProvenanceLink entityId={toast.entityId}>{tM1('savedSuccessfully')}</ProvenanceLink>
          </div>
        )}
      </>
    );
  }

  // ─── List view render ──────────────────────────────────────────────────────
  if (error && !loading) return <ErrorState onRetry={fetchDocs} />;

  // S2 agent rail — the front door IS DocStudio
  const rail = (
    <Panel title={tStudio('newDocTitle')}>
      <p className={styles.railHint}>{tStudio('newDocHint')}</p>
      <textarea
        className={styles.intentInput}
        value={intentText}
        onChange={(e) => setIntentText(e.target.value)}
        placeholder={tStudio('intentPlaceholder')}
        aria-label={tStudio('newDocTitle')}
        rows={4}
      />
      <AgentRunButton
        label={tStudio('draftWithAgent')}
        mutation={RUN_DOC_DRAFT_MUTATION}
        variables={{ intent: intentText }}
        agentName="DocStudio"
        disabled={!intentText.trim()}
        onResolved={() => {
          setIntentText('');
          fetchDocs();
        }}
      />
      <SecondaryButton className={styles.manualFallback} onClick={() => setDrawerOpen(true)}>
        {tStudio('createManually')}
      </SecondaryButton>
    </Panel>
  );

  return (
    <>
      <PageHeader title={t('title')} />
      <StudioShell rail={rail} railLabel={tStudio('railLabel')}>
        {/* Filter bar: standard pills visible only in IMS mode */}
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
                  {s ? s.replace('ISO', 'ISO ') : tM1('filterAll')}
                </button>
              ))}
            </div>
          )}
          <select
            className={styles.statusSelect}
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            aria-label={tM1('filterStatus')}
          >
            {STATUSES.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? tStatus(s) : tM1('filterAll')}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className={styles.loading}>{tM1('loading')}</p>
        ) : groupedDocs ? (
          /* Clause-family grouped view (RS-1 available) */
          <>
            {CLAUSE_FAMILIES.map((family) => {
              const familyDocs = groupedDocs.get(family.label);
              if (!familyDocs || familyDocs.length === 0) return null;
              return (
                <div key={family.prefix} className={styles.clauseGroup}>
                  <h3 className={styles.clauseGroupHeader}>{family.label}</h3>
                  <DataTable
                    columns={columns}
                    data={familyDocs}
                    rowKey={(d) => d.id}
                    onRowClick={openDetail}
                    emptyMessage={tM1('emptyList')}
                  />
                </div>
              );
            })}
            {groupedDocs.has(t('ungrouped')) && (
              <div className={styles.clauseGroup}>
                <h3 className={styles.clauseGroupHeader}>{t('ungrouped')}</h3>
                <DataTable
                  columns={columns}
                  data={groupedDocs.get(t('ungrouped'))!}
                  rowKey={(d) => d.id}
                  onRowClick={openDetail}
                  emptyMessage={tM1('emptyList')}
                />
              </div>
            )}
          </>
        ) : (
          /* Flat list (RS-1 not yet available — graceful degradation) */
          <DataTable
            columns={columns}
            data={docs}
            rowKey={(d) => d.id}
            onRowClick={openDetail}
            emptyMessage={tM1('emptyList')}
          />
        )}
      </StudioShell>

      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={tM1('newDraft')}
        fields={drawerFields}
        onSubmit={handleCreate}
      />
    </>
  );
}
