'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { useAuth } from '@/lib/auth-context';
import { useGraphQL } from '@/lib/api';
import { SecondaryButton, PrimaryButton, StatusBadge } from '@/components/shared';
import { GuidanceBanner } from '@/components/shared/GuidanceBanner';
import { MermaidNode } from './MermaidNode';
import {
  type SectionDraft,
  type ChangeEntry,
  createSectionDraft,
  addHumanChange,
  addAgentProposal,
  acceptChange,
  rejectChange,
  isConverged,
  getConvergedContent,
} from './attribution';
import styles from './DocumentEditor.module.css';

/**
 * DocumentEditor — Tiptap MS-Office-grade editor on controlled-doc sections.
 * Per ims-experience/view-designs.md §13.
 *
 * Collaboration Law mechanics:
 * - Baseline text = agent-generated content (attribution: agent)
 * - Human edits = tracked changes attributed to signed-in user
 * - Iterate with agent = regenerateSection; proposal attributed to agent
 * - Accept/reject per change; converged state flows to submitDocument
 * - Dual attribution (ES-4) persists in the draft payload
 *
 * Local draft model with RS-9 sync-pending honest flag.
 */

interface ContentSection {
  harmonizationKey: string;
  kind: string;
  sentences?: Array<{ text: string; factRefs?: string[] }>;
  gap?: { missingSources: string[] };
  naJustification?: string;
  /** RS-9: a prior saved edit — becomes the editor baseline when present */
  humanEditedBody?: string;
}

interface DocumentEditorProps {
  sections: ContentSection[];
  runId: string;
  documentId: string;
  /** Latest document version id — REQUIRED for saving (RS-9 writes a NEW version on it). */
  versionId?: string | null;
  /** A section edit persisted — parent should refetch content + versions. */
  onSaved?: () => void;
  onConverge?: (harmonizationKey: string, content: string) => void;
}

const REGENERATE_MUTATION = `mutation RegenerateSection($input: RegenerateSectionInput!) {
  regenerateSection(input: $input) { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
}`;

// RS-9 persistence — the missing wire (owner 2026-07-22: "draft documents
// must be available for edit"): the editor tracked changes locally and never
// saved. Every save writes a NEW document version (7.5.2 versioning law).
const SAVE_SECTION_EDIT = `mutation SaveDocumentSectionEdit($input: SaveDocumentSectionEditInput!) {
  saveDocumentSectionEdit(input: $input) { id versionNo changeSummary createdAt }
}`;

