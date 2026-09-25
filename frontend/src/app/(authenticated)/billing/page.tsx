'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PageHeader, Panel, EmptyState } from '@/components/shared';
import { useAuth } from '@/lib/auth-context';
import { useGraphQL } from '@/lib/api';
import { canSeeAdmin, normalizeRole } from '@/lib/role-matrix';
import btnStyles from '@/components/shared/Buttons.module.css';
import styles from './page.module.css';

/**
 * /billing — subscription & payments (owner directive 2026-07-22).
 * Route-guarded: canSeeAdmin(role) (CON-6, presentation-only; server enforces).
 *
 * "Open billing portal" mints a one-time Stripe Customer Portal session via the
 * createBillingPortalSession mutation — the server reads the Stripe secret and
 * the tenant's customer id, so neither ever reaches the browser — then
 * redirects. If the environment has no Stripe secret the mutation throws
 * STRIPE_NOT_CONFIGURED and we surface the not-configured note (never a dead
 * control). AI credit overage is served and billed, never hard-blocked (owner
 * ruling 2026-07-08) — the usage note reflects that.
 */

const CREATE_BILLING_PORTAL_SESSION = /* GraphQL */ `
  mutation CreateBillingPortalSession($returnUrl: String!) {
    createBillingPortalSession(returnUrl: $returnUrl) {
      url
    }
  }
`;

export default function BillingPage() {
  const t = useTranslations('billing');
  const tCommon = useTranslations('common');
  const { user } = useAuth();
  const { mutate } = useGraphQL();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = user?.role ?? 'employee';
  const isAdmin = canSeeAdmin(normalizeRole(role));

  async function handleOpenPortal() {
    setLoading(true);
    setError(null);
    try {
      const data = await mutate<{ createBillingPortalSession: { url: string } }>(
        CREATE_BILLING_PORTAL_SESSION,
        { returnUrl: window.location.href },
      );
      window.location.assign(data.createBillingPortalSession.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(msg.includes('STRIPE_NOT_CONFIGURED') ? t('portalNotConfigured') : t('portalError'));
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader title={t('title')} />

      {!isAdmin ? (
        // Explicit not-authorized state — never a blank page
        <Panel title={t('subscriptionTitle')}>
          <EmptyState message={tCommon('notAuthorized')} />
        </Panel>
      ) : (
        <div className={styles.panels}>
          <Panel title={t('subscriptionTitle')}>
            <p className={styles.description}>{t('subscriptionDescription')}</p>
            <button
              type="button"
              className={`${btnStyles.primary} ${styles.portalLink}`}
              onClick={handleOpenPortal}
              disabled={loading}
            >
              {loading ? t('openingPortal') : t('openPortal')}
            </button>
            {error && <p className={styles.notConfigured}>{error}</p>}
          </Panel>

          <Panel title={t('usageTitle')}>
            <p className={styles.description}>{t('usageDescription')}</p>
          </Panel>
        </div>
      )}
    </>
  );
}
