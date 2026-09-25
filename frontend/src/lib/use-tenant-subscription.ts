'use client';

import { useEffect, useRef, useCallback } from 'react';
import { generateClient } from 'aws-amplify/api';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useAuth } from './auth-context';

/**
 * useTenantSubscription — view-designs.md §2 shared hook.
 * Wraps an AppSync subscription with:
 * (a) tenantId arg from the ID-token claim (CON-5: no tenantId in inputs)
 * (b) reconnect w/ backoff on error
 * (c) cleanup on unmount via .unsubscribe()
 *
 * B1 fix: Amplify v6 client.graphql() for subscriptions returns an rxjs
 * Observable, NOT an AsyncIterable. Uses .subscribe({next, error}).
 * B3 fix: fetches a fresh token on every (re)subscribe via fetchAuthSession().
 *
 * All real-time bindings (§3, §5–§9) go through this hook.
 */

// Lazy client — generateClient() at module scope runs during prerender/import
// before Amplify is configured; create it on first subscribe instead.
let client: ReturnType<typeof generateClient> | null = null;
function getClient() {
  client ??= generateClient();
  return client;
}

const MAX_RETRIES = 5;
const BASE_DELAY = 1000;

interface SubscriptionOptions<T> {
  /** The subscription GraphQL statement */
  query: string;
  /** Callback for each event */
  onData: (data: T) => void;
  /** Optional callback on error (after max retries) */
  onError?: (error: unknown) => void;
  /** Whether the subscription is active (default: true) */
  enabled?: boolean;
}

/** Minimal Observable shape from Amplify v6 subscription returns */
interface AmplifySubscription {
  subscribe(observer: {
    next?: (value: { data: unknown }) => void;
    error?: (err: unknown) => void;
    complete?: () => void;
  }): { unsubscribe: () => void };
}

export function useTenantSubscription<T = unknown>({
  query,
  onData,
  onError,
  enabled = true,
}: SubscriptionOptions<T>) {
  const { user } = useAuth();
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subRef = useRef<{ unsubscribe: () => void } | null>(null);
  const cancelledRef = useRef(false);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onErrorRef.current = onError;

  const subscribe = useCallback(async () => {
    if (!user?.tenantId) return;
    if (cancelledRef.current) return;

    // B3: fetch fresh token on every (re)subscribe
    let token: string | undefined;
    try {
      const session = await fetchAuthSession();
      token = session.tokens?.idToken?.toString();
    } catch {
      // Token refresh failed — cannot subscribe
      onErrorRef.current?.(new Error('Token refresh failed'));
      return;
    }

    if (!token || cancelledRef.current) return;

    const observable = getClient().graphql({
      query,
      variables: { tenantId: user.tenantId },
      authToken: token,
    }) as unknown as AmplifySubscription;

    const subscription = observable.subscribe({
      next: (value) => {
        if (cancelledRef.current) return;
        // Reset retry count on successful message receipt
        retryCount.current = 0;
        if (value.data) {
          onDataRef.current(value.data as T);
        }
      },
      error: (err) => {
        if (cancelledRef.current) return;
        // Drop the dead subscription before resubscribing — subRef must only
        // ever hold a live handle (cleanup else unsubscribes a corpse while
        // the new socket is unmanaged).
        if (subRef.current) {
          subRef.current.unsubscribe();
          subRef.current = null;
        }
        retryCount.current += 1;
        if (retryCount.current <= MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, retryCount.current - 1);
          retryTimer.current = setTimeout(() => {
            if (!cancelledRef.current) {
              subscribe();
            }
          }, delay);
        } else {
          onErrorRef.current?.(err);
        }
      },
    });

    subRef.current = subscription;
  }, [query, user?.tenantId]);

  useEffect(() => {
    if (!enabled) return;

    cancelledRef.current = false;
    retryCount.current = 0;
    subscribe();

    return () => {
      cancelledRef.current = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (subRef.current) {
        subRef.current.unsubscribe();
        subRef.current = null;
      }
    };
  }, [subscribe, enabled]);
}
