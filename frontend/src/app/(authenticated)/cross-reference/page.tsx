'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { PageHeader, ErrorState } from '@/components/shared';
import { GuidanceBanner } from '@/components/shared/GuidanceBanner';
import { useGraphQL } from '@/lib/api';
import { useStandardScope } from '@/lib/standard-scope';
import styles from './page.module.css';
import { parseAwsJson } from '@/lib/aws-json';

/**
 * /cross-reference — Correlation Matrix Grid.
 * §4 row: 5.2 + all clause rows — Correlation matrix spans all standards.
 * Per ims-experience/view-designs.md §11.
 *
 * Renders CORRELATION_MATRIX JSON (kind='correlation_matrix') as interactive grid.
 * Rows = harmonization sections, columns = standards.
 * Cell click navigates to /documents filtered by clause family.
 */

interface MatrixRow {
  harmonizationKey: string;
  sectionKind: string;
  coverage: Array<{
    standard: string;
    clauseNo: string;
    clauseTitle: string;
    annexSlMode: string;
  }>;
}

interface MatrixContent {
  kind: 'correlation_matrix';
  standards: string[];
  rows: MatrixRow[];
}

interface Document {
  id: string;
  docType: string;
  title: string;
  status: string;
}

const LIST_DOCS = `query ListDocs($standard: Standard) {
  listDocuments(standard: $standard) { id docType title status }
}`;

const LIST_VERSIONS = `query ListVersions($documentId: ID!) {
  listDocumentVersions(documentId: $documentId) { id versionNo }
}`;

const GET_CONTENT = `query GetDocumentContent($versionId: ID!) {
  getDocumentContent(versionId: $versionId)
}`;

export default function CrossReferencePage() {
  const t = useTranslations('crossReferencePage');
  const router = useRouter();
  const { query } = useGraphQL();
  const { standard: globalStandard, isIMS } = useStandardScope();

  const [matrix, setMatrix] = useState<MatrixContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [noMatrix, setNoMatrix] = useState(false);

  const fetchMatrix = useCallback(async () => {
    try {
      setError(false);
      setNoMatrix(false);
      // Find the correlation-matrix document
      const docsData = await query<{ listDocuments: Document[] }>(LIST_DOCS, {});
      const matrixDoc = docsData.listDocuments.find((d) => d.docType === 'CORRELATION_MATRIX');

      if (!matrixDoc) {
        setNoMatrix(true);
        return;
      }

      // Get latest version content
      const versionsData = await query<{
        listDocumentVersions: Array<{ id: string; versionNo: number }>;
      }>(LIST_VERSIONS, { documentId: matrixDoc.id });

      if (versionsData.listDocumentVersions.length === 0) {
        setNoMatrix(true);
        return;
      }

      const latestVersion = versionsData.listDocumentVersions[0];
      const contentData = await query<{ getDocumentContent: string }>(GET_CONTENT, {
        versionId: latestVersion.id,
      });

      const parsed = parseAwsJson<MatrixContent>(contentData.getDocumentContent);
      if (parsed.kind !== 'correlation_matrix') {
        setNoMatrix(true);
        return;
      }

      setMatrix(parsed);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchMatrix();
  }, [fetchMatrix]);

  function handleCellClick(clauseNo: string) {
    const familyPrefix = clauseNo.split('.')[0];
    router.push(`/documents?clauseFamily=${familyPrefix}`);
  }

  function getModeBadgeClass(mode: string): string {
    if (mode.toLowerCase() === 'shall') return styles.modeShall;
    if (mode.toLowerCase() === 'should') return styles.modeShould;
    return styles.modeOther;
  }

  if (error && !loading) return <ErrorState onRetry={fetchMatrix} />;

  return (
    <>
      <PageHeader title={t('title')} />

      {loading && <p className={styles.loading}>{t('loading')}</p>}

      {noMatrix && !loading && (
        <GuidanceBanner
          message={t('noMatrix')}
          action={{ label: t('goToManual'), onClick: () => router.push('/manual') }}
          variant="info"
        />
      )}

      {matrix && (
        <div className={styles.gridContainer}>
          <table className={styles.grid}>
            <thead>
              <tr>
                <th className={styles.sectionCol}>{t('colSection')}</th>
                <th className={styles.kindCol}>{t('colKind')}</th>
                {matrix.standards.map((std) => (
                  <th
                    key={std}
                    className={`${styles.stdCol} ${!isIMS && globalStandard === std ? styles.stdHighlight : ''}`}
                  >
                    {std.replace('ISO', 'ISO ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => {
                const byStd = new Map<string, typeof row.coverage>();
                for (const c of row.coverage) {
                  const list = byStd.get(c.standard) ?? [];
                  list.push(c);
                  byStd.set(c.standard, list);
                }
                return (
                  <tr key={row.harmonizationKey} className={styles.row}>
                    <td className={styles.sectionCell}>{row.harmonizationKey}</td>
                    <td className={styles.kindCell}>{row.sectionKind}</td>
                    {matrix.standards.map((std) => {
                      const entries = byStd.get(std);
                      return (
                        <td
                          key={std}
                          className={`${styles.cell} ${!isIMS && globalStandard === std ? styles.cellHighlight : ''}`}
                        >
                          {entries ? (
                            entries.map((entry) => (
                              <button
                                key={entry.clauseNo}
                                type="button"
                                className={styles.cellEntry}
                                onClick={() => handleCellClick(entry.clauseNo)}
                                title={entry.clauseTitle}
                              >
                                <span className={styles.clauseNo}>{entry.clauseNo}</span>
                                <span
                                  className={`${styles.modeBadge} ${getModeBadgeClass(entry.annexSlMode)}`}
                                >
                                  {entry.annexSlMode}
                                </span>
                              </button>
                            ))
                          ) : (
                            <span className={styles.empty}>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
