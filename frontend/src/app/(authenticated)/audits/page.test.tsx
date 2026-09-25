import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AuditStudioPage from './page';

const mockQuery = vi.fn();
const mockMutate = vi.fn();

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ query: mockQuery, mutate: mockMutate }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
}));

vi.mock('@/components/studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/studio')>();
  return {
    ...actual,
    AgentRunButton: ({
      label,
      mutation,
      variables,
      agentName,
    }: {
      label: string;
      mutation: string;
      variables?: Record<string, unknown>;
      agentName: string;
    }) => (
      <button
        data-testid="arb-propose-finding"
        data-mutation={mutation}
        data-variables={JSON.stringify(variables ?? {})}
        data-agent={agentName}
      >
        {label}
      </button>
    ),
  };
});

const AUDIT = {
  id: 'audit-1',
  programmeId: 'prog-1',
  standard: 'ISO9001',
  scope: 'Fabrication shop processes',
  leadAuditorId: 'aud-1',
  plannedDate: '2026-08-01T00:00:00Z',
  actualDate: null,
  status: 'planned',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (q: string) => {
    if (q.includes('ListAudits')) return { listAudits: [AUDIT] };
    if (q.includes('ListAuditFindings')) return { listAuditFindings: [] };
    if (q.includes('ListAuditChecklists')) return { listAuditChecklists: [] };
    throw new Error(`unmocked: ${q.slice(0, 40)}`);
  });
});

describe('Audit Studio (S4)', () => {
  it('audit row expands to the findings section where the big button IS LeadAuditor', async () => {
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByTestId('audit-row-audit-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('audit-row-audit-1'));
    await waitFor(() => expect(screen.getByTestId('arb-propose-finding')).toBeInTheDocument());

    const btn = screen.getByTestId('arb-propose-finding');
    expect(btn).toHaveAttribute('data-agent', 'LeadAuditor');
    expect(btn.getAttribute('data-mutation')).toContain('runAuditFindings');
    expect(JSON.parse(btn.getAttribute('data-variables')!)).toEqual({ auditId: 'audit-1' });
    expect(screen.getByText('auditStudio.generateChecklist')).toBeInTheDocument();
  });

  it('expanded detail shows "Complete audit" action when status is not completed (B1.1)', async () => {
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByTestId('audit-row-audit-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('audit-row-audit-1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'auditStudio.completeAudit' })).toBeInTheDocument(),
    );
  });

  it('expanded detail does NOT show "Complete audit" when status is completed (B1.1)', async () => {
    mockQuery.mockImplementation(async (q: string) => {
      if (q.includes('ListAudits')) return { listAudits: [{ ...AUDIT, status: 'completed' }] };
      if (q.includes('ListAuditFindings')) return { listAuditFindings: [] };
      if (q.includes('ListAuditChecklists')) return { listAuditChecklists: [] };
      throw new Error(`unmocked: ${q.slice(0, 40)}`);
    });
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByTestId('audit-row-audit-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('audit-row-audit-1'));
    await waitFor(() => expect(screen.getByTestId('arb-propose-finding')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'auditStudio.completeAudit' }),
    ).not.toBeInTheDocument();
  });

  it('expanded detail shows "View readiness scores" action (B1.2)', async () => {
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByTestId('audit-row-audit-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('audit-row-audit-1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'auditStudio.viewReadiness' })).toBeInTheDocument(),
    );
  });

  it('readiness button renders error message on failure (amendment 1)', async () => {
    mockQuery.mockImplementation(async (q: string) => {
      if (q.includes('ListAudits')) return { listAudits: [AUDIT] };
      if (q.includes('ListAuditFindings')) return { listAuditFindings: [] };
      if (q.includes('ListAuditChecklists')) return { listAuditChecklists: [] };
      if (q.includes('GetAuditReadiness')) throw new Error('Network timeout');
      throw new Error(`unmocked: ${q.slice(0, 40)}`);
    });
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByTestId('audit-row-audit-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('audit-row-audit-1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'auditStudio.viewReadiness' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'auditStudio.viewReadiness' }));
    // Non-code messages route to the localized generic — no English internals
    await waitFor(() => expect(screen.getByText('errors.generic')).toBeInTheDocument());
  });

  it('readiness button renders explicit empty state when scores are empty (amendment 1)', async () => {
    mockQuery.mockImplementation(async (q: string) => {
      if (q.includes('ListAudits')) return { listAudits: [AUDIT] };
      if (q.includes('ListAuditFindings')) return { listAuditFindings: [] };
      if (q.includes('ListAuditChecklists')) return { listAuditChecklists: [] };
      if (q.includes('GetAuditReadiness')) return { getAuditReadiness: [] };
      throw new Error(`unmocked: ${q.slice(0, 40)}`);
    });
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByTestId('audit-row-audit-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('audit-row-audit-1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'auditStudio.viewReadiness' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'auditStudio.viewReadiness' }));
    await waitFor(() => expect(screen.getByText('auditStudio.readinessEmpty')).toBeInTheDocument());
  });

  it('zero audits renders the empty state with a planning action (deploy 8a2e9a17 regression)', async () => {
    mockQuery.mockImplementation(async (q: string) => {
      if (q.includes('ListAudits')) return { listAudits: [] };
      throw new Error(`unmocked: ${q.slice(0, 40)}`);
    });
    render(<AuditStudioPage />);
    await waitFor(() => expect(screen.getByText('auditStudio.empty')).toBeInTheDocument());
    // Two planning buttons: the rail's and the empty state's action
    expect(screen.getAllByRole('button', { name: 'auditStudio.goToPlanning' })).toHaveLength(2);
  });
});
