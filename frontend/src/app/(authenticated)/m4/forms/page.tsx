'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  PrimaryButton,
  ErrorState,
  type Column,
} from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { FormRecordDetail } from './_detail/FormRecordDetail';
import styles from './page.module.css';

/**
 * QMS Forms Engine — Template Catalog + Record Register (spec 41, Task 7).
 *
 * View 1: Template catalog cards with clause tags, computed section/field counts
 * from API (BC-1: counts are from sectionCount/fieldCount, never client-computed).
 * Standards filter (TPL-3).
 *
 * View 2: Record register per selected template — DataTable with status,
 * completion counter (server-computed), opened by. Row click → form detail.
 *
 * View 3: Form record detail (sectioned form, autosave, submit, approve, reopen).
 */

interface FormTemplate {
  id: string;
  key: string;
  titleKey: string;
  descriptionKey: string;
  category: string;
  clauseRefs: string[];
  standards: string[];
  requiresApproval: boolean;
  sectionCount: number;
  fieldCount: number;
}

interface FormRecord {
  id: string;
  templateId: string;
  status: string;
  completion: { fieldsFilled: number; fieldsTotal: number; requiredMissing: string[] };
  openedBy: string;
  createdAt: string;
  updatedAt: string;
}

const LIST_TEMPLATES = `query ListFormTemplates {
  listFormTemplates { id key titleKey descriptionKey category clauseRefs standards requiresApproval sectionCount fieldCount }
}`;

const LIST_RECORDS = `query ListFormRecords($templateId: ID!, $status: FormRecordStatus) {
  listFormRecords(templateId: $templateId, status: $status) { id templateId status completion { fieldsFilled fieldsTotal requiredMissing } openedBy createdAt updatedAt }
}`;

const CREATE_RECORD = `mutation CreateFormRecord($templateId: ID!) {
  createFormRecord(templateId: $templateId) { id templateId status }
}`;

const STANDARDS_FILTER = ['', 'ISO9001', 'ISO14001', 'ISO45001'] as const;

