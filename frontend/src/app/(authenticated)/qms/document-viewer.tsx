'use client';

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { PrimaryButton, SecondaryButton, StatusBadge, ErrorState } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { errorText } from '@/lib/error-text';
import { useAuth } from '@/lib/auth-context';
import { canApprove } from '@/lib/role-matrix';
import styles from './page.module.css';
import { parseAwsJson } from '@/lib/aws-json';

// ─── GraphQL statements ──────────────────────────────────────────────────────

const LIST_DOCUMENT_VERSIONS = `query ListDocumentVersions($documentId: ID!) {
  listDocumentVersions(documentId: $documentId) {
    id documentId versionNo contentRef changeSummary authorId createdAt
  }
}`;

const GET_DOCUMENT_CONTENT = `query GetDocumentContent($versionId: ID!) {
  getDocumentContent(versionId: $versionId)
}`;

const LIST_GENERATION_RUNS = `query ListGenerationRuns($limit: Int) {
  listGenerationRuns(limit: $limit) {
    id status standards sections { id harmonizationKey kind reviewedBy reviewedAt }
    manualDocumentId gapCount startedAt finishedAt
  }
}`;

const MARK_SECTION_REVIEWED = `mutation MarkSectionReviewed($input: MarkSectionReviewedInput!) {
  markSectionReviewed(input: $input) { id harmonizationKey kind clauseRefs contentSha256 reviewedBy reviewedAt error }
}`;

const SUBMIT_FOR_APPROVAL = `mutation SubmitDocumentForApproval($id: ID!) {
  submitDocumentForApproval(id: $id) { id status }
}`;

const REQUEST_IMS_EXPORT = `mutation RequestImsExport($documentId: ID!) {
  requestImsExport(documentId: $documentId) { url expiresAt }
}`;

// ─── Types (matching derive.ts contract verbatim) ────────────────────────────

interface DocumentVersion {
  id: string;
  documentId: string;
  versionNo: number;
  contentRef: string;
  changeSummary: string | null;
  authorId: string;
  createdAt: string;
}

/** clauseRefs entries are objects, not strings */
interface ClauseRef {
  standard: string;
  clauseNo: string;
}

/** Section kinds are LOWERCASE per derive.ts */
type ContentSectionKind = 'prose' | 'gap' | 'na_justified' | 'failed';

/** Real content section shape from assembleManualContent */
interface ContentSection {
  harmonizationKey: string;
  clauseRefs: ClauseRef[];
  kind: ContentSectionKind;
  /** prose sections only */
  sentences?: Array<{ text: string; factRefs?: string[] }>;
  /** gap sections only — NO sentences */
  gap?: { missingSources: string[] };
  /** na_justified sections only */
  naJustification?: string;
  /** failed sections */
  failed?: boolean;
}

/** Real frontMatter shape from buildFrontMatter */
interface FrontMatter {
  purpose: string; // BC-1 disclaimer
  scope: {
    organization: string | null;
    standards: string[];
    sites: string[];
    managementRepresentative: string | null;
  };
  normativeRefs: Array<{ standard: string; source: string }>;
  terms: unknown[];
}

interface DocumentContent {
  schemaVersion: number;
  documentId: string;
  versionNo: number;
  locale: string;
  frontMatter: FrontMatter;
  sections: ContentSection[];
}

