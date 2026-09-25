'use client';

import { Component, type ReactNode } from 'react';
import { ErrorState } from './ErrorState';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback — defaults to the shared localized ErrorState. */
  fallback?: ReactNode;
  onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * ErrorBoundary — a render fault shows the localized ErrorState with retry
 * instead of blanking the app. error.tsx route files cover page segments;
 * mount this inside layouts for non-route pieces (nav, rails, providers).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <ErrorState onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