export function DocumentEditor({ sections, runId, documentId: _documentId, versionId, onSaved, onConverge }: DocumentEditorProps) {
  const t = useTranslations('editor');
  const { user } = useAuth();
  const { mutate } = useGraphQL();

  // Local draft state per section
  const [drafts, setDrafts] = useState<Map<string, SectionDraft>>(() => {
    const map = new Map<string, SectionDraft>();
    for (const section of sections) {
      if (section.kind === 'prose' || section.kind === 'PROSE') {
        const text =
          section.humanEditedBody ?? section.sentences?.map((s) => s.text).join(' ') ?? '';
        map.set(section.harmonizationKey, createSectionDraft(section.harmonizationKey, text));
      }
    }
    return map;
  });

  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // RS-9 save: persist the section's current text + tracked-changes payload
  // as a NEW document version; syncStatus returns to 'local' on success.
  const handleSaveSection = useCallback(
    async (harmonizationKey: string) => {
      const draft = drafts.get(harmonizationKey);
      if (!draft || !versionId) return;
      setSaving(harmonizationKey);
      setSaveError(null);
      try {
        await mutate(SAVE_SECTION_EDIT, {
          input: {
            versionId,
            harmonizationKey,
            body: draft.editorContent,
            // ES-4: the ChangeEntry[] attribution payload, stored verbatim
            trackedChanges: JSON.stringify(draft.changes),
          },
        });
        setDrafts((prev) => {
          const d = prev.get(harmonizationKey);
          if (!d) return prev;
          const next = new Map(prev);
          next.set(harmonizationKey, { ...d, syncStatus: 'local' });
          return next;
        });
        onSaved?.();
      } catch (err) {
        setSaveError((err as Error).message || t('saveFailed'));
      } finally {
        setSaving(null);
      }
    },
    [drafts, versionId, mutate, onSaved, t],
  );

  // Handle human edit on a section
  const handleEdit = useCallback(
    (harmonizationKey: string, newContent: string) => {
      setDrafts((prev) => {
        const draft = prev.get(harmonizationKey);
        if (!draft) return prev;
        const updated = addHumanChange(
          { ...draft, editorContent: newContent },
          user?.sub ?? 'unknown',
          user?.email ?? 'unknown',
          'replace',
          newContent,
        );
        const next = new Map(prev);
        next.set(harmonizationKey, updated);
        return next;
      });
    },
    [user],
  );

  // Iterate with agent: regenerateSection
  const handleRegenerate = useCallback(
    async (harmonizationKey: string) => {
      setRegenerating(harmonizationKey);
      try {
        const result = await mutate<{
          regenerateSection: { harmonizationKey: string; kind: string };
        }>(REGENERATE_MUTATION, {
          input: { runId, harmonizationKey },
        });
        // Agent response lands as a tracked PROPOSAL, never silently replacing
        setDrafts((prev) => {
          const draft = prev.get(harmonizationKey);
          if (!draft) return prev;
          const updated = addAgentProposal(
            draft,
            `[Agent revision for ${result.regenerateSection.harmonizationKey}]`,
          );
          const next = new Map(prev);
          next.set(harmonizationKey, updated);
          return next;
        });
      } catch {
        // Error handling — the section remains unchanged
      } finally {
        setRegenerating(null);
      }
    },
    [mutate, runId],
  );

  // Accept/reject a tracked change. §13.2 point 4: the CONVERGED state (all
  // changes resolved) is what flows to submitDocumentForApproval — fire
  // onConverge the moment resolving THIS change brings the section to
  // convergence, so a consumer can act on it without polling draft state.
  const handleAccept = useCallback(
    (harmonizationKey: string, changeId: string) => {
      setDrafts((prev) => {
        const draft = prev.get(harmonizationKey);
        if (!draft) return prev;
        const resolved = acceptChange(draft, changeId);
        const next = new Map(prev);
        next.set(harmonizationKey, resolved);
        if (isConverged(resolved)) {
          onConverge?.(harmonizationKey, getConvergedContent(resolved));
        }
        return next;
      });
    },
    [onConverge],
  );

  const handleReject = useCallback(
    (harmonizationKey: string, changeId: string) => {
      setDrafts((prev) => {
        const draft = prev.get(harmonizationKey);
        if (!draft) return prev;
        const resolved = rejectChange(draft, changeId);
        const next = new Map(prev);
        next.set(harmonizationKey, resolved);
        if (isConverged(resolved)) {
          onConverge?.(harmonizationKey, getConvergedContent(resolved));
        }
        return next;
      });
    },
    [onConverge],
  );

  // Check if any section has pending RS-9 sync
  const hasPendingSync = useMemo(
    () => Array.from(drafts.values()).some((d) => d.syncStatus === 'pending-rs9'),
    [drafts],
  );

  return (
    <div className={styles.editor}>
      {/* RS-9 sync-pending banner — honest, never faked */}
      {hasPendingSync && (
        <GuidanceBanner message={t('syncPending')} variant="warning" />
      )}

      {/* Per-section editors */}
      {sections.map((section) => {
        if (section.kind !== 'prose' && section.kind !== 'PROSE') {
          return (
            <SectionNonEditable
              key={section.harmonizationKey}
              section={section}
              t={t}
            />
          );
        }
        const draft = drafts.get(section.harmonizationKey);
        if (!draft) return null;
        return (
          <SectionEditor
            key={section.harmonizationKey}
            draft={draft}
            isRegenerating={regenerating === section.harmonizationKey}
            isSaving={saving === section.harmonizationKey}
            canSave={!!versionId}
            saveError={saving === null && saveError ? saveError : null}
            onSave={() => handleSaveSection(section.harmonizationKey)}
            onEdit={(content) => handleEdit(section.harmonizationKey, content)}
            onRegenerate={() => handleRegenerate(section.harmonizationKey)}
            onAcceptChange={(changeId) => handleAccept(section.harmonizationKey, changeId)}
            onRejectChange={(changeId) => handleReject(section.harmonizationKey, changeId)}
            t={t}
          />
        );
      })}
    </div>
  );
}

// ─── Section Editor (Tiptap instance per section) ────────────────────────────

interface SectionEditorProps {
  draft: SectionDraft;
  isRegenerating: boolean;
  isSaving: boolean;
  canSave: boolean;
  saveError: string | null;
  onSave: () => void;
  onEdit: (content: string) => void;
  onRegenerate: () => void;
  onAcceptChange: (changeId: string) => void;
  onRejectChange: (changeId: string) => void;
  t: (key: string) => string;
}

