'use client';

import { useTranslations } from 'next-intl';
import { useStandardScope, type StandardScope } from '@/lib/standard-scope';
import styles from './StandardSwitch.module.css';

const OPTIONS: { value: StandardScope; labelKey: string }[] = [
  { value: 'ISO9001', labelKey: 'standardIso9001' },
  { value: 'ISO14001', labelKey: 'standardIso14001' },
  { value: 'ISO45001', labelKey: 'standardIso45001' },
  { value: 'IMS', labelKey: 'standardIms' },
];

/**
 * StandardSwitch — segmented control in the sidebar (pain #7).
 * Per ims-experience/view-designs.md §2.2.
 * Accessible: role="radiogroup" with radio per option, arrow-key navigation.
 */
export function StandardSwitch() {
  const t = useTranslations('shell');
  const { standard, setStandard } = useStandardScope();

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIdx = (idx + 1) % OPTIONS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIdx = (idx - 1 + OPTIONS.length) % OPTIONS.length;
    }
    if (nextIdx !== idx) {
      setStandard(OPTIONS[nextIdx].value);
      // Focus the new option
      const container = e.currentTarget.parentElement;
      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      buttons?.[nextIdx]?.focus();
    }
  };

  return (
    <div className={styles.container} role="radiogroup" aria-label={t('standardScopeLabel')}>
      {OPTIONS.map((opt, idx) => {
        const isActive = standard === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.option} ${isActive ? styles.active : ''}`}
            onClick={() => setStandard(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {t(opt.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
