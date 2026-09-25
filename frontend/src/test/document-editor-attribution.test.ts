import { describe, it, expect } from 'vitest';
import {
  createSectionDraft,
  addHumanChange,
  addAgentProposal,
  acceptChange,
  rejectChange,
  isConverged,
  getConvergedContent,
} from '@/components/document-editor/attribution';

/**
 * Editor attribution model test — per view-designs §13.9.
 *
 * Validates Collaboration Law mechanics:
 * - Human edits carry user attribution
 * - Agent iterations carry agent attribution
 * - Human edits are NEVER overwritten by agent iterations (additive only)
 * - Accept/reject resolves changes correctly
 */

describe('Document editor attribution model (Collaboration Law)', () => {
  const baseContent = 'The organization shall determine external issues.';

  it('creates a section draft from agent baseline', () => {
    const draft = createSectionDraft('context_of_org', baseContent);
    expect(draft.harmonizationKey).toBe('context_of_org');
    expect(draft.baseContent).toBe(baseContent);
    expect(draft.editorContent).toBe(baseContent);
    expect(draft.changes).toHaveLength(0);
    expect(draft.syncStatus).toBe('local');
  });

  it('human edit carries user attribution (actor: user:<sub>)', () => {
    const draft = createSectionDraft('context_of_org', baseContent);
    const edited = addHumanChange(
      draft,
      'user-sub-123',
      'jane@acme.com',
      'replace',
      'Updated: The organization has determined issues.',
    );

    expect(edited.changes).toHaveLength(1);
    expect(edited.changes[0].actor.type).toBe('user');
    expect(edited.changes[0].actor.id).toBe('user-sub-123');
    expect(edited.changes[0].actor.name).toBe('jane@acme.com');
    expect(edited.changes[0].timestamp).toBeTruthy();
    expect(edited.changes[0].status).toBe('pending');
    expect(edited.syncStatus).toBe('pending-rs9');
  });

  it('agent iteration carries agent attribution (actor: agent:DocStudio)', () => {
    const draft = createSectionDraft('context_of_org', baseContent);
    const withAgent = addAgentProposal(draft, 'Revised section from agent.');

    expect(withAgent.changes).toHaveLength(1);
    expect(withAgent.changes[0].actor.type).toBe('agent');
    expect(withAgent.changes[0].actor.id).toBe('DocStudio');
    expect(withAgent.changes[0].actor.name).toBe('DocStudio');
    expect(withAgent.changes[0].status).toBe('pending');
  });

  it('agent iterations are ADDITIVE — never overwrite human edits', () => {
    let draft = createSectionDraft('context_of_org', baseContent);
    // Human edits first
    draft = addHumanChange(draft, 'user-1', 'user@example.com', 'insert', 'Human addition.');
    // Then agent iteration
    draft = addAgentProposal(draft, 'Agent revised text.');

    // Both changes exist — agent did NOT replace the human edit
    expect(draft.changes).toHaveLength(2);
    expect(draft.changes[0].actor.type).toBe('user');
    expect(draft.changes[0].content).toBe('Human addition.');
    expect(draft.changes[1].actor.type).toBe('agent');
    expect(draft.changes[1].content).toBe('Agent revised text.');
  });

  it('accepting a change sets status to accepted', () => {
    let draft = createSectionDraft('context_of_org', baseContent);
    draft = addHumanChange(draft, 'user-1', 'user@example.com', 'insert', 'Added text.');
    const changeId = draft.changes[0].id;

    const accepted = acceptChange(draft, changeId);
    expect(accepted.changes[0].status).toBe('accepted');
  });

  it('rejecting a change sets status to rejected', () => {
    let draft = createSectionDraft('context_of_org', baseContent);
    draft = addAgentProposal(draft, 'Agent suggestion.');
    const changeId = draft.changes[0].id;

    const rejected = rejectChange(draft, changeId);
    expect(rejected.changes[0].status).toBe('rejected');
  });

  it('isConverged requires at least one change, all resolved', () => {
    let draft = createSectionDraft('context_of_org', baseContent);
    expect(isConverged(draft)).toBe(false); // nothing to converge on a fresh draft

    draft = addHumanChange(draft, 'user-1', 'user@example.com', 'insert', 'Edit.');
    expect(isConverged(draft)).toBe(false); // pending change

    draft = acceptChange(draft, draft.changes[0].id);
    expect(isConverged(draft)).toBe(true); // all resolved
  });

  it('getConvergedContent folds accepted changes over the base in order', () => {
    let draft = createSectionDraft('context_of_org', baseContent);
    draft = addHumanChange(draft, 'user-1', 'user@example.com', 'replace', 'Human rewrite.');
    draft = addAgentProposal(draft, 'Agent revision.');

    // Only the human change accepted → converged content is the human text
    let resolved = acceptChange(draft, draft.changes[0].id);
    expect(getConvergedContent(resolved)).toBe('Human rewrite.');

    // Agent proposal accepted too → the LAST accepted replace wins
    resolved = acceptChange(resolved, resolved.changes[1].id);
    expect(getConvergedContent(resolved)).toBe('Agent revision.');
  });

  it('getConvergedContent ignores pending + rejected changes', () => {
    let draft = createSectionDraft('context_of_org', baseContent);
    draft = addHumanChange(draft, 'user-1', 'user@example.com', 'insert', 'Extra.');
    draft = addAgentProposal(draft, 'Agent rewrite.');

    // Nothing resolved → base content stands
    expect(getConvergedContent(draft)).toBe(baseContent);

    // Insert accepted, proposal rejected → base + accepted insert
    let resolved = acceptChange(draft, draft.changes[0].id);
    resolved = rejectChange(resolved, resolved.changes[1].id);
    expect(getConvergedContent(resolved)).toBe(`${baseContent}Extra.`);
  });

  it('multiple changes from different actors maintain order and attribution', () => {
    let draft = createSectionDraft('leadership', 'Top management shall demonstrate leadership.');
    draft = addHumanChange(draft, 'user-a', 'alice@acme.com', 'insert', 'Alice edit');
    draft = addAgentProposal(draft, 'DocStudio revision 1');
    draft = addHumanChange(draft, 'user-b', 'bob@acme.com', 'delete', 'Bob deletion');
    draft = addAgentProposal(draft, 'DocStudio revision 2');

    expect(draft.changes).toHaveLength(4);
    expect(draft.changes[0].actor.name).toBe('alice@acme.com');
    expect(draft.changes[1].actor.name).toBe('DocStudio');
    expect(draft.changes[2].actor.name).toBe('bob@acme.com');
    expect(draft.changes[3].actor.name).toBe('DocStudio');

    // Dual attribution survives in the payload
    const userChanges = draft.changes.filter((c) => c.actor.type === 'user');
    const agentChanges = draft.changes.filter((c) => c.actor.type === 'agent');
    expect(userChanges).toHaveLength(2);
    expect(agentChanges).toHaveLength(2);
  });
});
