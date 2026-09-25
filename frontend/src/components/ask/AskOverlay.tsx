'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AskPanel } from './AskPanel';
import { useDialog } from '@/lib/use-dialog';
import styles from './AskOverlay.module.css';

/**
 * AskOverlay — §4 floating trigger (bottom-right pill, logo mark) on every view.
 * Opens the AskPanel as a 420px right sheet overlay.
 * Hidden on the /ask page itself (where AskPanel is full-page).
 * P2: aria-labels localized via ask.* namespace.
 */
export function AskOverlay() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const t = useTranslations('ask');

  // FE-10: Escape close, focus trap, initial + return focus, aria-modal
  const { dialogRef, dialogProps } = useDialog(open, () => setOpen(false));

  // Don't show the overlay trigger on the full-page /ask route
  if (pathname === '/ask') return null;

  return (
    <>
      {/* Floating trigger */}
      {!open && (
        <button
          className={styles.trigger}
          onClick={() => setOpen(true)}
          type="button"
          aria-label={t('title')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.37 5.07L2 22l4.93-1.37A9.96 9.96 0 0012 22c5.52 0 10-4.48 10-10S17.52 2 12 2z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M8 12h.01M12 12h.01M16 12h.01"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}

      {/* Sheet overlay */}
      {open && (
        <div className={styles.overlay}>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <aside
            className={styles.sheet}
            aria-label={t('title')}
            ref={dialogRef}
            {...dialogProps}
          >
            <button
              className={styles.closeBtn}
              onClick={() => setOpen(false)}
              type="button"
              aria-label={t('close')}
            >
              ×
            </button>
            <AskPanel />
          </aside>
        </div>
      )}
    </>
  );
}
