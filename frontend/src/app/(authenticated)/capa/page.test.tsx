import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CapaStudioPage from './page';

// ----- Mocks -----

const mockQuery = vi.fn();
const mockMutate = vi.fn();

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ query: mockQuery, mutate: mockMutate }),
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { sub: 'u1', email: 't@t.com', tenantId: 'T1', role: 'QualityManager', locale: 'en' },
    isAuthenticated: true,
    isLoading: false,
    idToken: 'tok',
    signIn: vi.fn(),
    signOut: vi.fn(),
    refreshLocale: vi.fn(),
  }),
}));

vi.mock('@/lib/use-tenant-subscription', () => ({
  useTenantSubscription: () => undefined,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
}));

// AgentRunButton mocked to expose its dispatch contract
vi.mock('@/components/studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/studio')>();
  return {
    ...actual,
    AgentRunButton: ({
      label,
      mutation,
      variables,
      agentName,
      disabled,
    }: {
      label: string;
      mutation: string;
      variables?: Record<string, unknown>;
      agentName: string;
      disabled?: boolean;
    }) => (
      <button
        data-testid={`arb-${label}`}
        data-mutation={mutation}
        data-variables={JSON.stringify(variables ?? {})}
        data-agent={agentName}
        disabled={disabled}
      >
        {label}
      </button>
    ),
  };
});

vi.mock('./_detail/NCDetail', () => ({
  NCDetail: ({ id }: { id: string }) => <div data-testid={`nc-detail-${id}`} />,
}));

// ----- Fixtures -----

const NC = {
  id: 'nc-1',
  standard: 'ISO9001',
  source: 'process',
  ncType: 'nc',
  description: 'Wrong finish on lot 42',
  clauseRef: '8.7',
  severity: 'HIGH',
  status: 'OPEN',
  raisedBy: 'u1',
  raisedAt: '2026-07-22T10:00:00Z',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (q: string) => {
    if (q.includes('ListNCs')) return { listNonconformities: [NC] };
    if (q.includes('OpenCAPAs')) return { listOpenCAPAs: [] };
    if (q.includes('AuditTrail')) {
      return {
        getAuditTrail: [
          {
            eventId: 'e1',
            eventType: 'NC.Raised',
            actor: 'agent:CAPAGuru+human:u1',
            timestamp: '2026-07-22T10:00:00Z',
          },
        ],
      };
    }
    throw new Error(`unmocked: ${q.slice(0, 40)}`);
  });
});

// ----- Tests -----

describe('CAPA Studio (S1)', () => {
  it('the front door IS the agent: intake textarea wires runNcIntake through AgentRunButton; manual raise is the demoted secondary', async () => {
    render(<CapaStudioPage />);
    await waitFor(() => expect(screen.getByText('Wrong finish on lot 42')).toBeInTheDocument());

    const intakeBtn = screen.getByTestId('arb-capaStudio.draftWithAgent');
    expect(intakeBtn).toHaveAttribute('data-agent', 'CAPAGuru');
    expect(intakeBtn.getAttribute('data-mutation')).toContain('runNcIntake');
    // Empty report → disabled (never dispatch an empty intake)
    expect(intakeBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('capaStudio.reportPlaceholder'), {
      target: { value: 'Paint booth filter overdue' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('arb-capaStudio.draftWithAgent')).not.toBeDisabled(),
    );
    expect(
      JSON.parse(
        screen.getByTestId('arb-capaStudio.draftWithAgent').getAttribute('data-variables')!,
      ),
    ).toEqual({ description: 'Paint booth filter overdue' });

    // Manual path demoted to a secondary action, still available
    expect(screen.getByText('capaStudio.raiseManually')).toBeInTheDocument();
  });

  it('selecting an NC mounts the detail workspace + stage-aware analyze button + audit trail in the rail', async () => {
    render(<CapaStudioPage />);
    await waitFor(() => expect(screen.getByText('Wrong finish on lot 42')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Wrong finish on lot 42'));

    await waitFor(() => expect(screen.getByTestId('nc-detail-nc-1')).toBeInTheDocument());
    const analyzeBtn = screen.getByTestId('arb-capaStudio.analyzeNextStep');
    expect(analyzeBtn.getAttribute('data-mutation')).toContain('runCapaAnalysis');
    expect(JSON.parse(analyzeBtn.getAttribute('data-variables')!)).toEqual({ ncId: 'nc-1' });

    // Audit trail rendered beside the work — dual attribution visible
    await waitFor(() => expect(screen.getByText('NC.Raised')).toBeInTheDocument());
    expect(screen.getByText(/agent:CAPAGuru\+human:u1/)).toBeInTheDocument();
  });
});
