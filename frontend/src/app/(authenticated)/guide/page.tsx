'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PageHeader, DataTable, ErrorState, type Column } from '@/components/shared';
import { ReadyPill, type ReadyState } from '@/components/shared/ReadyPill';
import { ClauseChip } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useStandardScope } from '@/lib/standard-scope';
import styles from './page.module.css';

/**
 * /guide — 80-row Clause Registry with applicability badges.
 * §4 row: 4.1–4.3 through 10.2 — entire clause spine.
 * Per ims-experience/view-designs.md §12.
 *
 * StandardSwitch-aware: filters by standard when scope ≠ IMS.
 * ReadyPill for applicability state. Harmonization badges for cross-standard mappings.
 */

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

const LIST_REGISTRY = `query ListClauseRegistry($standard: Standard) {
  listClauseRegistry(standard: $standard) { id standard clauseNo clauseTitle intentParaphrase requiredSources sortOrder }
}`;

const LIST_APPLICABILITY = `query ListClauseApplicability {
  listClauseApplicability { id clauseRegistryId applicable justification }
}`;

export default function GuidePage() {
  const t = useTranslations('guidePage');
  const { query } = useGraphQL();
  const { standard: globalStandard, isIMS } = useStandardScope();

  const [clauses, setClauses] = useState<ClauseEntry[]>([]);
  const [applicability, setApplicability] = useState<Map<string, Applicability>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const effectiveStandard = isIMS ? '' : globalStandard;

  const fetchData = useCallback(async () => {
    try {
      setError(false);
      const vars: Record<string, unknown> = {};
      if (effectiveStandard) vars.standard = effectiveStandard;

      const [regData, appData] = await Promise.all([
        query<{ listClauseRegistry: ClauseEntry[] }>(LIST_REGISTRY, vars),
        query<{ listClauseApplicability: Applicability[] }>(LIST_APPLICABILITY),
      ]);

      setClauses(regData.listClauseRegistry);
      const appMap = new Map<string, Applicability>();
      for (const a of appData.listClauseApplicability) appMap.set(a.clauseRegistryId, a);
      setApplicability(appMap);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, effectiveStandard]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Detect harmonization: clauses with same clauseNo across different standards
  const harmonizationMap = useMemo(() => {
    const byClauseNo = new Map<string, ClauseEntry[]>();
    for (const c of clauses) {
      const list = byClauseNo.get(c.clauseNo) ?? [];
      list.push(c);
      byClauseNo.set(c.clauseNo, list);
    }
    // Only keep entries with >1 standard mapping
    const harmonized = new Map<string, string[]>();
    for (const entries of byClauseNo.values()) {
      if (entries.length > 1) {
        for (const entry of entries) {
          const others = entries
            .filter((e) => e.id !== entry.id)
            .map((e) => `${e.standard} ${e.clauseNo}`);
          harmonized.set(entry.id, others);
        }
      }
    }
    return harmonized;
  }, [clauses]);

  function getApplicabilityState(clauseId: string): ReadyState {
    const app = applicability.get(clauseId);
    if (!app) return 'unknown';
    return app.applicable ? 'ready' : 'not-ready';
  }

  const columns: Column<ClauseEntry>[] = useMemo(
    () => [
      {
        key: 'clauseNo',
        header: t('colClause'),
        render: (c) => (
          <span className={styles.clauseNoCell}>
            {c.clauseNo}
            {harmonizationMap.has(c.id) && (
              <span
                className={styles.harmonizeBadge}
                title={harmonizationMap.get(c.id)!.join(', ')}
              >
                ⟷
              </span>
            )}
          </span>
        ),
      },
      { key: 'clauseTitle', header: t('colTitle'), render: (c) => c.clauseTitle },
      ...(isIMS
        ? [
            {
              key: 'standard' as const,
              header: t('colStandard'),
              render: (c: ClauseEntry) => <ClauseChip standard={c.standard} clauseRef={null} />,
            },
          ]
        : []),
      {
        key: 'intentParaphrase',
        header: t('colIntent'),
        render: (c) => (
          <span className={styles.intentCell} title={c.intentParaphrase}>
            {c.intentParaphrase.length > 80
              ? `${c.intentParaphrase.slice(0, 80)}…`
              : c.intentParaphrase}
          </span>
        ),
      },
      {
        key: 'applicability',
        header: t('colApplicability'),
        render: (c) => <ReadyPill state={getApplicabilityState(c.id)} />,
      },
    ],
    [t, isIMS, harmonizationMap, applicability],
  );

  if (error && !loading) return <ErrorState onRetry={fetchData} />;

  return (
    <>
      <PageHeader title={t('title')} />

      {loading ? (
        <p className={styles.loading}>{t('loading')}</p>
      ) : (
        <DataTable
          columns={columns}
          data={clauses}
          rowKey={(c) => c.id}
          onRowClick={(c) => setExpandedId(expandedId === c.id ? null : c.id)}
          emptyMessage={t('empty')}
        />
      )}

      {/* Expanded detail */}
      {expandedId &&
        (() => {
          const clause = clauses.find((c) => c.id === expandedId);
          if (!clause) return null;
          const app = applicability.get(clause.id);
          let sources: string[] = [];
          try {
            sources = JSON.parse(clause.requiredSources);
          } catch {
            /* empty */
          }
          return (
            <div className={styles.expandedDetail}>
              <h4 className={styles.expandedTitle}>
                {clause.clauseNo} — {clause.clauseTitle}
              </h4>
              <p className={styles.expandedIntent}>{clause.intentParaphrase}</p>
              {sources.length > 0 && (
                <div className={styles.expandedSources}>
                  <span className={styles.sourcesLabel}>{t('requiredSources')}:</span>
                  <ul className={styles.sourcesList}>
                    {sources.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {app && !app.applicable && app.justification && (
                <p className={styles.justification}>
                  <strong>{t('exclusionJustification')}:</strong> {app.justification}
                </p>
              )}
              {harmonizationMap.has(clause.id) && (
                <p className={styles.harmonizeNote}>
                  {t('harmonizedWith')}: {harmonizationMap.get(clause.id)!.join(', ')}
                </p>
              )}
            </div>
          );
        })()}
    </>
  );
}