function SectionEditor({
  draft,
  isRegenerating,
  isSaving,
  canSave,
  saveError,
  onSave,
  onEdit,
  onRegenerate,
  onAcceptChange,
  onRejectChange,
  t,
}: SectionEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      MermaidNode,
    ],
    content: `<p>${draft.baseContent}</p>`,
    onUpdate: ({ editor: ed }) => {
      onEdit(ed.getHTML());
    },
  });

  const pendingChanges = draft.changes.filter((c) => c.status === 'pending');
  const converged = isConverged(draft);

  return (
    <div className={styles.sectionEditor}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionKey}>{draft.harmonizationKey}</span>
        <div className={styles.sectionActions}>
          {converged && (
            <StatusBadge status="APPROVED" />
          )}
          <SecondaryButton
            onClick={() => editor?.chain().focus().insertMermaidBlock().run()}
          >
            {t('insertDiagram')}
          </SecondaryButton>
          <SecondaryButton
            onClick={onRegenerate}
            disabled={isRegenerating}
          >
            {isRegenerating ? t('regenerating') : t('iterateWithAgent')}
          </SecondaryButton>
          {/* RS-9 save — enabled once the draft has unsynced changes */}
          <PrimaryButton
            onClick={onSave}
            disabled={!canSave || isSaving || draft.syncStatus !== 'pending-rs9'}
          >
            {isSaving ? t('saving') : t('saveVersion')}
          </PrimaryButton>
        </div>
      </div>
      {saveError && <p className={styles.saveError}>{saveError}</p>}

      {/* Tiptap editor area */}
      <div className={styles.editorContent}>
        <EditorContent editor={editor} />
      </div>

      {/* Tracked changes panel */}
      {pendingChanges.length > 0 && (
        <div className={styles.changesPanel}>
          <h4 className={styles.changesPanelTitle}>{t('trackedChanges')}</h4>
          {pendingChanges.map((change) => (
            <TrackedChangeItem
              key={change.id}
              change={change}
              onAccept={() => onAcceptChange(change.id)}
              onReject={() => onRejectChange(change.id)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tracked Change Item ─────────────────────────────────────────────────────

function TrackedChangeItem({
  change,
  onAccept,
  onReject,
  t,
}: {
  change: ChangeEntry;
  onAccept: () => void;
  onReject: () => void;
  t: (key: string) => string;
}) {
  const isAgent = change.actor.type === 'agent';
  return (
    <div className={`${styles.changeItem} ${isAgent ? styles.changeAgent : styles.changeHuman}`}>
      <div className={styles.changeMeta}>
        <span className={styles.changeActor}>
          {isAgent ? '🤖 ' : '👤 '}
          {change.actor.name}
        </span>
        <span className={styles.changeTime}>
          {new Date(change.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <p className={styles.changeContent}>
        {change.content.length > 100 ? `${change.content.slice(0, 100)}…` : change.content}
      </p>
      <div className={styles.changeActions}>
        <button type="button" className={styles.acceptBtn} onClick={onAccept}>
          {t('accept')}
        </button>
        <button type="button" className={styles.rejectBtn} onClick={onReject}>
          {t('reject')}
        </button>
      </div>
    </div>
  );
}

// ─── Non-editable section (gap, na, failed) ──────────────────────────────────

function SectionNonEditable({
  section,
  t,
}: {
  section: ContentSection;
  t: (key: string) => string;
}) {
  return (
    <div className={styles.sectionNonEditable}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionKey}>{section.harmonizationKey}</span>
        <StatusBadge
          status={
            section.kind === 'gap' || section.kind === 'GAP'
              ? 'PENDING'
              : section.kind === 'failed' || section.kind === 'FAILED'
                ? 'REJECTED'
                : 'CLOSED'
          }
        />
      </div>
      <div className={styles.nonEditableContent}>
        {(section.kind === 'gap' || section.kind === 'GAP') && section.gap && (
          <p className={styles.gapText}>
            {t('gapSection')}: {section.gap.missingSources.join(', ')}
          </p>
        )}
        {(section.kind === 'na_justified' || section.kind === 'NA_JUSTIFIED') && (
          <p className={styles.naText}>{section.naJustification ?? t('naSection')}</p>
        )}
        {(section.kind === 'failed' || section.kind === 'FAILED') && (
          <p className={styles.failedText}>{t('failedSection')}</p>
        )}
      </div>
    </div>
  );
}
