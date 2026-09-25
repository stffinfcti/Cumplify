/**
 * Dual attribution model for the Collaboration Law (architecture §3).
 *
 * Every change in the editor is attributed to either a human user or an agent.
 * This model persists in the local draft payload and survives into the sealed
 * audit trail when the document is approved (ES-4 requirement).
 */

export type ActorType = 'user' | 'agent';

export interface ChangeActor {
  type: ActorType;
  /** For users: Cognito sub; for agents: 'DocStudio' */
  id: string;
  /** Display name (user email or agent name) */
  name: string;
}

export interface ChangeEntry {
  id: string;
  actor: ChangeActor;
  type: 'insert' | 'delete' | 'replace';
  /** The text content of the change */
  content: string;
  /** ISO timestamp */
  timestamp: string;
  /** Whether this change has been accepted/rejected or is still pending */
  status: 'pending' | 'accepted' | 'rejected';
}

export interface SectionDraft {
  harmonizationKey: string;
  /** Agent-generated baseline (last committed content) */
  baseContent: string;
  /** Current editor content as HTML */
  editorContent: string;
  /** Tracked changes with dual attribution */
  changes: ChangeEntry[];
  /** RS-9 sync status — honest flag, never faked as saved */
  syncStatus: 'local' | 'pending-rs9';
}

/**
 * Create a fresh section draft from agent-generated content.
 */
export function createSectionDraft(harmonizationKey: string, agentContent: string): SectionDraft {
  return {
    harmonizationKey,
    baseContent: agentContent,
    editorContent: agentContent,
    changes: [],
    syncStatus: 'local',
  };
}

/**
 * Record a human edit as a tracked change.
 */
export function addHumanChange(
  draft: SectionDraft,
  userId: string,
  userName: string,
  changeType: ChangeEntry['type'],
  content: string,
): SectionDraft {
  const entry: ChangeEntry = {
    id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actor: { type: 'user', id: userId, name: userName },
    type: changeType,
    content,
    timestamp: new Date().toISOString(),
    status: 'pending',
  };
  // Coalesce a typing burst: Tiptap fires onUpdate per keystroke — if the
  // LAST change is a still-pending edit by the SAME user, replace it instead
  // of appending (found live 2026-07-22: four identical entries per sentence).
  const last = draft.changes[draft.changes.length - 1];
  const coalesce =
    last &&
    last.status === 'pending' &&
    last.actor.type === 'user' &&
    last.actor.id === userId &&
    last.type === changeType;
  return {
    ...draft,
    changes: coalesce ? [...draft.changes.slice(0, -1), entry] : [...draft.changes, entry],
    syncStatus: 'pending-rs9',
  };
}

/**
 * Record an agent iteration as a tracked proposal.
 * Agent content is ADDITIVE — never silently replaces human edits.
 */
export function addAgentProposal(draft: SectionDraft, agentContent: string): SectionDraft {
  const entry: ChangeEntry = {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actor: { type: 'agent', id: 'DocStudio', name: 'DocStudio' },
    type: 'replace',
    content: agentContent,
    timestamp: new Date().toISOString(),
    status: 'pending',
  };
  return {
    ...draft,
    changes: [...draft.changes, entry],
    syncStatus: 'pending-rs9',
  };
}

/**
 * Accept a tracked change — merges into the converged state.
 */
export function acceptChange(draft: SectionDraft, changeId: string): SectionDraft {
  return {
    ...draft,
    changes: draft.changes.map((c) =>
      c.id === changeId ? { ...c, status: 'accepted' as const } : c,
    ),
  };
}

/**
 * Reject a tracked change — discarded from the converged state.
 */
export function rejectChange(draft: SectionDraft, changeId: string): SectionDraft {
  return {
    ...draft,
    changes: draft.changes.map((c) =>
      c.id === changeId ? { ...c, status: 'rejected' as const } : c,
    ),
  };
}

/**
 * Get the converged content — base + accepted changes folded in order.
 * Pending changes are NOT included (they must be resolved first).
 * A 'replace' change carries the full new content (human edits record the
 * whole editor HTML); 'insert' appends; 'delete' removes its matched text.
 */
export function getConvergedContent(draft: SectionDraft): string {
  let content = draft.baseContent;
  for (const change of draft.changes) {
    if (change.status !== 'accepted') continue;
    if (change.type === 'replace') content = change.content;
    else if (change.type === 'insert') content += change.content;
    else content = content.replace(change.content, '');
  }
  return content;
}

/**
 * A section is converged once at least one tracked change exists and every
 * change is resolved — an untouched draft has nothing to converge.
 */
export function isConverged(draft: SectionDraft): boolean {
  return draft.changes.length > 0 && draft.changes.every((c) => c.status !== 'pending');
}
