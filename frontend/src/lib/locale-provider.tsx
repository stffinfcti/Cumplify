'use client';

import { useEffect, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useAuth } from './auth-context';

// Static-import all three catalogs (export-safe — no dynamic import needed)
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import pt from '../../messages/pt.json';

/**
 * LocaleProvider — B2 fix.
 * Mounted INSIDE AuthProvider so it can read user.locale.
 * Selects the correct message catalog and keys NextIntlClientProvider on the
 * locale, causing a full re-render when the locale changes (ACC-5).
 * Static import of all three catalogs is export-safe (CON-3).
 */

type SupportedLocale = 'en' | 'es' | 'pt';

const CATALOGS: Record<SupportedLocale, typeof en> = { en, es, pt };

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const locale = (user?.locale as SupportedLocale) || 'en';
  const messages = CATALOGS[locale] ?? CATALOGS.en;

  // Sync the document lang attribute with the active locale — an effect, not
  // a render side-effect (double-render safe).
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <NextIntlClientProvider key={locale} locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
