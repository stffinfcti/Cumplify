import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ----- Mocks -----

let mockRole = 'QualityManager';
const mockMutate = vi.fn();

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { sub: 'u1', email: 'test@test.com', tenantId: 'T1', role: mockRole, locale: 'en' },
    isAuthenticated: true,
    isLoading: false,
    idToken: 'tok',
    signIn: vi.fn(),
    signOut: vi.fn(),
    refreshLocale: vi.fn(),
  }),
}));

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ mutate: mockMutate, query: vi.fn(), client: {} }),
}));

vi.mock('next-intl', () => {
  const translations: Record<string, Record<string, string>> = {
    billing: {
      title: 'Billing',
      subscriptionTitle: 'Subscription & Payments',
      subscriptionDescription: 'Managed through Stripe.',
      openPortal: 'Open billing portal',
      openingPortal: 'Opening portal…',
      portalError: 'Could not open the billing portal. Please try again.',
      portalNotConfigured: 'The billing portal is not configured.',
      usageTitle: 'AI Usage',
      usageDescription: 'Overage is billed, never blocked.',
    },
  };
  return {
    useTranslations: (ns: string) => {
      const t = (key: string) => translations[ns]?.[key] ?? `${ns}.${key}`;
      t.has = (key: string) => !!translations[ns]?.[key];
      return t;
    },
  };
});

vi.mock('@/components/shared', () => ({
  PageHeader: ({ title }: { title: string }) => <h1 data-testid="page-header">{title}</h1>,
  Panel: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section data-testid={`panel-${title}`} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  EmptyState: ({ message }: { message: string }) => <div data-testid="empty-state">{message}</div>,
}));

// window.location.assign is called on success — spy on it (jsdom navigation).
const mockAssign = vi.fn();

// ----- Tests -----

describe('BillingPage', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockAssign.mockReset();
    Object.defineProperty(window, 'location', {
      value: { href: 'https://app.cumplify.ai/billing', assign: mockAssign },
      writable: true,
    });
  });
  afterEach(() => {
    mockRole = 'QualityManager';
  });

  it('mints a portal session on click and redirects to the returned URL (returnUrl = current page)', async () => {
    mockMutate.mockResolvedValue({
      createBillingPortalSession: { url: 'https://billing.stripe.com/p/session/test_live' },
    });
    const { default: BillingPage } = await import('./page');
    render(<BillingPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open billing portal' }));

    expect(mockMutate).toHaveBeenCalledWith(expect.stringContaining('createBillingPortalSession'), {
      returnUrl: 'https://app.cumplify.ai/billing',
    });
    await waitFor(() =>
      expect(mockAssign).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test_live'),
    );
    expect(screen.getByTestId('panel-Subscription & Payments')).toBeInTheDocument();
    expect(screen.getByTestId('panel-AI Usage')).toBeInTheDocument();
  });

  it('surfaces the not-configured note when the backend has no Stripe secret — never a dead control', async () => {
    mockMutate.mockRejectedValue(new Error('STRIPE_NOT_CONFIGURED: secretKey missing'));
    const { default: BillingPage } = await import('./page');
    render(<BillingPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open billing portal' }));

    await waitFor(() =>
      expect(screen.getByText('The billing portal is not configured.')).toBeInTheDocument(),
    );
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('surfaces a generic error on any other failure', async () => {
    mockMutate.mockRejectedValue(new Error('boom'));
    const { default: BillingPage } = await import('./page');
    render(<BillingPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open billing portal' }));

    await waitFor(() =>
      expect(
        screen.getByText('Could not open the billing portal. Please try again.'),
      ).toBeInTheDocument(),
    );
  });

  it('shows an explicit not-authorized state for non-admin roles, never the portal (CON-6 presentation-only gate)', async () => {
    mockRole = 'Employee';
    const { default: BillingPage } = await import('./page');
    render(<BillingPage />);

    expect(screen.getByTestId('empty-state')).toHaveTextContent('common.notAuthorized');
    expect(screen.queryByRole('button', { name: 'Open billing portal' })).not.toBeInTheDocument();
  });
});
