'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  PageHeader,
  StatusBadge,
  ClauseChip,
  Panel,
  ProvenanceLink,
  PrimaryButton,
  SecondaryButton,
  ErrorState,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { AgentRunButton } from '@/components/studio';
import { parseAwsJson } from '@/lib/aws-json';
import { useGraphQL } from '@/lib/api';
import { useTenantSubscription } from '@/lib/use-tenant-subscription';
import styles from './NCDetail.module.css';

/**
 * M2 NC detail = CAPA timeline — view-designs.md §6.
 * Vertical timeline: NC raised → root cause → corrective actions → effectiveness → closed.
 * G2: fetches listCorrectiveActions(ncId), renders CA list at correctiveAction stage.
 * G4: error handling in all handlers (try/catch with error state).
 * verifyEffectiveness takes correctiveActionId from a CA row — NEVER nc.id.
 * closeCapa takes the CA's id (CloseCapaInput { id, closureNotes }).
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

const GET_NC = `query GetNC($id: ID!) {
  getNonconformity(id: $id) { id standard source ncType description clauseRef severity status raisedBy raisedAt }
}`;

const LIST_CAS = `query ListCAs($ncId: ID!) {
  listCorrectiveActions(ncId: $ncId) { id ncId actionDesc ownerId dueDate status containmentFlag }
}`;

const RECORD_ROOT_CAUSE = `mutation RecordRC($input: RecordRootCauseInput!) {
  recordRootCause(input: $input) { id ncId method findings rootCauseSummary }
}`;

const CREATE_CA = `mutation CreateCA($input: CreateCorrectiveActionInput!) {
  createCorrectiveAction(input: $input) { id ncId actionDesc status }
}`;

const VERIFY_EFF = `mutation Verify($input: VerifyEffectivenessInput!) {
  verifyEffectiveness(input: $input) { id effective }
}`;

const CLOSE_CAPA = `mutation Close($input: CloseCapaInput!) {
  closeCapa(input: $input) { id status }
}`;

type TimelineStage = 'raised' | 'rootCause' | 'correctiveAction' | 'effectiveness' | 'closed';

const STAGES: TimelineStage[] = [
  'raised',
  'rootCause',
  'correctiveAction',
  'effectiveness',
  'closed',
];

/**
 * Derive stage completion from NC status + presence of root cause + presence of CAs + verified status.
 */
function deriveStageIndex(nc: Nonconformity, cas: CorrectiveAction[]): number {
  // Stage 0: raised — always complete if NC exists
  // Stage 1: rootCause — complete once NC status advances past OPEN
  //   (recordRootCause moves the NC open → in_progress server-side; the
  //   Nonconformity type has no root-cause field, so status is the signal)
  // Stage 2: correctiveAction — complete if CAs exist
  // Stage 3: effectiveness — complete if any CA is VERIFIED or CLOSED
  // Stage 4: closed — complete if NC status is CLOSED

  if (nc.status === 'CLOSED') return 4;

  const hasRootCause = nc.status === 'IN_PROGRESS' || nc.status === 'VERIFIED';
  if (!hasRootCause) return 0;

  const hasCAs = cas.length > 0;
  if (!hasCAs) return 1;

  const hasVerified = cas.some((ca) => ca.status === 'VERIFIED' || ca.status === 'CLOSED');
  if (!hasVerified) return 2;

  return 3;
}

// C1 (CAPA Studio RCA — owner directive 2026-07-22): the big buttons ARE the
// agent; the manual root-cause drawer remains as the demoted fallback.
const RUN_RCA_MUTATION = `mutation RunRootCauseAnalysis($ncId: ID!, $method: RcaMethod!) {
  runRootCauseAnalysis(ncId: $ncId, method: $method) { runId status }
}`;
const LIST_RCA_QUERY = `query ListRootCauseAnalyses($ncId: ID!) {
  listRootCauseAnalyses(ncId: $ncId) { id ncId method findings rootCauseSummary createdBy createdAt }
}`;

