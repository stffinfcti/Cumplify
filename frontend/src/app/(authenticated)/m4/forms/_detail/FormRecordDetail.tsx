'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  PageHeader,
  Panel,
  StatusBadge,
  PrimaryButton,
  SecondaryButton,
  ErrorState,
} from '@/components/shared';
import { FormDrawer, type FieldDef } from '@/components/shared';
import { useGraphQL } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { canApprove } from '@/lib/role-matrix';
import styles from './FormRecordDetail.module.css';

/**
 * FormRecordDetail — sectioned form view (spec 41, Task 7).
 *
 * - Server completion counter DISPLAYED (never client-computed).
 * - Autosave debounced into saveFormRecordValues with partial map.
 * - Cleared field sends null (DELETE path).
 * - RelationPicker stores UUID, displays label.
 * - Submit errors map to per-field from requiredMissing.
 * - Immutable complete/approved view is read-only + reopen action.
 * - Approve gated behind canApprove(role, 'M4').
 */

interface FormTemplate {
  id: string;
  key: string;
  titleKey: string;
  sectionCount: number;
  fieldCount: number;
  requiresApproval: boolean;
  standards: string[];
}

interface TemplateSection {
  id: string;
  sectionKey: string;
  titleKey: string;
  fields: TemplateField[];
}

interface TemplateField {
  id: string;
  fieldKey: string;
  labelKey: string;
  fieldType: string;
  required: boolean;
  options: string | null;
  relationTarget: string | null;
}

interface FormCompletion {
  fieldsFilled: number;
  fieldsTotal: number;
  requiredMissing: string[];
}

interface FormRecord {
  id: string;
  templateId: string;
  status: string;
  completion: FormCompletion;
  values: string;
  openedBy: string;
  completedBy: string | null;
  m2NcId: string | null;
  createdAt: string;
  updatedAt: string;
}

const GET_TEMPLATE = `query GetFormTemplate($id: ID!) {
  getFormTemplate(id: $id) { id key titleKey sectionCount fieldCount requiresApproval standards sections { id sectionKey titleKey fields { id fieldKey labelKey fieldType required options relationTarget } } }
}`;

const GET_RECORD = `query GetFormRecord($id: ID!) {
  getFormRecord(id: $id) { id templateId status completion { fieldsFilled fieldsTotal requiredMissing } values openedBy completedBy m2NcId createdAt updatedAt }
}`;

const SAVE_VALUES = `mutation SaveFormRecordValues($input: SaveFormRecordValuesInput!) {
  saveFormRecordValues(input: $input) { id status completion { fieldsFilled fieldsTotal requiredMissing } values updatedAt }
}`;

const SUBMIT_RECORD = `mutation SubmitFormRecord($input: SubmitFormRecordInput!) {
  submitFormRecord(input: $input) { id status completion { fieldsFilled fieldsTotal requiredMissing } values updatedAt }
}`;

const APPROVE_RECORD = `mutation ApproveFormRecord($input: ApproveFormRecordInput!) {
  approveFormRecord(input: $input) { id status completion { fieldsFilled fieldsTotal requiredMissing } values updatedAt }
}`;

const REOPEN_RECORD = `mutation ReopenFormRecord($input: ReopenFormRecordInput!) {
  reopenFormRecord(input: $input) { id status completion { fieldsFilled fieldsTotal requiredMissing } values updatedAt }
}`;

const DEBOUNCE_MS = 1500;
const AUTOSAVE_MAX_RETRIES = 3;
const IMMUTABLE_STATUSES = new Set(['COMPLETE', 'APPROVED']);

