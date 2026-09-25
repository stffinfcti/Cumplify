'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  StatusBadge,
  ClauseChip,
  PrimaryButton,
  SecondaryButton,
  ProvenanceLink,
} from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { errorText } from '@/lib/error-text';
import { canApprove } from '@/lib/role-matrix';
import { type HitlItem, type ApprovalResult, APPROVE_HITL_MUTATION, tryParseArgs } from './hitl';
import { ProposalView } from './ProposalView';
import styles from './HitlCard.module.css';

/**
 * HitlCard — ONE agent proposal, rendered wherever the work happens
 * (studio rails, workflow stages, the dashboard queue). S0 chassis:
 * extracted from HitlQueuePanel with identical CARD-1..7 semantics:
 * Approve / Edit & approve / Send back; flagged items require
 * justification (CON-8); guardrail evidence slots; ProvenanceLink banner
 * after approval; SoD/matrix rejections surface as the card's actionError.
 * Per-item state lives HERE so any surface can mount a single card.
 */

export interface HitlCardProps {
  item: HitlItem;
  role: string;
  /** Approval succeeded — parent should keep the item mounted while the banner shows. */
  onApproved?: (hitlItemId: string, result: ApprovalResult) => void;
  /** Remove the card (sent back, banner dismissed, or 10s auto-dismiss). */
  onRemove?: (hitlItemId: string) => void;
}

