'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/shared';

/**
 * Root segment error boundary — keeps the root layout (locale providers)
 * alive, so the fallback stays localized. A fault in any non-authenticated
 * segment renders the shared ErrorState instead of blanking the app.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Boundaries must never swallow silently — the digest is the datadog join key.
  useEffect(() => {
    console.error('Route error boundary caught', error);
  }, [error]);
  return <ErrorState onRetry={reset} />;
}
