'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/shared';

/**
 * Segment error boundary — a fault here renders the localized ErrorState
 * inside the authenticated layout (shell + nav stay mounted).
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
