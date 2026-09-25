'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PrimaryButton } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { HitlCard } from './HitlCard';
import { type HitlItem, LIST_PENDING_HITL_QUERY } from './hitl';
import styles from './AgentRunButton.module.css';

/**
 * AgentRunButton — studio doctrine #1: the big button IS the agent.
 *
 * Click → dispatch the run mutation (fire-and-forget Event invoke on the
 * backend) → watch listPendingHitlItems for the NEW item from this agent
 * (baseline snapshot taken at dispatch, so pre-existing cards never
 * false-positive) → render the HitlCard INLINE where the user clicked.
 *
 * Poll cadence 5s, cap 36 (3 min). Timeout is honest: the run may still
 * complete in the background (the dashboard inbox will show it).
 */

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 36;

export interface AgentRunButtonProps {
  /** Translated button label — the studio names the action ("Analyze with CAPAGuru"). */
  label: string;
  /** GraphQL mutation document whose single root field returns { runId, status }. */
  mutation: string;
  variables?: Record<string, unknown>;
  /** Agent whose HITL card this run produces (CAPAGuru, RiskSentinel, DocStudio, LeadAuditor). */
  agentName: string;
  disabled?: boolean;
  /** Called when the run's HitlCard resolves (approved+dismissed or sent back). */
  onResolved?: () => void;
}

type Phase = 'idle' | 'dispatching' | 'waiting' | 'card' | 'timeout' | 'dispatchError';

export function AgentRunButton({
  label,
  mutation,
  variables,
  agentName,
  disabled,
  onResolved,
}: AgentRunButtonProps) {
  const t = useTranslations('studio');
  const { query, mutate } = useGraphQL();
  const { user } = useAuth();
  const role = user?.role ?? 'employee';

  const [phase, setPhase] = useState<Phase>('idle');
  const [card, setCard] = useState<HitlItem | null>(null);
  const [dispatchError, setDispatchError] = useState('');
  const pollCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The poll timer must not fire after unmount (setState on a dead component
  // and a live network client on a ghost page).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function listPendingIds(): Promise<{ ids: Set<string>; items: HitlItem[] }> {
    const data = await query<{
      listPendingHitlItems: { items: HitlItem[]; nextToken: string | null };
    }>(LIST_PENDING_HITL_QUERY, { pagination: { limit: 50 } });
    const items = data.listPendingHitlItems.items;
    return { ids: new Set(items.map((i) => i.hitlItemId)), items };
  }

  async function run() {
    setDispatchError('');
    setPhase('dispatching');
    let baseline: Set<string>;
    try {
      baseline = (await listPendingIds()).ids;
      await mutate(mutation, variables ?? {});
    } catch (err) {
      setDispatchError((err as Error).message || t('dispatchError'));
      setPhase('dispatchError');
      return;
    }
    setPhase('waiting');
    pollCount.current = 0;

    const poll = async () => {
      pollCount.current += 1;
      try {
        const { items } = await listPendingIds();
        const fresh = items.find((i) => i.agentName === agentName && !baseline.has(i.hitlItemId));
        if (fresh) {
          setCard(fresh);
          setPhase('card');
          return;
        }
      } catch {
        /* transient poll failure — keep going until the cap */
      }
      if (pollCount.current >= MAX_POLLS) {
        setPhase('timeout');
        return;
      }
      timer.current = setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer.current = setTimeout(poll, POLL_INTERVAL_MS);
  }

  function reset() {
    if (timer.current) clearTimeout(timer.current);
    setCard(null);
    setPhase('idle');
    onResolved?.();
  }

  return (
    <div className={styles.wrap} data-testid={`agent-run-${agentName}`}>
      {(phase === 'idle' || phase === 'dispatchError' || phase === 'timeout') && (
        <PrimaryButton onClick={run} disabled={disabled}>
          {label}
        </PrimaryButton>
      )}

      {phase === 'dispatching' && <p className={styles.status}>{t('dispatching')}</p>}

      {phase === 'waiting' && (
        <p className={styles.status} role="status">
          <span className={styles.pulse} aria-hidden="true" />
          {t('agentWorking', { agent: agentName })}
        </p>
      )}

      {phase === 'timeout' && <p className={styles.timeout}>{t('agentTimeout')}</p>}
      {phase === 'dispatchError' && <p className={styles.error}>{dispatchError}</p>}

      {phase === 'card' && card && (
        <div className={styles.cardWrap}>
          <HitlCard item={card} role={role} onRemove={reset} />
        </div>
      )}
    </div>
  );
}
