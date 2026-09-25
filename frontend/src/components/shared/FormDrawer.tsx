'use client';

import { useState, useEffect, type ReactNode, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { PrimaryButton, SecondaryButton } from './Buttons';
import { useDialog } from '@/lib/use-dialog';
import styles from './FormDrawer.module.css';

/**
 * FormDrawer — view-designs.md §2.
 * Right-side drawer (480px, bg surface, border-left border).
 * Fields NEVER include tenantId (MOD-8/SCHEMA-5).
 * G5: resets values when `open` transitions to true; converts date fields to ISO.
 * On success: close (caller handles toast/ProvenanceLink via onSuccess callback).
 */

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'date' | 'checkbox';
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- avoids i18n checker false-positive on generic syntax
type SubmitFn = (values: Record<string, string | boolean>) => any;

interface FormDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: FieldDef[];
  onSubmit: SubmitFn;
  /** FE-3: the drawer owns the close-on-success contract — a submit that
   * resolves closes the drawer; a thrown error stays open with the message
   * inline. Set keepOpen for multi-add flows that should remain open. */
  keepOpen?: boolean;
  /** Optional additional content rendered below fields */
  children?: ReactNode;
}

/** Compute default values from field defs */
function computeDefaults(fields: FieldDef[]): Record<string, string | boolean> {
  const defaults: Record<string, string | boolean> = {};
  for (const f of fields) {
    defaults[f.name] = f.type === 'checkbox' ? false : (f.defaultValue ?? '');
  }
  return defaults;
}

/** G5: Convert date values (YYYY-MM-DD) to full ISO 8601 for AWSDateTime. */
function toISOValues(
  values: Record<string, string | boolean>,
  fields: FieldDef[],
): Record<string, string | boolean> {
  const result = { ...values };
  for (const f of fields) {
    if (f.type === 'date' && typeof result[f.name] === 'string' && result[f.name]) {
      const dateStr = result[f.name] as string;
      // Only convert if it's a bare YYYY-MM-DD (not already ISO)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        result[f.name] = new Date(dateStr).toISOString();
      }
    }
  }
  return result;
}

export function FormDrawer({
  open,
  onClose,
  title,
  fields,
  onSubmit,
  keepOpen,
  children,
}: FormDrawerProps) {
  const t = useTranslations('common');
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    computeDefaults(fields),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // FE-10: Escape close, focus trap, initial + return focus, aria-modal
  const { dialogRef, dialogProps } = useDialog(open, onClose);

  // G5: Reset values every time drawer opens (fields may have new defaultValues from chip params)
  useEffect(() => {
    if (open) {
      setValues(computeDefaults(fields));
      setError('');
      setSubmitting(false);
    }
  }, [open, fields]);

  if (!open) return null;

  function handleChange(name: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // G5: Convert date fields to ISO before submission
      const converted = toISOValues(values, fields);
      await onSubmit(converted);
      if (!keepOpen) onClose();
    } catch (err) {
      setError((err as Error).message || t('error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer} aria-label={title} ref={dialogRef} {...dialogProps}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            className={styles.closeBtn}
            onClick={onClose}
            type="button"
            aria-label={t('close')}
          >
            ×
          </button>
        </div>
        <form onSubmit={handleFormSubmit}>
          <div className={styles.body}>
            {fields.map((field) => (
              <div key={field.name} className={styles.field}>
                <label htmlFor={`fd-${field.name}`} className={styles.label}>
                  {field.label}
                </label>
                {field.type === 'select' ? (
                  <select
                    id={`fd-${field.name}`}
                    className={`${styles.input} ${styles.select}`}
                    value={values[field.name] as string}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    required={field.required}
                  >
                    <option value="">&mdash;</option>
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'textarea' ? (
                  <textarea
                    id={`fd-${field.name}`}
                    className={`${styles.input} ${styles.textarea}`}
                    value={values[field.name] as string}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    required={field.required}
                  />
                ) : field.type === 'checkbox' ? (
                  <input
                    id={`fd-${field.name}`}
                    type="checkbox"
                    checked={values[field.name] as boolean}
                    onChange={(e) => handleChange(field.name, e.target.checked)}
                  />
                ) : (
                  <input
                    id={`fd-${field.name}`}
                    type={field.type === 'date' ? 'date' : 'text'}
                    className={styles.input}
                    value={values[field.name] as string}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    required={field.required}
                  />
                )}
              </div>
            ))}
            {children}
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.footer}>
            <PrimaryButton type="submit" disabled={submitting}>
              {submitting ? t('loading') : t('submit')}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={onClose}>
              {t('cancel')}
            </SecondaryButton>
          </div>
        </form>
      </aside>
    </div>
  );
}
