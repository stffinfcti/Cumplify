import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SettingsPage from './page';

// ----- Mocks -----

const mockQuery = vi.fn();

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ query: mockQuery, mutate: vi.fn() }),
}));

let mockRole = 'QualityManager';

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

// Mock next-intl
vi.mock('next-intl', () => {
  const translations: Record<string, Record<string, string>> = {
    settings: {
      title: 'Settings',
      organizationTitle: 'Organization',
      tenantName: 'Organization Name',
      tenantLocale: 'Document Locale',
      tenantLocaleReadOnly: 'The document locale is set at the organization level.',
      myProfileTitle: 'My Profile',
      loading: 'Loading...',
    },
    profile: {
      locale: 'Display Language',
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
  ErrorState: ({ onRetry }: { onRetry: () => void }) => (
    <div data-testid="error-state">
      <button onClick={onRetry}>retry-action</button>
    </div>
  ),
  EmptyState: ({ message }: { message: string }) => <div data-testid="empty-state">{message}</div>,
}));

vi.mock('@/components/shell/LocaleSwitcher', () => ({
  LocaleSwitcher: () => <div data-testid="locale-switcher">LocaleSwitcher</div>,
}));

// ----- Fixtures -----

const tenantSettings = {
  getTenantSettings: {
    tenantName: 'Acme Corp',
    documentLocale: 'es',
  },
};

// ----- Tests -----

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'QualityManager';
    mockQuery.mockResolvedValue(tenantSettings);
  });

  describe('fetch success renders both panels', () => {
    it('renders Organization panel with tenant name and document locale', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('panel-Organization')).toBeInTheDocument();
      });

      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('ES')).toBeInTheDocument();
      expect(
        screen.getByText('The document locale is set at the organization level.'),
      ).toBeInTheDocument();
    });

    it('renders My Profile panel with LocaleSwitcher', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('panel-My Profile')).toBeInTheDocument();
      });

      expect(screen.getByTestId('locale-switcher')).toBeInTheDocument();
    });

    it('renders the page header with Settings title', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('page-header')).toBeInTheDocument();
      });

      expect(screen.getByTestId('page-header')).toHaveTextContent('Settings');
    });
  });

  describe('fetch failure renders ErrorState', () => {
    it('shows ErrorState with retry when query fails', async () => {
      mockQuery.mockRejectedValue(new Error('Network error'));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('panel-Organization')).not.toBeInTheDocument();
    });

    it('retries fetch on retry button click', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Network error'));
      mockQuery.mockResolvedValueOnce(tenantSettings);

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('retry-action'));

      await waitFor(() => {
        expect(screen.getByTestId('panel-Organization')).toBeInTheDocument();
      });

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('route guard: non-admin role never sees org settings', () => {
    it('shows not-authorized for employee role, keeps My Profile', async () => {
      mockRole = 'Employee';

      render(<SettingsPage />);

      // Org panel renders an explicit not-authorized state — the page header
      // and per-user My Profile panel remain (never a blank page).
      const orgPanel = screen.getByTestId('panel-Organization');
      expect(orgPanel).toContainElement(screen.getByTestId('empty-state'));
      expect(screen.getByTestId('empty-state')).toHaveTextContent('common.notAuthorized');
      expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
      expect(screen.getByTestId('panel-My Profile')).toBeInTheDocument();
    });

    it('shows not-authorized for contractor role', async () => {
      mockRole = 'contractor';

      render(<SettingsPage />);

      expect(screen.getByTestId('empty-state')).toHaveTextContent('common.notAuthorized');
    });

    it('renders content for management-rep role', async () => {
      mockRole = 'IMSLead';

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('panel-Organization')).toBeInTheDocument();
      });
    });
  });
});
