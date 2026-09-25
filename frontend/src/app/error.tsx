'use client';

import { ErrorState } from '@/components/shared';

/**
 * Root segment error boundary — keeps the root layout (locale providers)
 * alive, so the fallback stays localized. A fault in any non-authenticated
 * segment renders the shared ErrorState instead of blanking the app.
 */
export default function Error({ error: _error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState onRetry={reset} />;
}
