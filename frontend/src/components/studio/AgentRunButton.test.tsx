import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentRunButton } from './AgentRunButton';

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

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, params?: Record<string, string>) =>
      params ? `${ns}.${key}:${Object.values(params).join(',')}` : `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
}));

vi.mock('./HitlCard', () => ({
  HitlCard: ({ item }: { item: { hitlItemId: string } }) => (
    <div data-testid={`mock-card-${item.hitlItemId}`} />
  ),
}));

const RUN_MUTATION = `mutation($ncId: ID!) { runCapaAnalysis(ncId: $ncId) { runId status } }`;

function pendingResponse(ids: string[]) {
  return {
    listPendingHitlItems: {
      items: ids.map((id) => ({
        hitlItemId: id,
        agentName: id.startsWith('capa') ? 'CAPAGuru' : 'RiskSentinel',
        clauseRef: null,
        standard: null,
        module: 'M2',
        draftBody: '{}',
        status: 'PENDING',
        createdAt: '2026-07-22T15:00:00Z',
        guardrailEvidence: null,
      })),
      nextToken: null,
    },
  };
}

// ----- Tests -----

describe('AgentRunButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQuery.mockReset();
    mockMutate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatch → poll → renders the NEW card from the right agent, ignoring baseline + other agents', async () => {
    // Baseline snapshot: one pre-existing CAPAGuru item
    mockQuery.mockResolvedValueOnce(pendingResponse(['capa-old']));
    mockMutate.mockResolvedValueOnce({ runCapaAnalysis: { runId: 'r1', status: 'DISPATCHED' } });
    // Poll 1: baseline + a RiskSentinel item (wrong agent) — must keep waiting
    mockQuery.mockResolvedValueOnce(pendingResponse(['capa-old', 'risk-new']));
    // Poll 2: the real new CAPAGuru item arrives
    mockQuery.mockResolvedValueOnce(pendingResponse(['capa-old', 'risk-new', 'capa-new']));

    render(
      <AgentRunButton
        label="Analyze with CAPAGuru"
        mutation={RUN_MUTATION}
        variables={{ ncId: 'nc-1' }}
        agentName="CAPAGuru"
      />,
    );

    fireEvent.click(screen.getByText('Analyze with CAPAGuru'));
    // Let dispatch (baseline fetch + mutation) settle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockMutate).toHaveBeenCalledWith(RUN_MUTATION, { ncId: 'nc-1' });
    expect(screen.getByText('studio.agentWorking:CAPAGuru')).toBeInTheDocument();

    // Poll 1 (5s): wrong-agent item must NOT resolve the wait
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByTestId('mock-card-risk-new')).not.toBeInTheDocument();

    // Poll 2 (10s): the CAPAGuru card renders inline
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId('mock-card-capa-new')).toBeInTheDocument();
    // Pre-existing card never surfaced
    expect(screen.queryByTestId('mock-card-capa-old')).not.toBeInTheDocument();
  });

  it('honest timeout after the poll cap, with retry available', async () => {
    mockQuery.mockResolvedValue(pendingResponse(['capa-old'])); // never a new item
    mockMutate.mockResolvedValueOnce({ runCapaAnalysis: { runId: 'r1', status: 'DISPATCHED' } });

    render(
      <AgentRunButton label="Analyze with CAPAGuru" mutation={RUN_MUTATION} agentName="CAPAGuru" />,
    );

    fireEvent.click(screen.getByText('Analyze with CAPAGuru'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Exhaust all 36 polls
    for (let i = 0; i < 36; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    expect(screen.getByText('studio.agentTimeout')).toBeInTheDocument();
    // The button returns so the user can retry
    expect(screen.getByText('Analyze with CAPAGuru')).toBeInTheDocument();
  });

  it('dispatch failure surfaces the real error and restores the button', async () => {
    mockQuery.mockResolvedValueOnce(pendingResponse([]));
    mockMutate.mockRejectedValueOnce(new Error('NC_NOT_FOUND'));

    render(<AgentRunButton label="Analyze" mutation={RUN_MUTATION} agentName="CAPAGuru" />);

    fireEvent.click(screen.getByText('Analyze'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('NC_NOT_FOUND')).toBeInTheDocument();
    expect(screen.getByText('Analyze')).toBeInTheDocument();
  });
});
