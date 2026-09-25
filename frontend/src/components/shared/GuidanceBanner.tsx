'use client';

import { SecondaryButton } from './Buttons';
import styles from './GuidanceBanner.module.css';

/**
 * GuidanceBanner — contextual guidance strip at top of views.
 * Per ims-experience/view-designs.md §3.2.
 * Styled exclusively from design-tokens.ts (CSS variables).
 */

export interface GuidanceBannerProps {
  /** Guidance message text (i18n'd) */
  message: string;
  /** Optional CTA action */
  action?: { label: string; onClick: () => void };
  /** Tints the left accent bar */
  variant?: 'info' | 'success' | 'warning';
}

export function GuidanceBanner({ message, action, variant = 'info' }: GuidanceBannerProps) {
  return (
    <div className={styles.banner}>
      <span className={`${styles.accent} ${styles[variant]}`} aria-hidden="true" />
      <span className={styles.message}>{message}</span>
      {action && <SecondaryButton onClick={action.onClick}>{action.label}</SecondaryButton>}
    </div>
  );
}