export function FormRecordDetail({
  recordId,
  template,
  onBack,
}: {
  recordId: string;
  template: FormTemplate;
  onBack: () => void;
}) {
  const t = useTranslations('forms');
  const tForm = useTranslations('forms.form');
  const { query, mutate } = useGraphQL();
  const { user } = useAuth();
  const role = user?.role ?? 'employee';

  const [sections, setSections] = useState<TemplateSection[]>([]);
  const [record, setRecord] = useState<FormRecord | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());
  const [reopenOpen, setReopenOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveRetriesRef = useRef(0);

  const isImmutable = record ? IMMUTABLE_STATUSES.has(record.status) : false;
  const canAct = canApprove(role, 'M4');

  // Fetch template sections + fields
  const fetchTemplate = useCallback(async () => {
    try {
      const data = await query<{ getFormTemplate: { sections: TemplateSection[] } }>(GET_TEMPLATE, {
        id: template.id,
      });
      setSections(data.getFormTemplate.sections);
    } catch {
      setError(true);
    }
  }, [query, template.id]);

  // Fetch record
  const fetchRecord = useCallback(async () => {
    try {
      const data = await query<{ getFormRecord: FormRecord }>(GET_RECORD, { id: recordId });
      setRecord(data.getFormRecord);
      setValues(JSON.parse(data.getFormRecord.values || '{}'));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, recordId]);

  useEffect(() => {
    fetchTemplate();
    fetchRecord();
  }, [fetchTemplate, fetchRecord]);

  // ─── Autosave (debounced) ──────────────────────────────────────────────────

  function handleFieldChange(fieldKey: string, value: unknown) {
    if (isImmutable) return;
    setValues((prev) => ({ ...prev, [fieldKey]: value }));
    setFieldErrors((prev) => {
      const n = new Set(prev);
      n.delete(fieldKey);
      return n;
    });
    setSubmitError(null);

    // Queue for autosave — send null for cleared fields (DELETE path)
    const saveValue = value === '' || value === undefined ? null : value;
    pendingRef.current[fieldKey] = saveValue;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flushSave(), DEBOUNCE_MS);
  }

  async function flushSave(): Promise<boolean> {
    const toSave = { ...pendingRef.current };
    if (Object.keys(toSave).length === 0) return true;
    // Clear only after we have the copy — but requeue on failure below so a
    // transient autosave error never silently drops the user's edits.
    pendingRef.current = {};

    try {
      const result = await mutate<{ saveFormRecordValues: FormRecord }>(SAVE_VALUES, {
        input: { recordId, values: JSON.stringify(toSave) },
      });
      setRecord(result.saveFormRecordValues);
      autosaveRetriesRef.current = 0;
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'LINK_TARGET_NOT_FOUND') {
        // Surface on the relation field that triggered it
        const relationKeys = Object.keys(toSave).filter((k) => toSave[k] !== null);
        setFieldErrors(new Set(relationKeys));
        setSubmitError(tForm('linkTargetNotFound'));
      } else {
        // Requeue anything newer edits haven't already replaced, and tell the
        // user the autosave failed — the silent-drop path previously left the
        // UI showing values the server never got.
        pendingRef.current = { ...toSave, ...pendingRef.current };
        setSubmitError(tForm('autosaveFailed'));
        autosaveRetriesRef.current += 1;
        if (autosaveRetriesRef.current <= AUTOSAVE_MAX_RETRIES) {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => flushSave(), DEBOUNCE_MS);
        }
      }
      return false;
    }
  }

  // Autosave debounce timer must not fire after unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // ─── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    // Flush pending saves first
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // A failed flush means values exist the server never got — abort submit
    // instead of sealing an immutable record missing the user's edits.
    if (!(await flushSave())) return;

    setActionLoading(true);
    setSubmitError(null);
    setFieldErrors(new Set());

    try {
      const result = await mutate<{ submitFormRecord: FormRecord }>(SUBMIT_RECORD, {
        input: { recordId },
      });
      setRecord(result.submitFormRecord);
      setValues(JSON.parse(result.submitFormRecord.values || '{}'));
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'MAPPING_INCOMPLETE' || msg === 'VALIDATION_INCOMPLETE') {
        // Map per-field errors from server's requiredMissing
        if (record?.completion.requiredMissing) {
          setFieldErrors(new Set(record.completion.requiredMissing));
        }
        setSubmitError(
          msg === 'MAPPING_INCOMPLETE' ? tForm('mappingIncomplete') : tForm('validationIncomplete'),
        );
      } else if (msg === 'SUBMIT_INVALID_STATUS') {
        setSubmitError(tForm('submitInvalidStatus'));
      } else if (msg === 'RECORD_IMMUTABLE') {
        setSubmitError(tForm('recordImmutable'));
      } else {
        setSubmitError(msg);
      }
    } finally {
      setActionLoading(false);
    }
  }

  // ─── Approve ───────────────────────────────────────────────────────────────

  async function handleApprove() {
    setActionLoading(true);
    setSubmitError(null);
    try {
      const result = await mutate<{ approveFormRecord: FormRecord }>(APPROVE_RECORD, {
        input: { recordId },
      });
      setRecord(result.approveFormRecord);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  // ─── Reopen ────────────────────────────────────────────────────────────────

  // FE-3: errors propagate — FormDrawer keeps the drawer open and shows the
  // error inline (previously a swallowed failure still closed the drawer).
  async function handleReopen(formValues: Record<string, string | boolean>) {
    setActionLoading(true);
    try {
      const result = await mutate<{ reopenFormRecord: FormRecord }>(REOPEN_RECORD, {
        input: { recordId, justification: formValues.justification as string },
      });
      setRecord(result.reopenFormRecord);
      setValues(JSON.parse(result.reopenFormRecord.values || '{}'));
    } finally {
      setActionLoading(false);
    }
  }

  // Stable reference — a fresh array each render resets the drawer's
  // [open, fields] effect and wipes whatever the user was typing.
  const reopenFields = useMemo<FieldDef[]>(
    () => [
      { name: 'justification', label: tForm('justification'), type: 'textarea', required: true },
    ],
    [tForm],
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) return <p className={styles.loading}>{tForm('loading')}</p>;
  if (error || !record) return <ErrorState onRetry={fetchRecord} />;

  const completion = record.completion;
  const pct =
    completion.fieldsTotal > 0
      ? Math.round((completion.fieldsFilled / completion.fieldsTotal) * 100)
      : 0;

  return (
    <>
      <PageHeader
        title={t(template.titleKey.replace('forms.', ''))}
        actions={
          <div className={styles.actions}>
            <SecondaryButton onClick={onBack}>{tForm('back')}</SecondaryButton>
            {!isImmutable && (
              <PrimaryButton onClick={handleSubmit} disabled={actionLoading}>
                {tForm('submit')}
              </PrimaryButton>
            )}
            {record.status === 'COMPLETE' && template.requiresApproval && canAct && (
              <PrimaryButton onClick={handleApprove} disabled={actionLoading}>
                {tForm('approve')}
              </PrimaryButton>
            )}
            {isImmutable && canAct && (
              <SecondaryButton onClick={() => setReopenOpen(true)}>
                {tForm('reopen')}
              </SecondaryButton>
            )}
          </div>
        }
      />

      {/* Server-computed completion counter (client DISPLAYS, never computes) */}
      <div className={styles.completion}>
        <StatusBadge status={record.status} />
        <div className={styles.completionTrack}>
          <div className={styles.completionFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.completionText}>
          {completion.fieldsFilled}/{completion.fieldsTotal}
        </span>
      </div>

      {/* Sectioned form */}
      <div className={styles.sections}>
        {sections.map((section) => (
          <Panel key={section.id} title={t(section.titleKey.replace('forms.', ''))}>
            <div className={styles.fieldGroup}>
              {section.fields.map((field) => (
                <FormField
                  key={field.id}
                  field={field}
                  value={values[field.fieldKey]}
                  onChange={(v) => handleFieldChange(field.fieldKey, v)}
                  readOnly={isImmutable}
                  hasError={fieldErrors.has(field.fieldKey)}
                  t={t}
                />
              ))}
            </div>
          </Panel>
        ))}
      </div>

      {submitError && <div className={styles.submitError}>{submitError}</div>}

      <FormDrawer
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        title={tForm('reopenTitle')}
        fields={reopenFields}
        onSubmit={handleReopen}
      />
    </>
  );
}

// ─── FormField component ─────────────────────────────────────────────────────

function FormField({
  field,
  value,
  onChange,
  readOnly,
  hasError,
  t,
}: {
  field: TemplateField;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly: boolean;
  hasError: boolean;
  t: (key: string) => string;
}) {
  const label = t(field.labelKey.replace('forms.', ''));
  // Server data — an unparseable options string must not crash the render.
  const options: string[] = useMemo(() => {
    if (!field.options) return [];
    try {
      const parsed = JSON.parse(field.options) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [field.options]);
  const inputClass = `${styles.fieldInput} ${hasError ? styles.fieldInputError : ''} ${readOnly ? styles.fieldInputReadonly : ''}`;

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>
        {label}
        {field.required && <span className={styles.fieldRequired}>*</span>}
      </label>

      {field.fieldType === 'textarea' && (
        <textarea
          className={`${inputClass} ${styles.fieldTextarea}`}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          readOnly={readOnly}
          aria-invalid={hasError}
        />
      )}

      {(field.fieldType === 'text' || field.fieldType === 'user') && (
        <input
          type="text"
          className={inputClass}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          readOnly={readOnly}
          aria-invalid={hasError}
        />
      )}

      {field.fieldType === 'number' && (
        <input
          type="number"
          className={inputClass}
          value={(value as number) ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          readOnly={readOnly}
          aria-invalid={hasError}
        />
      )}

      {field.fieldType === 'date' && (
        <input
          type="date"
          className={inputClass}
          value={(value as string)?.split('T')[0] ?? ''}
          onChange={(e) =>
            onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)
          }
          readOnly={readOnly}
          aria-invalid={hasError}
        />
      )}

      {(field.fieldType === 'select' || field.fieldType === 'radio') && (
        <select
          className={inputClass}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          disabled={readOnly}
          aria-invalid={hasError}
        >
          <option value="">—</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}

      {field.fieldType === 'multiselect' && (
        <select
          className={inputClass}
          multiple
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
            onChange(selected.length > 0 ? selected : undefined);
          }}
          disabled={readOnly}
          aria-invalid={hasError}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}

      {field.fieldType === 'checkbox' && (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          disabled={readOnly}
          aria-invalid={hasError}
        />
      )}

      {field.fieldType === 'relation' && (
        <div className={styles.relationPicker}>
          <input
            type="text"
            className={inputClass}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || undefined)}
            readOnly={readOnly}
            placeholder={`UUID (${field.relationTarget})`}
            aria-invalid={hasError}
          />
        </div>
      )}

      {hasError && <span className={styles.fieldError}>{t('form.fieldRequired')}</span>}
    </div>
  );
}
