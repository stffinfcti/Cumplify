'use client';

import { ErrorState } from '@/components/shared';

/**
 * Segment error boundary — a fault here renders the localized ErrorState
 * inside the authenticated layout (shell + nav stay mounted).
 */
export default function Error({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState onRetry={reset} />;
}
