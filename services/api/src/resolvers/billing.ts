/**
 * Billing resolver — Stripe Customer Portal integration.
 *
 * createBillingPortalSession: mints a one-time Stripe Billing Portal URL for the
 * caller's tenant. The /billing page's "Manage subscription" button calls this
 * and redirects, so admins manage their subscription, invoices, and payment
 * method in Stripe's hosted portal (no PCI surface in our app).
 *
 * PLACEMENT: NOT VPC-placed (like the m1–m5 resolvers) — the zero-NAT VPC has no
 * egress to api.stripe.com, so this Lambda runs outside the VPC and reaches
 * Stripe over the default managed egress. rds-data / Secrets Manager are public
 * AWS endpoints, so nothing here needs the VPC.
 *
 * SECRET (cumplify/<env>/stripe) carries the Stripe secret key, the portal
 * configuration id, and the tenant→customer map (seeded out-of-band). A future
 * spec moves the tenant→customer mapping onto the tenant record and adds the
 * Checkout subscribe flow + webhook sync → entitlements.
 *
 * SCHEMA-5: tenantId comes ONLY from resolverContext (extractContext), never
 * from input args. returnUrl is client-supplied post-portal navigation and is
 * validated to an http(s) URL.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';
import { extractContext } from './shared.js';

const logger = new Logger({ serviceName: 'resolver-billing' });
const sm = new SecretsManagerClient({});

interface StripeSecret {
  secretKey: string;
  portalConfigurationId?: string;
  customersByTenant?: Record<string, string>;
}

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { resolverContext?: Record<string, string> };
}

/**
 * Read + parse the Stripe secret on each call. STRIPE_SECRET_NAME is read at
 * CALL time (not module scope) so the hermetic lane can set it before import
 * and never hit AWS. Portal opens are an infrequent admin action — no cache.
 */
async function loadStripe(): Promise<{ secret: StripeSecret; stripe: Stripe }> {
  const secretName = process.env.STRIPE_SECRET_NAME;
  if (!secretName) throw new Error('STRIPE_NOT_CONFIGURED: STRIPE_SECRET_NAME unset');
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!resp.SecretString) throw new Error('STRIPE_NOT_CONFIGURED: empty secret');
  const secret = JSON.parse(resp.SecretString) as StripeSecret;
  if (!secret.secretKey) throw new Error('STRIPE_NOT_CONFIGURED: secretKey missing');
  return { secret, stripe: new Stripe(secret.secretKey) };
}

export async function handler(event: AppSyncEvent): Promise<unknown> {
  const { tenantId, poolClass } = extractContext(event);
  logger.appendKeys({ tenantId, requestField: event.info.fieldName });

  switch (event.info.fieldName) {
    case 'createBillingPortalSession':
      return createBillingPortalSession(event, tenantId, poolClass);
    default:
      throw new Error(`Unknown field: ${event.info.fieldName}`);
  }
}

async function createBillingPortalSession(
  event: AppSyncEvent,
  tenantId: string,
  poolClass: string,
): Promise<{ url: string }> {
  // Billing is an admin surface — Pool B (tenant-admin) only.
  if (poolClass !== 'tenant-admin') {
    throw new Error('FORBIDDEN: billing portal requires tenant-admin');
  }

  const returnUrl = event.arguments.returnUrl as string | undefined;
  // URL-parse, not prefix-match: `https://localhost:9999@evil.example/x`
  // passes a `localhost[:/]` regex while Stripe 302s to evil.example.
  const isValidReturn = (() => {
    if (!returnUrl) return false;
    try {
      const u = new URL(returnUrl);
      return u.protocol === 'https:' || u.hostname === 'localhost';
    } catch {
      return false;
    }
  })();
  if (!isValidReturn) {
    throw new Error('INVALID_RETURN_URL');
  }

  const { secret, stripe } = await loadStripe();

  // One Stripe customer per tenant. Seeded tenants resolve from the map;
  // otherwise stamp a bare customer with the tenantId (production: persist the
  // id on the tenant record so repeat calls for a new tenant never re-create).
  let customerId = secret.customersByTenant?.[tenantId];
  if (!customerId) {
    const customer = await stripe.customers.create({ metadata: { tenantId } });
    customerId = customer.id;
    logger.info('Created Stripe customer for tenant', { customerId });
    // Persist back into the secret's tenant→customer map so repeat calls
    // reuse this customer instead of minting a duplicate every time.
    await persistCustomerMapping(tenantId, customerId);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
    ...(secret.portalConfigurationId ? { configuration: secret.portalConfigurationId } : {}),
  });

  logger.info('Created billing portal session', { customerId });
  return { url: session.url };
}

/**
 * Read-modify-write the Stripe secret to record tenantId→customerId.
 * The secret already owns the seeded map — this extends it for tenants
 * created after seeding. Concurrent writers could interleave; the window
 * is two admins of the SAME tenant opening the portal at once, and the
 * worst case is one duplicate customer that the map resolves on retry.
 */
async function persistCustomerMapping(tenantId: string, customerId: string): Promise<void> {
  const secretName = process.env.STRIPE_SECRET_NAME!;
  try {
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
    const current = JSON.parse(resp.SecretString ?? '{}') as StripeSecret;
    current.customersByTenant = { ...current.customersByTenant, [tenantId]: customerId };
    await sm.send(
      new PutSecretValueCommand({ SecretId: secretName, SecretString: JSON.stringify(current) }),
    );
  } catch (err) {
    // The customer exists and the portal session still works — a missed
    // persist just means the next call may create one more customer.
    logger.warn('Failed to persist Stripe customer mapping', {
      tenantId,
      error: (err as Error).message,
    });
  }
}
