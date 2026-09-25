'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { EmptyState } from '@/components/shared';

/**
 * Root 404 — renders inside the root layout so locale providers are alive
 * and the copy stays localized (FE-1).
 */
export default function NotFound() {
  const t = useTranslations('common');
  return (
    <EmptyState
      message={t('notFound')}
      action={<Link href="/dashboard">{t('backToDashboard')}</Link>}
    />
  );
}