export function HitlCard({ item, role, onApproved, onRemove }: HitlCardProps) {
  const tCard = useTranslations('hitlCard');
  const tErr = useTranslations('errors');
  const { mutate } = useGraphQL();

  const [note, setNote] = useState('');
  const [approved, setApproved] = useState<ApprovalResult | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editParseError, setEditParseError] = useState('');
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFlagged = !!item.guardrailEvidence;
  const canAct = canApprove(role, item.module);
  const isParseable = tryParseArgs(item.draftBody) !== null;

  // The auto-dismiss timer must not fire after the card unmounts.
  useEffect(
    () => () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    },
    [],
  );

  function markApproved(result: ApprovalResult) {
    setApproved(result);
    onApproved?.(item.hitlItemId, result);
    dismissTimer.current = setTimeout(() => onRemove?.(item.hitlItemId), 10_000);
  }

  async function handleApprove() {
    if (isFlagged && !note.trim()) return;
    // Guard against double-fire: a second SendTaskSuccess on the same token
    // 404s as TaskDoesNotExist — the server would mark the item TIMED_OUT.
    setBusy(true);
    setActionError('');
    try {
      const data = await mutate<{ approveHitlItem: ApprovalResult }>(APPROVE_HITL_MUTATION, {
        input: {
          hitlItemId: item.hitlItemId,
          decision: 'APPROVE',
          justification: isFlagged ? note : undefined,
        },
      });
      markApproved(data.approveHitlItem);
    } catch (err) {
      setActionError(errorText(err, tErr, 'generic') || tCard('actionError'));
      pruneIfAlreadyResolved(err);
    } finally {
      setBusy(false);
    }
  }

  /** The resolver's 409/410 means this item was resolved on another surface
   * or its SFN task expired — the card is stale either way, so prune it
   * instead of leaving a dead card up. Matches the resolver's stable
   * HITL_* code prefix, never the prose message. */
  function pruneIfAlreadyResolved(err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('HITL_ALREADY_RESOLVED') || msg.includes('HITL_TASK_EXPIRED')) {
      onRemove?.(item.hitlItemId);
    }
  }

  function enterEditMode() {
    setEditText(JSON.stringify(tryParseArgs(item.draftBody), null, 2));
    setEditParseError('');
    setIsEditing(true);
  }

  async function handleConfirmEditApprove() {
    if (isFlagged && !note.trim()) return;
    let editedArgs: unknown;
    try {
      editedArgs = JSON.parse(editText || '{}');
    } catch {
      setEditParseError(tCard('editParseError'));
      return;
    }
    setBusy(true);
    setActionError('');
    setEditParseError('');
    try {
      const data = await mutate<{ approveHitlItem: ApprovalResult }>(APPROVE_HITL_MUTATION, {
        input: {
          hitlItemId: item.hitlItemId,
          decision: 'APPROVE',
          // AWSJSON scalar requires a JSON *string* on the wire; AppSync
          // parses it before the resolver sees it (maps/lists, not text).
          editedPayload: JSON.stringify(editedArgs),
          justification: isFlagged ? note : undefined,
        },
      });
      setIsEditing(false);
      markApproved(data.approveHitlItem);
    } catch (err) {
      setActionError(errorText(err, tErr, 'generic') || tCard('actionError'));
      pruneIfAlreadyResolved(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendBack() {
    setBusy(true);
    setActionError('');
    try {
      await mutate(APPROVE_HITL_MUTATION, {
        input: {
          hitlItemId: item.hitlItemId,
          decision: 'SEND_BACK',
          note: note || undefined,
        },
      });
      onRemove?.(item.hitlItemId);
    } catch (err) {
      setActionError(errorText(err, tErr, 'generic') || tCard('actionError'));
      pruneIfAlreadyResolved(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card} data-testid={`hitl-card-${item.hitlItemId}`}>
      <div className={styles.cardHeader}>
        <span className={styles.agentName}>{item.agentName}</span>
        <StatusBadge status={item.status} />
      </div>
      {item.clauseRef && <ClauseChip standard={item.standard} clauseRef={item.clauseRef} />}
      {/* Reviewer-grade proposal rendering (owner screenshots 2026-07-22:
          raw JSON on live cards); unknown tools fall back to the raw body. */}
      <ProposalView draftBody={item.draftBody} />

      {/* CARD-6: Full guardrail evidence display */}
      {isFlagged && item.guardrailEvidence && (
        <div className={styles.evidence}>
          <p className={styles.evidenceLabel}>{tCard('guardrailEvidence')}</p>
          {item.guardrailEvidence.groundingScore != null && (
            <p className={styles.evidenceRow}>
              {tCard('groundingScore')}: {(item.guardrailEvidence.groundingScore * 100).toFixed(0)}%
            </p>
          )}
          {item.guardrailEvidence.arVerdict && (
            <p className={styles.evidenceRow}>
              {tCard('arVerdict')}: {item.guardrailEvidence.arVerdict}
            </p>
          )}
          {item.guardrailEvidence.arDetails && (
            <p className={styles.evidenceRow}>{item.guardrailEvidence.arDetails}</p>
          )}
          {item.guardrailEvidence.citations && item.guardrailEvidence.citations.length > 0 && (
            <div className={styles.citations}>
              {item.guardrailEvidence.citations.map((cit, i) => (
                <ClauseChip key={i} standard={item.standard} clauseRef={cit.clauseRef} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* CARD-4: trust-ritual footer */}
      <p className={styles.trustRitual}>{tCard('trustRitual')}</p>

      {/* R1: inline edit mode textarea for Edit & approve */}
      {isEditing && (
        <div className={styles.editSection}>
          <label className={styles.editLabel}>{tCard('editArgsLabel')}</label>
          <textarea
            className={styles.editTextarea}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            aria-label={tCard('editArgsLabel')}
            rows={6}
          />
          {editParseError && <p className={styles.editError}>{editParseError}</p>}
          <div className={styles.editActions}>
            <PrimaryButton
              onClick={handleConfirmEditApprove}
              disabled={busy || (isFlagged && !note.trim())}
            >
              {tCard('confirmEdit')}
            </PrimaryButton>
            <SecondaryButton onClick={() => setIsEditing(false)}>
              {tCard('cancelEdit')}
            </SecondaryButton>
          </div>
        </div>
      )}

      {/* CARD-7: justification/note input */}
      {canAct && !approved && (
        <div className={styles.noteWrap}>
          <textarea
            className={styles.justificationInput}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={isFlagged ? tCard('flaggedJustification') : tCard('notePlaceholder')}
            required={isFlagged}
            aria-label={isFlagged ? tCard('flaggedJustification') : tCard('notePlaceholder')}
          />
        </div>
      )}

      {/* R2/CARD-5: ProvenanceLink banner (user-dismissible) */}
      {approved && (
        <div className={styles.approvedBanner}>
          <ProvenanceLink entityId={item.hitlItemId} auditEventId={approved.auditEventId}>
            {tCard('viewAuditEvent')}
          </ProvenanceLink>
          <button
            className={styles.dismissBtn}
            onClick={() => onRemove?.(item.hitlItemId)}
            type="button"
            aria-label={tCard('dismiss')}
          >
            ×
          </button>
        </div>
      )}

      {/* Action error display (incl. SoD/matrix rejections, verbatim) */}
      {actionError && <p className={styles.actionError}>{actionError}</p>}

      {/* CARD-3: three role-gated action buttons */}
      {canAct && !approved && !isEditing && (
        <div className={styles.actions} data-testid={`hitl-actions-${item.hitlItemId}`}>
          <PrimaryButton onClick={handleApprove} disabled={busy || (isFlagged && !note.trim())}>
            {tCard('approve')}
          </PrimaryButton>
          {isParseable && (
            <SecondaryButton onClick={enterEditMode} disabled={busy}>
              {tCard('editAndApprove')}
            </SecondaryButton>
          )}
          <SecondaryButton onClick={handleSendBack} disabled={busy}>
            {tCard('sendBack')}
          </SecondaryButton>
        </div>
      )}
    </div>
  );
}