export default function FormsPage() {
  const t = useTranslations('forms');
  const tCatalog = useTranslations('forms.catalog');
  const tRegister = useTranslations('forms.register');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { query, mutate } = useGraphQL();

  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filterStandard, setFilterStandard] = useState('');

  // Selected template → record register view
  const [selectedTemplate, setSelectedTemplate] = useState<FormTemplate | null>(null);
  const [records, setRecords] = useState<FormRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  // Selected record → form detail view
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  // URL sync
  useEffect(() => {
    const tplParam = searchParams.get('tpl');
    const recParam = searchParams.get('rec');
    if (recParam) setSelectedRecordId(recParam);
    if (tplParam && templates.length > 0) {
      const tpl = templates.find((t) => t.id === tplParam);
      if (tpl) setSelectedTemplate(tpl);
    }
  }, [searchParams, templates]);

  const fetchTemplates = useCallback(async () => {
    try {
      setError(false);
      const data = await query<{ listFormTemplates: FormTemplate[] }>(LIST_TEMPLATES);
      setTemplates(data.listFormTemplates);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const fetchRecords = useCallback(
    async (templateId: string) => {
      try {
        setRecordsLoading(true);
        setError(false);
        const data = await query<{ listFormRecords: FormRecord[] }>(LIST_RECORDS, { templateId });
        setRecords(data.listFormRecords);
      } catch {
        setError(true);
      } finally {
        setRecordsLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    if (selectedTemplate) fetchRecords(selectedTemplate.id);
  }, [selectedTemplate, fetchRecords]);

  async function handleCreateRecord() {
    if (!selectedTemplate) return;
    try {
      await mutate(CREATE_RECORD, { templateId: selectedTemplate.id });
      await fetchRecords(selectedTemplate.id);
    } catch {
      setError(true);
    }
  }

  // Filter templates by standard
  const filteredTemplates = filterStandard
    ? templates.filter((t) => t.standards.includes(filterStandard))
    : templates;

  // Resolve i18n keys for template display
  function tplTitle(tpl: FormTemplate): string {
    try {
      return t(tpl.titleKey.replace('forms.', ''));
    } catch {
      return tpl.key;
    }
  }
  function tplDesc(tpl: FormTemplate): string {
    try {
      return t(tpl.descriptionKey.replace('forms.', ''));
    } catch {
      return '';
    }
  }

  // ─── View 3: Form record detail ────────────────────────────────────────────
  if (selectedRecordId && selectedTemplate) {
    return (
      <FormRecordDetail
        recordId={selectedRecordId}
        template={selectedTemplate}
        onBack={() => {
          setSelectedRecordId(null);
          router.replace(`?tpl=${selectedTemplate.id}`, { scroll: false });
        }}
      />
    );
  }

  // ─── View 2: Record register per template ──────────────────────────────────
  if (selectedTemplate) {
    const columns: Column<FormRecord>[] = [
      {
        key: 'status',
        header: tRegister('colStatus'),
        render: (r) => <StatusBadge status={r.status} />,
      },
      {
        key: 'completion',
        header: tRegister('colCompletion'),
        render: (r) => (
          <div className={styles.completionBar}>
            <div className={styles.completionTrack}>
              <div
                className={styles.completionFill}
                style={{
                  width:
                    r.completion.fieldsTotal > 0
                      ? `${(r.completion.fieldsFilled / r.completion.fieldsTotal) * 100}%`
                      : '0%',
                }}
              />
            </div>
            <span>
              {r.completion.fieldsFilled}/{r.completion.fieldsTotal}
            </span>
          </div>
        ),
      },
      { key: 'openedBy', header: tRegister('colOpenedBy'), render: (r) => r.openedBy },
      {
        key: 'updatedAt',
        header: tRegister('colUpdated'),
        render: (r) => new Date(r.updatedAt).toLocaleDateString(),
      },
    ];

    return (
      <>
        <PageHeader
          title={tplTitle(selectedTemplate)}
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <PrimaryButton onClick={handleCreateRecord}>{tRegister('newRecord')}</PrimaryButton>
              <PrimaryButton
                onClick={() => {
                  setSelectedTemplate(null);
                  router.replace('?', { scroll: false });
                }}
              >
                {tRegister('backToCatalog')}
              </PrimaryButton>
            </div>
          }
        />
        {error && !recordsLoading ? (
          <ErrorState onRetry={() => fetchRecords(selectedTemplate.id)} />
        ) : recordsLoading ? (
          <p className={styles.loading}>{tRegister('loading')}</p>
        ) : (
          <DataTable
            columns={columns}
            data={records}
            rowKey={(r) => r.id}
            onRowClick={(r) => {
              setSelectedRecordId(r.id);
              router.replace(`?tpl=${selectedTemplate.id}&rec=${r.id}`, { scroll: false });
            }}
            emptyMessage={tRegister('empty')}
          />
        )}
      </>
    );
  }

  // ─── View 1: Template catalog ──────────────────────────────────────────────

  if (error && !loading) return <ErrorState onRetry={fetchTemplates} />;

  return (
    <>
      <PageHeader title={tCatalog('title')} />

      {/* Standards filter */}
      <div className={styles.filters}>
        <div className={styles.pills}>
          {STANDARDS_FILTER.map((s) => (
            <button
              key={s || 'all'}
              type="button"
              className={`${styles.pill} ${filterStandard === s ? styles.pillActive : ''}`}
              onClick={() => setFilterStandard(s)}
            >
              {s ? s.replace('ISO', 'ISO ') : tCatalog('filterAll')}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className={styles.loading}>{tCatalog('loading')}</p>
      ) : (
        <div className={styles.catalog}>
          {filteredTemplates.map((tpl) => (
            <div
              key={tpl.id}
              className={styles.card}
              onClick={() => {
                setSelectedTemplate(tpl);
                router.replace(`?tpl=${tpl.id}`, { scroll: false });
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setSelectedTemplate(tpl);
                  router.replace(`?tpl=${tpl.id}`, { scroll: false });
                }
              }}
            >
              <h3 className={styles.cardTitle}>{tplTitle(tpl)}</h3>
              <p className={styles.cardDesc}>{tplDesc(tpl)}</p>
              <div className={styles.cardChips}>
                {/* BC-1: counts from API sectionCount/fieldCount — never client-computed */}
                <span className={styles.chip}>
                  {tpl.sectionCount} {tCatalog('sections')}
                </span>
                <span className={styles.chip}>
                  {tpl.fieldCount} {tCatalog('fields')}
                </span>
                {tpl.clauseRefs.map((c) => (
                  <span key={c} className={`${styles.chip} ${styles.chipAccent}`}>
                    {c}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
