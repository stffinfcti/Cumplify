import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ManualPage from './page';

// ----- Mocks -----

const mockQuery = vi.fn();
const mockMutate = vi.fn();

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ query: mockQuery, mutate: mockMutate }),
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: {
      sub: 'u1',
      email: 'test@test.com',
      tenantId: 'T1',
      role: 'QualityManager',
      locale: 'en',
    },
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
}));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string) => key;
    t.has = () => true;
    return t;
  },
}));

vi.mock('@/components/controlled-doc/ControlledDocViewer', () => ({
  ControlledDocViewer: () => <div data-testid="doc-viewer" />,
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
        data-testid={`arb-${(variables?.harmonizationKey as string) ?? label}`}
        data-mutation={mutation}
        data-variables={JSON.stringify(variables ?? {})}
        data-agent={agentName}
      >
        {label}
      </button>
    ),
  };
});

vi.mock('@/components/shared/StatTile', () => ({
  StatTile: ({ label, value }: { label: string; value: string | number }) => (
    <div data-testid={`stat-${label}`}>{String(value)}</div>
  ),
}));

// ----- Fixtures -----

const LIGHTWEIGHT_RUN = {
  id: 'run-1',
  status: 'COMPLETE',
  standards: ['ISO9001'],
  sections: [], // listGenerationRuns is deliberately lightweight
  manualDocumentId: 'doc-1',
  gapCount: 0,
  startedAt: '2026-07-22T12:59:52Z',
  finishedAt: '2026-07-22T13:00:23Z',
};

const FULL_RUN = {
  ...LIGHTWEIGHT_RUN,
  sections: [
    {
      id: 's1',
      harmonizationKey: '4.1',
      kind: 'PROSE',
      clauseRefs: ['c1'],
      contentSha256: 'sha',
      reviewedBy: null,
      reviewedAt: null,
      error: null,
    },
    {
      id: 's2',
      harmonizationKey: '4.2',
      kind: 'GAP',
      clauseRefs: ['c2'],
      contentSha256: null,
      reviewedBy: null,
      reviewedAt: null,
      error: null,
    },
    {
      id: 's3',
      harmonizationKey: '5.1',
      kind: 'PROSE',
      clauseRefs: ['c3'],
      contentSha256: 'sha',
      reviewedBy: 'u1',
      reviewedAt: '2026-07-22T13:05:00Z',
      error: null,
    },
  ],
  gapCount: 1,
};

// ----- Tests -----

describe('ManualPage — State 4 hydration (found live 2026-07-22)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (q: string) => {
      if (q.includes('GetOrgProfile')) {
        return {
          getOrgProfile: {
            id: 'p1',
            currentVersion: 2,
            payload: { legalName: 'X' },
            updatedAt: '2026-07-22',
          },
        };
      }
      if (q.includes('ListGenerationRuns')) {
        return { listGenerationRuns: [LIGHTWEIGHT_RUN] };
      }
      if (q.includes('GetGenerationRun')) {
        return { getGenerationRun: FULL_RUN };
      }
      if (q.includes('ListDocumentVersions')) {
        return { listDocumentVersions: [] };
      }
      throw new Error(`unmocked query: ${q.slice(0, 60)}`);
    });
  });

  it('hydrates the latest run via getGenerationRun — tiles come from the DETAIL, never the lightweight list row', async () => {
    render(<ManualPage />);

    await waitFor(() => {
      expect(screen.getByTestId('stat-statTotal')).toHaveTextContent('3');
    });
    // Gaps from the detail (1), NOT the list row's hardcoded 0
    expect(screen.getByTestId('stat-statGaps')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-statReviewed')).toHaveTextContent('1/3');

    // The detail query was actually issued for the latest run
    const detailCall = mockQuery.mock.calls.find(([q]) =>
      (q as string).includes('GetGenerationRun'),
    );
    expect(detailCall).toBeTruthy();
    expect(detailCall![1]).toEqual({ id: 'run-1' });
  });
});

describe('ManualPage — S3 gap burn-down (Manual Studio)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (q: string) => {
      if (q.includes('GetOrgProfile')) {
        return {
          getOrgProfile: {
            id: 'p1',
            currentVersion: 2,
            payload: { legalName: 'X' },
            updatedAt: '2026-07-22',
          },
        };
      }
      if (q.includes('ListGenerationRuns')) return { listGenerationRuns: [LIGHTWEIGHT_RUN] };
      if (q.includes('GetGenerationRun')) return { getGenerationRun: FULL_RUN };
      if (q.includes('ListDocumentVersions')) return { listDocumentVersions: [] };
      throw new Error(`unmocked query: ${q.slice(0, 60)}`);
    });
  });

  it('every GAP section gets Draft-with-DocStudio wired to runManualSectionDraft; prose sections do not', async () => {
    render(<ManualPage />);
    await waitFor(() => {
      expect(screen.getByTestId('arb-4.2')).toBeInTheDocument();
    });

    const btn = screen.getByTestId('arb-4.2');
    expect(btn).toHaveAttribute('data-agent', 'DocStudio');
    expect(btn.getAttribute('data-mutation')).toContain('runManualSectionDraft');
    expect(JSON.parse(btn.getAttribute('data-variables')!)).toEqual({
      runId: 'run-1',
      harmonizationKey: '4.2',
    });

    // PROSE sections (4.1, 5.1) never get a draft button
    expect(screen.queryByTestId('arb-4.1')).toBeNull();
    expect(screen.queryByTestId('arb-5.1')).toBeNull();
  });
});
