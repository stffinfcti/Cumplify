'use client';

import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  signIn as amplifySignIn,
  confirmSignIn as amplifyConfirmSignIn,
  signOut as amplifySignOut,
  getCurrentUser,
  fetchAuthSession,
} from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';
import type { AuthUser, AuthState, SignInOutcome } from './auth-types';
import { reset as resetAskStore } from './ask-store';

export type { AuthUser, AuthState, SignInOutcome } from './auth-types';

const AuthContext = createContext<AuthState | undefined>(undefined);

/**
 * Parse claims from the Cognito ID token JWT payload.
 * PreTokenGeneration stamps tenantId + role into the ID token only.
 */
function parseUserFromToken(payload: Record<string, unknown>): AuthUser {
  return {
    sub: (payload.sub as string) ?? '',
    email: (payload.email as string) ?? '',
    tenantId: (payload['custom:tenantId'] as string) ?? '',
    role: (payload['custom:role'] as string) ?? 'Employee',
    locale: (payload['custom:locale'] as string) ?? 'en',
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // Attempt to restore session on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getCurrentUser();
        const session = await fetchAuthSession();
        const jwt = session.tokens?.idToken;
        if (jwt && !cancelled) {
          setIdToken(jwt.toString());
          setUser(parseUserFromToken(jwt.payload as Record<string, unknown>));
        }
      } catch {
        // Not authenticated
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Shared completion: a signed-in result updates context + navigates;
  // anything else maps Cognito's nextStep to the page-level UI state.
  const completeSignIn = useCallback(
    async (output: { isSignedIn: boolean; nextStep: { signInStep: string } }): Promise<SignInOutcome> => {
      if (output.isSignedIn || output.nextStep.signInStep === 'DONE') {
        const session = await fetchAuthSession();
        const jwt = session.tokens?.idToken;
        if (jwt) {
          setIdToken(jwt.toString());
          setUser(parseUserFromToken(jwt.payload as Record<string, unknown>));
        }
        router.push('/dashboard');
        return { status: 'signedIn' };
      }
      const step = output.nextStep.signInStep;
      if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        return { status: 'newPasswordRequired' };
      }
      if (step === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
        return { status: 'mfaCodeRequired', challenge: 'totp' };
      }
      if (step === 'CONFIRM_SIGN_IN_WITH_SMS_CODE') {
        return { status: 'mfaCodeRequired', challenge: 'sms' };
      }
      if (step === 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') {
        return { status: 'mfaCodeRequired', challenge: 'email' };
      }
      if (step === 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE') {
        return { status: 'mfaCodeRequired', challenge: 'custom' };
      }
      if (step === 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION') {
        return { status: 'mfaSelectionRequired' };
      }
      // Setup/first-factor/signup steps are out of scope for this pool —
      // surfaced as an explicit unsupported state, never dropped silently.
      return { status: 'unsupported', step };
    },
    [router],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const output = await amplifySignIn({ username: email, password });
      return completeSignIn(output);
    },
    [completeSignIn],
  );

  const confirmSignInChallenge = useCallback(
    async (challengeResponse: string) => {
      const output = await amplifyConfirmSignIn({ challengeResponse });
      return completeSignIn(output);
    },
    [completeSignIn],
  );

  const signOut = useCallback(async () => {
    await amplifySignOut();
    resetAskStore();
    setUser(null);
    setIdToken(null);
    router.push('/sign-in');
  }, [router]);

  const refreshLocale = useCallback((locale: string) => {
    setUser((prev) => (prev ? { ...prev, locale } : null));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        idToken,
        signIn,
        confirmSignInChallenge,
        signOut,
        refreshLocale,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