/** Minimal run section for review state join */
interface RunSection {
  id: string;
  harmonizationKey: string;
  kind: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface DocumentViewerProps {
  documentId: string;
  onBack: () => void;
  onDiff: (documentId: string, v1: string, v2: string) => void;
}

export function DocumentViewer({ documentId, onBack, onDiff }: DocumentViewerProps) {
  const t = useTranslations('qms.docViewer');
  const tErr = useTranslations('errors');
  const tGen = useTranslations('qms.generation');
  const { query, mutate } = useGraphQL();
  const { user } = useAuth();

  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<DocumentVersion | null>(null);
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [runSections, setRunSections] = useState<Map<string, RunSection>>(new Map());
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Diff selection
  const [diffSelection, setDiffSelection] = useState<string[]>([]);

  // ─── Load versions + run sections for review state ─────────────────────────
  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [verData, runData] = await Promise.all([
        query<{ listDocumentVersions: DocumentVersion[] }>(LIST_DOCUMENT_VERSIONS, { documentId }),
        query<{
          listGenerationRuns: Array<{ manualDocumentId: string | null; sections: RunSection[] }>;
        }>(LIST_GENERATION_RUNS, { limit: 10 }),
      ]);
      // Latest first — never assume the API returns sorted rows
      const sorted = [...verData.listDocumentVersions].sort((a, b) => b.versionNo - a.versionNo);
      setVersions(sorted);
      if (sorted.length > 0) {
        setSelectedVersion(sorted[0]);
      }
      // Join: find the run whose manualDocumentId === this documentId
      const matchingRun = runData.listGenerationRuns.find((r) => r.manualDocumentId === documentId);
      if (matchingRun) {
        const map = new Map<string, RunSection>();
        for (const s of matchingRun.sections) map.set(s.harmonizationKey, s);
        setRunSections(map);
      }
    } catch {
      setError('load');
    } finally {
      setLoading(false);
    }
  }, [query, documentId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  // ─── Load content for selected version ─────────────────────────────────────
  useEffect(() => {
    if (!selectedVersion) return;
    let cancelled = false;
    (async () => {
      try {
        setContentLoading(true);
        setError(null);
        const data = await query<{ getDocumentContent: string }>(GET_DOCUMENT_CONTENT, {
          versionId: selectedVersion.id,
        });
        if (!cancelled) {
          const parsed = parseAwsJson<DocumentContent>(data.getDocumentContent);
          setContent(parsed);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '';
          if (msg.includes('CONTENT_UNAVAILABLE')) setError('contentUnavailable');
          else setError('load');
        }
      } finally {
        if (!cancelled) setContentLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedVersion, query]);

  // ─── Mark section reviewed ─────────────────────────────────────────────────
  async function handleMarkReviewed(sectionId: string, harmonizationKey: string) {
    try {
      const data = await mutate<{
        markSectionReviewed: { id: string; reviewedBy: string; reviewedAt: string };
      }>(MARK_SECTION_REVIEWED, { input: { sectionId } });
      // Update runSections map
      setRunSections((prev) => {
        const next = new Map(prev);
        const existing = next.get(harmonizationKey);
        if (existing) {
          next.set(harmonizationKey, {
            ...existing,
            reviewedBy: data.markSectionReviewed.reviewedBy,
            reviewedAt: data.markSectionReviewed.reviewedAt,
          });
        }
        return next;
      });
    } catch {
      /* server enforces */
    }
  }

  // ─── Submit for approval ───────────────────────────────────────────────────
  async function handleSubmitForApproval() {
    setSubmitError(null);
    setSubmitSuccess(false);
    try {
      await mutate(SUBMIT_FOR_APPROVAL, { id: documentId });
      setSubmitSuccess(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('UNREVIEWED_SECTIONS')) setSubmitError('UNREVIEWED_SECTIONS');
      else if (msg.includes('UNRESOLVED_GAPS')) setSubmitError('UNRESOLVED_GAPS');
      else if (msg.includes('SoD') || msg.includes('SOD')) setSubmitError('SOD_VIOLATION');
      else setSubmitError(errorText(e, tErr, 'generic'));
    }
  }

  // ─── Export ────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const data = await mutate<{ requestImsExport: { url: string; expiresAt: string } }>(
        REQUEST_IMS_EXPORT,
        { documentId },
      );
      // Only ever open an https URL — a non-http(s) scheme in a server
      // response must not become a navigation target.
      const url = data.requestImsExport.url;
      if (!/^https:\/\//.test(url)) {
        setExportError(tErr('generic'));
        return;
      }
      const opened = window.open(url, '_blank', 'noopener');
      if (!opened) {
        // Popup blocked — fall back to same-tab navigation
        window.location.assign(url);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('Unknown field') || msg.includes('EXPORT_NOT_AVAILABLE')) {
        setExportError('BLOCKED');
      } else {
        setExportError(errorText(e, tErr, 'generic'));
      }
    } finally {
      setExporting(false);
    }
  }

  // ─── Diff selection handler ────────────────────────────────────────────────
  function handleDiffToggle(versionId: string) {
    setDiffSelection((prev) => {
      if (prev.includes(versionId)) return prev.filter((v) => v !== versionId);
      if (prev.length >= 2) return [prev[1], versionId];
      return [...prev, versionId];
    });
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  if (error === 'load' && !loading) return <ErrorState onRetry={fetchVersions} />;
  if (loading) return <p className={styles.loading}>{t('versions')}</p>;

  return (
    <div className={styles.documentViewer} data-testid="document-viewer">
      <div className={styles.viewerHeader}>
        <SecondaryButton onClick={onBack} data-testid="viewer-back">
          {t('back')}
        </SecondaryButton>
        <h2 className={styles.viewerTitle}>{t('title')}</h2>
        <div className={styles.viewerActions}>
          {user && canApprove(user.role, 'M1') && (
            <PrimaryButton onClick={handleSubmitForApproval} data-testid="submit-approval-btn">
              {t('submitForApproval')}
            </PrimaryButton>
          )}
          <SecondaryButton onClick={handleExport} disabled={exporting} data-testid="export-btn">
            {t('export')}
          </SecondaryButton>
        </div>
      </div>

      {/* Submit success */}
      {submitSuccess && (
        <div className={styles.successMsg} data-testid="submit-success">
          <p>{t('submitSuccess')}</p>
        </div>
      )}

      {/* Submit errors */}
      {submitError && (
        <div className={styles.submitError} data-testid="submit-error">
          {submitError === 'UNREVIEWED_SECTIONS' && <p>{t('unreviewedSections')}</p>}
          {submitError === 'UNRESOLVED_GAPS' && <p>{t('unresolvedGaps')}</p>}
          {submitError === 'SOD_VIOLATION' && <p>{t('sodViolation')}</p>}
          {submitError !== 'UNREVIEWED_SECTIONS' &&
            submitError !== 'UNRESOLVED_GAPS' &&
            submitError !== 'SOD_VIOLATION' && <p>{submitError}</p>}
        </div>
      )}

      {/* Export error (BLOCKED-ON-ARCHITECT-TASK-9) */}
      {exportError === 'BLOCKED' && (
        <div className={styles.exportBlocked} data-testid="export-blocked">
          <p>{t('exportBlocked')}</p>
        </div>
      )}
      {exportError && exportError !== 'BLOCKED' && (
        <div className={styles.submitError} data-testid="export-error">
          <p>{exportError}</p>
        </div>
      )}

      {/* Version history sidebar + content */}
      <div className={styles.viewerLayout}>
        <div className={styles.versionSidebar} data-testid="version-list">
          <h3 className={styles.sidebarTitle}>{t('versions')}</h3>
          {versions.length === 0 && <p className={styles.emptyMsg}>{t('noVersions')}</p>}
          {versions.map((v) => (
            <div
              key={v.id}
              className={`${styles.versionItem} ${selectedVersion?.id === v.id ? styles.versionActive : ''}`}
            >
              <button
                type="button"
                className={styles.versionBtn}
                onClick={() => setSelectedVersion(v)}
                aria-label={t('versionLabel', { version: v.versionNo })}
              >
                v{v.versionNo} &middot; {new Date(v.createdAt).toLocaleDateString()}
              </button>
              {versions.length > 1 && (
                <input
                  type="checkbox"
                  checked={diffSelection.includes(v.id)}
                  onChange={() => handleDiffToggle(v.id)}
                  aria-label={t('selectVersionForDiff', { version: v.versionNo })}
                />
              )}
            </div>
          ))}
          {diffSelection.length === 2 && (
            <PrimaryButton
              onClick={() => onDiff(documentId, diffSelection[0], diffSelection[1])}
              data-testid="compare-btn"
            >
              {t('diffTitle')}
            </PrimaryButton>
          )}
        </div>

        {/* Content area */}
        <div className={styles.contentArea} data-testid="content-area">
          {contentLoading && <p className={styles.loading}>{t('versions')}</p>}
          {error === 'contentUnavailable' && (
            <p className={styles.errorMsg} data-testid="content-unavailable">
              {t('diffUnavailable')}
            </p>
          )}
          {content && !contentLoading && (
            <div className={styles.documentContent}>
              {/* BC-1 disclaimer block — ALWAYS visible (frontMatter.purpose) */}
              <div className={styles.disclaimer} data-testid="bc1-disclaimer">
                <p>{content.frontMatter.purpose}</p>
                {content.frontMatter.normativeRefs.length > 0 &&
                  /^https:\/\//.test(content.frontMatter.normativeRefs[0].source) && (
                    <a
                      href={content.frontMatter.normativeRefs[0].source}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {content.frontMatter.normativeRefs[0].source}
                    </a>
                  )}
              </div>

              {/* Sections in order */}
              {content.sections.map((section, idx) => {
                const runSection = runSections.get(section.harmonizationKey);
                return (
                  <ContentSectionView
                    key={`${section.harmonizationKey}-${idx}`}
                    section={section}
                    runSection={runSection ?? null}
                    canReview={!!user && canApprove(user.role, 'M1')}
                    onMarkReviewed={handleMarkReviewed}
                    tGen={tGen}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Content Section ─────────────────────────────────────────────────────────

function ContentSectionView({
  section,
  runSection,
  canReview,
  onMarkReviewed,
  tGen,
}: {
  section: ContentSection;
  runSection: RunSection | null;
  canReview: boolean;
  onMarkReviewed: (sectionId: string, harmonizationKey: string) => void;
  tGen: (key: string) => string;
}) {
  const isGap = section.kind === 'gap';
  const isFailed = section.kind === 'failed';
  const isNa = section.kind === 'na_justified';

  return (
    <div
      className={`${styles.contentSection} ${isGap ? styles.gapBlock : ''} ${isFailed ? styles.failedBlock : ''}`}
      data-testid={`doc-section-${section.harmonizationKey}`}
    >
      <div className={styles.sectionHeader}>
        <span className={styles.sectionKey}>{section.harmonizationKey}</span>
        <span className={styles.sectionClauses}>
          {section.clauseRefs.map((c) => `${c.standard} ${c.clauseNo}`).join(', ')}
        </span>
        <StatusBadge
          status={isGap ? 'PENDING' : isFailed ? 'REJECTED' : isNa ? 'CLOSED' : 'APPROVED'}
        />
      </div>

      {/* Prose content */}
      {section.kind === 'prose' && section.sentences && (
        <div className={styles.proseContent}>
          {section.sentences.map((s, i) => (
            <span key={i}>{s.text} </span>
          ))}
        </div>
      )}

      {/* GAP block — visually distinct, renders missingSources */}
      {isGap && section.gap && (
        <div className={styles.gapContent} data-testid={`gap-block-${section.harmonizationKey}`}>
          <strong>{tGen('gapSection')}</strong>
          <ul className={styles.gapSources}>
            {section.gap.missingSources.map((src, i) => (
              <li key={i} className={styles.gapSourceItem}>
                {src}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* N/A justified */}
      {isNa && section.naJustification && (
        <div className={styles.naContent}>
          <em>
            {tGen('naSection')}: {section.naJustification}
          </em>
        </div>
      )}

      {/* Failed marker */}
      {isFailed && (
        <div className={styles.failedContent} data-testid={`failed-${section.harmonizationKey}`}>
          <strong>{tGen('failedSection')}</strong>
        </div>
      )}

      {/* Review state — joined from run.sections by harmonizationKey */}
      <div className={styles.sectionReview}>
        {runSection?.reviewedBy ? (
          <span
            className={styles.reviewedLabel}
            data-testid={`doc-reviewed-${section.harmonizationKey}`}
          >
            {tGen('reviewed')} &middot; {runSection.reviewedBy} &middot;{' '}
            {runSection.reviewedAt ? new Date(runSection.reviewedAt).toLocaleDateString() : ''}
          </span>
        ) : (
          <>
            {canReview && section.kind === 'prose' && runSection && (
              <SecondaryButton
                onClick={() => onMarkReviewed(runSection.id, section.harmonizationKey)}
                data-testid={`doc-review-btn-${section.harmonizationKey}`}
              >
                {tGen('markReviewed')}
              </SecondaryButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}
