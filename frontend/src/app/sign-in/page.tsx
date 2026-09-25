'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth, type SignInOutcome } from '@/lib/auth-context';
import { PrimaryButton, SecondaryButton } from '@/components/shared';
import Image from 'next/image';
import styles from './page.module.css';

/**
 * Sign-in page — §3: minimal dark card (logo, email, password, PrimaryButton)
 * at /sign-in. Pool B SRP-only (CON-2). Pool A is NEVER offered (BC-6/ACC-8).
 * m4 fix: maps auth failures to localized shell.signInError; uses PrimaryButton.
 * FE-2: Cognito nextStep drives the step machine — NEW_PASSWORD_REQUIRED and
 * MFA challenges get localized forms; unhandled steps surface an honest error.
 */

type Step =
  | { name: 'credentials' }
  | { name: 'newPassword' }
  | { name: 'mfaSelect' }
  | { name: 'mfaCode'; challenge: 'totp' | 'sms' | 'email' | 'custom' }
  | { name: 'unsupported' };

export default function SignInPage() {
  const t = useTranslations('shell');
  const { signIn, confirmSignInChallenge, isLoading } = useAuth();
  const [step, setStep] = useState<Step>({ name: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function applyOutcome(outcome: SignInOutcome) {
    if (outcome.status === 'signedIn') return; // context navigates to /dashboard
    if (outcome.status === 'newPasswordRequired') setStep({ name: 'newPassword' });
    else if (outcome.status === 'mfaSelectionRequired') setStep({ name: 'mfaSelect' });
    else if (outcome.status === 'mfaCodeRequired')
      setStep({ name: 'mfaCode', challenge: outcome.challenge });
    else setStep({ name: 'unsupported' });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      applyOutcome(await signIn(email, password));
    } catch {
      // m4: always show localized error, never raw Amplify error text
      setError(t('signInError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError(t('passwordsDontMatch'));
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      applyOutcome(await confirmSignInChallenge(newPassword));
    } catch {
      setError(t('challengeError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      applyOutcome(await confirmSignInChallenge(code));
    } catch {
      setError(t('challengeError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSelect(method: 'TOTP' | 'SMS_MFA' | 'EMAIL_MFA') {
    setError('');
    setSubmitting(true);
    try {
      applyOutcome(await confirmSignInChallenge(method));
    } catch {
      setError(t('challengeError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) return null;

  const logo = (
    <Image
      src="/brand/cumplify-logo.png"
      alt="Cumplify"
      width={140}
      height={50}
      priority
      className={styles.logo}
    />
  );

  const errorEl = error ? (
    <p className={styles.error} role="alert">
      {error}
    </p>
  ) : null;

  if (step.name === 'newPassword') {
    return (
      <div className={styles.page}>
        <form className={styles.card} onSubmit={handleNewPassword}>
          {logo}
          <p className={styles.hint}>{t('newPasswordHint')}</p>
          <label htmlFor="newPassword" className={styles.label}>
            {t('newPassword')}
          </label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={styles.input}
            required
            autoComplete="new-password"
          />
          <label htmlFor="confirmPassword" className={styles.label}>
            {t('confirmPassword')}
          </label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={styles.input}
            required
            autoComplete="new-password"
          />
          {errorEl}
          <PrimaryButton type="submit" disabled={submitting} className={styles.submitBtn}>
            {submitting ? t('verifying') : t('continue')}
          </PrimaryButton>
        </form>
      </div>
    );
  }

  if (step.name === 'mfaSelect') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          {logo}
          <p className={styles.hint}>{t('mfaSelectHint')}</p>
          {errorEl}
          <PrimaryButton
            type="button"
            disabled={submitting}
            className={styles.submitBtn}
            onClick={() => handleMfaSelect('TOTP')}
          >
            {t('mfaMethodTotp')}
          </PrimaryButton>
          <SecondaryButton
            type="button"
            disabled={submitting}
            className={styles.submitBtn}
            onClick={() => handleMfaSelect('SMS_MFA')}
          >
            {t('mfaMethodSms')}
          </SecondaryButton>
        </div>
      </div>
    );
  }

  if (step.name === 'mfaCode') {
    return (
      <div className={styles.page}>
        <form className={styles.card} onSubmit={handleMfaCode}>
          {logo}
          <p className={styles.hint}>
            {t(
              step.challenge === 'totp'
                ? 'mfaHintTotp'
                : step.challenge === 'sms'
                  ? 'mfaHintSms'
                  : 'mfaHintCustom',
            )}
          </p>
          <label htmlFor="mfaCode" className={styles.label}>
            {t('mfaCode')}
          </label>
          <input
            id="mfaCode"
            type="text"
            inputMode={step.challenge === 'custom' ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={styles.input}
            required
          />
          {errorEl}
          <PrimaryButton type="submit" disabled={submitting} className={styles.submitBtn}>
            {submitting ? t('verifying') : t('continue')}
          </PrimaryButton>
        </form>
      </div>
    );
  }

  if (step.name === 'unsupported') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          {logo}
          <p className={styles.error} role="alert">
            {t('unsupportedStep')}
          </p>
          <SecondaryButton
            type="button"
            className={styles.submitBtn}
            onClick={() => setStep({ name: 'credentials' })}
          >
            {t('backToSignIn')}
          </SecondaryButton>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        {logo}
        <label htmlFor="email" className={styles.label}>
          {t('email')}
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={styles.input}
          required
          autoComplete="email"
        />
        <label htmlFor="password" className={styles.label}>
          {t('password')}
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={styles.input}
          required
          autoComplete="current-password"
        />
        {errorEl}
        <PrimaryButton type="submit" disabled={submitting} className={styles.submitBtn}>
          {submitting ? t('signingIn') : t('signIn')}
        </PrimaryButton>
      </form>
    </div>
  );
}
