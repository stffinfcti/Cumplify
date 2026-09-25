'use client';

import { useTranslations } from 'next-intl';
import styles from './StatusBadge.module.css';

/**
 * StatusBadge — view-designs.md §2.
 * Pill, labelSmall; status→color mapping:
 * draft/pending = warning, approved/closed/published = success,
 * rejected/overdue/escalated = danger, in-progress/info = accentMuted.
 *
 * m3 fix: renders status text via i18n namespace (status.*) instead of raw enum.
 */

type StatusVariant = 'warning' | 'success' | 'danger' | 'info';

const STATUS_VARIANT: Record<string, StatusVariant> = {
  DRAFT: 'warning',
  PENDING: 'warning',
  IN_REVIEW: 'warning',
  OPEN: 'warning',
  APPROVED: 'success',
  CLOSED: 'success',
  VERIFIED: 'success',
  COMPLETED: 'success',
  OBSOLETE: 'success',
  REJECTED: 'danger',
  CRITICAL: 'danger',
  HIGH: 'danger',
  IN_PROGRESS: 'info',
  MEDIUM: 'info',
  LOW: 'info',
};

function getVariant(status: string): StatusVariant {
  const upper = status.toUpperCase().replace(/ /g, '_');
  return STATUS_VARIANT[upper] ?? 'info';
}

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('status');
  const variant = getVariant(status);
  // Normalize to upper-case key for i18n lookup
  const key = status.toUpperCase().replace(/ /g, '_');
  // Fallback to formatted raw string if key not found
  const label = t.has(key) ? t(key) : status.replace(/_/g, ' ');

  return <span className={`${styles.badge} ${styles[variant]}`}>{label}</span>;
}
