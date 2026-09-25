/**
 * Auth context types — extracted to .ts to avoid false-positive in the
 * hardcoded-strings checker (Promise<void> pattern triggers the JSX regex).
 */

export interface AuthUser {
  sub: string;
  email: string;
  tenantId: string;
  role: string;
  locale: string;
}

/**
 * What signIn/confirmSignInChallenge resolved to — the page renders one UI
 * state per outcome. FE-2: Cognito nextStep is never dropped silently.
 */
export type SignInOutcome =
  | { status: 'signedIn' }
  | { status: 'newPasswordRequired' }
  | { status: 'mfaSelectionRequired' }
  | { status: 'mfaCodeRequired'; challenge: 'totp' | 'sms' | 'email' | 'custom' }
  | { status: 'unsupported'; step: string };

export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  idToken: string | null;
  signIn: (email: string, password: string) => Promise<SignInOutcome>;
  /** Answer the current challenge: new password, MFA code, or MFA method pick ('TOTP' | 'SMS_MFA' | 'EMAIL_MFA'). */
  confirmSignInChallenge: (challengeResponse: string) => Promise<SignInOutcome>;
  signOut: () => Promise<void>;
  refreshLocale: (locale: string) => void;
}