interface RcaRecord {
  id: string;
  method: string;
  findings: unknown;
  rootCauseSummary: string;
  createdBy: string;
  createdAt: string;
}

function RcaFindings({ findings }: { findings: unknown }) {
  let parsed: {
    whys?: Array<{ question: string; answer: string }>;
    categories?: Array<{ category: string; causes: string[] }>;
  };
  try {
    parsed = parseAwsJson(typeof findings === 'string' ? findings : JSON.stringify(findings));
  } catch {
    return null;
  }
  if (parsed.whys?.length) {
    return (
      <ol className={styles.rcaWhys}>
        {parsed.whys.map((w, i) => (
          <li key={i}>
            <span className={styles.rcaQuestion}>{w.question}</span> {w.answer}
          </li>
        ))}
      </ol>
    );
  }
  if (parsed.categories?.length) {
    return (
      <div className={styles.rcaCategories}>
        {parsed.categories.map((c, i) => (
          <p key={i} className={styles.rcaCategory}>
            <strong>{c.category}:</strong> {c.causes.join('; ')}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

export function NCDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('m2');
  const { query, mutate } = useGraphQL();

  const [nc, setNc] = useState<Nonconformity | null>(null);
  const [cas, setCas] = useState<CorrectiveAction[]>([]);
  const [rcas, setRcas] = useState<RcaRecord[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeDrawer, setActiveDrawer] = useState<TimelineStage | null>(null);
  const [verifyCAId, setVerifyCAId] = useState<string | null>(null);
  const [closeCAId, setCloseCAId] = useState<string | null>(null);

  const fetchNC = useCallback(async () => {
    try {
      setError(false);
      const data = await query<{ getNonconformity: Nonconformity }>(GET_NC, { id });
      setNc(data.getNonconformity);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, id]);

  const fetchCAs = useCallback(async () => {
    try {
      const data = await query<{ listCorrectiveActions: CorrectiveAction[] }>(LIST_CAS, {
        ncId: id,
      });
      setCas(data.listCorrectiveActions);
    } catch {
      // Non-critical — CA list stays empty
    }
  }, [query, id]);

  const fetchRcas = useCallback(async () => {
    try {
      const data = await query<{ listRootCauseAnalyses: RcaRecord[] }>(LIST_RCA_QUERY, {
        ncId: id,
      });
      setRcas(data.listRootCauseAnalyses);
    } catch {
      // Non-critical — RCA list stays empty
    }
  }, [query, id]);

  useEffect(() => {
    fetchNC();
    fetchCAs();
    fetchRcas();
  }, [fetchNC, fetchCAs, fetchRcas]);

  useTenantSubscription({
    query: `subscription OnCAPA($tenantId: ID!) { onCAPAStatusChanged(tenantId: $tenantId) { id status } }`,
    onData: () => {
      fetchNC();
      fetchCAs();
    },
  });

  const stage = useMemo(() => {
    if (!nc) return 0;
    return deriveStageIndex(nc, cas);
  }, [nc, cas]);

  const rootCauseFields: FieldDef[] = useMemo(
    () => [
      // DB CHECK allows only these three methods — a free-text field would fail
      {
        name: 'method',
        label: t('fieldMethod'),
        type: 'select',
        required: true,
        options: [
          { value: '5why', label: t('method5why') },
          { value: 'fishbone', label: t('methodFishbone') },
          { value: 'fta', label: t('methodFta') },
        ],
      },
      { name: 'findings', label: t('fieldFindings'), type: 'textarea', required: true },
      { name: 'rootCauseSummary', label: t('fieldRootCause'), type: 'textarea', required: true },
    ],
    [t],
  );

  const caFields: FieldDef[] = useMemo(
    () => [
      { name: 'actionDesc', label: t('fieldActionDesc'), type: 'textarea', required: true },
      { name: 'ownerId', label: t('fieldOwner'), type: 'text', required: true },
      { name: 'dueDate', label: t('fieldDueDate'), type: 'date', required: true },
      { name: 'containmentFlag', label: t('fieldContainment'), type: 'checkbox' },
    ],
    [t],
  );

  const verifyFields: FieldDef[] = useMemo(
    () => [
      { name: 'verificationMethod', label: t('fieldVerifyMethod'), type: 'text', required: true },
      {
        name: 'effective',
        label: t('fieldEffective'),
        type: 'select',
        required: true,
        options: [
          { value: 'true', label: t('yes') },
          { value: 'false', label: t('no') },
        ],
      },
    ],
    [t],
  );

  const closeFields: FieldDef[] = useMemo(
    () => [{ name: 'closureNotes', label: t('fieldClosureNotes'), type: 'textarea' }],
    [t],
  );

  // Drawer handlers let mutation errors propagate to FormDrawer's submit
  // handler — a page-fatal error state would nuke the whole detail view for
  // one failed mutation.
  async function handleRootCause(values: Record<string, string | boolean>) {
    if (!nc) return;
    await mutate(RECORD_ROOT_CAUSE, {
      input: {
        ncId: nc.id,
        method: values.method,
        findings: values.findings,
        rootCauseSummary: values.rootCauseSummary,
      },
    });
    await Promise.all([fetchNC(), fetchCAs()]);
  }

  async function handleCreateCA(values: Record<string, string | boolean>) {
    if (!nc) return;
    await mutate(CREATE_CA, {
      input: {
        ncId: nc.id,
        actionDesc: values.actionDesc,
        ownerId: values.ownerId,
        dueDate: values.dueDate,
        containmentFlag: values.containmentFlag === true,
      },
    });
    await fetchCAs();
  }

  async function handleVerifyEffectiveness(values: Record<string, string | boolean>) {
    if (!verifyCAId) return;
    // G2: uses the CA's id from the CA row, NEVER nc.id
    await mutate(VERIFY_EFF, {
      input: {
        correctiveActionId: verifyCAId,
        verificationMethod: values.verificationMethod,
        effective: values.effective === 'true',
      },
    });
    await Promise.all([fetchNC(), fetchCAs()]);
  }

  async function handleCloseCapa(values: Record<string, string | boolean>) {
    if (!closeCAId) return;
    // G2: closeCapa takes the CA's id
    await mutate(CLOSE_CAPA, {
      input: { id: closeCAId, closureNotes: (values.closureNotes as string) || undefined },
    });
    await Promise.all([fetchNC(), fetchCAs()]);
  }

  if (loading) return <p className={styles.stageDate}>{t('loading')}</p>;
  if (error || !nc) return <ErrorState onRetry={fetchNC} />;

  return (
    <>
      <PageHeader
        title={nc.description}
        actions={<SecondaryButton onClick={onBack}>{t('back')}</SecondaryButton>}
      />
      <div className={styles.meta}>
        <StatusBadge status={nc.severity} />
        <StatusBadge status={nc.status} />
        <ClauseChip standard={nc.standard} clauseRef={nc.clauseRef} />
      </div>

      <Panel title={t('timeline')}>
        <div className={styles.timeline}>
          {STAGES.map((s, i) => {
            const completed = i <= stage;
            const isNext = i === stage + 1;
            return (
              <div
                key={s}
                className={`${styles.stage} ${completed ? styles.stageCompleted : styles.stageFuture}`}
              >
                <div
                  className={`${styles.dot} ${completed ? styles.dotCompleted : styles.dotFuture}`}
                />
                <div className={styles.stageContent}>
                  <span className={styles.stageLabel}>{t(`stage_${s}`)}</span>
                  {completed && i === 0 && (
                    <ProvenanceLink entityId={nc.id}>
                      <span className={styles.stageDate}>
                        {new Date(nc.raisedAt).toLocaleDateString()}
                      </span>
                    </ProvenanceLink>
                  )}
                  {/* At correctiveAction stage: render the CA list */}
                  {s === 'correctiveAction' && completed && cas.length > 0 && (
                    <div className={styles.stageContent}>
                      {cas.map((ca) => (
                        <div key={ca.id} className={styles.stage}>
                          <div className={styles.stageContent}>
                            <span className={styles.stageLabel}>{ca.actionDesc}</span>
                            <span className={styles.stageDate}>
                              {t('caOwner')}: {ca.ownerId} &middot; {t('caDue')}:{' '}
                              {new Date(ca.dueDate).toLocaleDateString()}
                            </span>
                            <StatusBadge status={ca.status} />
                            {ca.status !== 'VERIFIED' && ca.status !== 'CLOSED' && (
                              <PrimaryButton
                                className={styles.stageAction}
                                onClick={() => setVerifyCAId(ca.id)}
                              >
                                {t('action_effectiveness')}
                              </PrimaryButton>
                            )}
                            {ca.status === 'VERIFIED' && (
                              <SecondaryButton
                                className={styles.stageAction}
                                onClick={() => setCloseCAId(ca.id)}
                              >
                                {t('action_closed')}
                              </SecondaryButton>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Show action button for the next incomplete stage */}
                  {isNext && s !== 'effectiveness' && s !== 'closed' && (
                    <PrimaryButton
                      className={styles.stageAction}
                      onClick={() => setActiveDrawer(s)}
                    >
                      {t(`action_${s}`)}
                    </PrimaryButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* C1: AI-powered root-cause analysis — the agent does the heavy
          lifting; approval writes m2.root_cause_analyses via HITL. */}
      <Panel title={t('rcaPanel')}>
        <div className={styles.rcaActions}>
          <AgentRunButton
            label={t('rca5whys')}
            mutation={RUN_RCA_MUTATION}
            variables={{ ncId: id, method: 'FIVE_WHYS' }}
            agentName="CAPAGuru"
            onResolved={fetchRcas}
          />
          <AgentRunButton
            label={t('rcaIshikawa')}
            mutation={RUN_RCA_MUTATION}
            variables={{ ncId: id, method: 'FISHBONE' }}
            agentName="CAPAGuru"
            onResolved={fetchRcas}
          />
        </div>
        {rcas.length === 0 ? (
          <p className={styles.rcaEmpty}>{t('rcaEmpty')}</p>
        ) : (
          <div className={styles.rcaList}>
            {rcas.map((r) => (
              <div key={r.id} className={styles.rcaItem} data-testid={`rca-${r.id}`}>
                <div className={styles.rcaHeader}>
                  <span className={styles.rcaMethod}>{t(`method_${r.method}`)}</span>
                  <span className={styles.rcaDate}>
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className={styles.rcaSummary}>{r.rootCauseSummary}</p>
                <RcaFindings findings={r.findings} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Root cause drawer */}
      <FormDrawer
        open={activeDrawer === 'rootCause'}
        onClose={() => setActiveDrawer(null)}
        title={t('action_rootCause')}
        fields={rootCauseFields}
        onSubmit={handleRootCause}
      />

      {/* Create corrective action drawer */}
      <FormDrawer
        open={activeDrawer === 'correctiveAction'}
        onClose={() => setActiveDrawer(null)}
        title={t('action_correctiveAction')}
        fields={caFields}
        onSubmit={handleCreateCA}
      />

      {/* Verify effectiveness drawer — opens per CA row */}
      <FormDrawer
        open={!!verifyCAId}
        onClose={() => setVerifyCAId(null)}
        title={t('action_effectiveness')}
        fields={verifyFields}
        onSubmit={handleVerifyEffectiveness}
      />

      {/* Close CAPA drawer — opens per CA row */}
      <FormDrawer
        open={!!closeCAId}
        onClose={() => setCloseCAId(null)}
        title={t('action_closed')}
        fields={closeFields}
        onSubmit={handleCloseCapa}
      />
    </>
  );
}
