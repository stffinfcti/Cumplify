import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { HitlQueuePanel } from './HitlQueuePanel';

// ----- Mocks -----

const mockQuery = vi.fn();
const mockMutate = vi.fn();

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ query: mockQuery, mutate: mockMutate }),
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

vi.mock('@/lib/use-tenant-subscription', () => ({
  useTenantSubscription: () => {},
}));

// Mock next-intl
vi.mock('next-intl', () => {
  const translations: Record<string, Record<string, string>> = {
    commandCenter: {
      hitlQueue: 'Approval Queue',
      loading: 'Loading...',
      noItems: 'No items',
      loadMore: 'Load more',
      loadingMore: 'Loading…',
    },
    hitlCard: {
      approve: 'Approve',
      editAndApprove: 'Edit & approve',
      sendBack: 'Send back with note',
      trustRitual: 'Trust ritual',
      flaggedJustification: 'Justification required',
      notePlaceholder: 'Note',
      viewAuditEvent: 'View event',
      guardrailEvidence: 'Evidence',
      groundingScore: 'Grounding',
      arVerdict: 'Verdict',
      actionError: 'Failed',
      editArgsLabel: 'Edit args',
      editParseError: 'Invalid JSON',
      confirmEdit: 'Confirm',
      cancelEdit: 'Cancel',
      dismiss: 'Dismiss',
    },
    status: { PENDING: 'Pending' },
  };
  return {
    useTranslations: (ns: string) => {
      const t = (key: string) => translations[ns]?.[key] ?? key;
      t.has = (key: string) => !!translations[ns]?.[key];
      return t;
    },
  };
});

vi.mock('@/components/shared', () => ({
  Panel: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div data-testid="panel" aria-label={title}>
      {title}
      {children}
    </div>
  ),
  StatusBadge: ({ status }: { status: string }) => <span data-testid="badge">{status}</span>,
  ClauseChip: ({ clauseRef }: { clauseRef: string | null }) =>
    clauseRef ? <span data-testid="chip">{clauseRef}</span> : null,
  EmptyState: ({ message }: { message: string }) => <p>{message}</p>,
  ErrorState: ({ onRetry }: { onRetry: () => void }) => (
    <button onClick={onRetry}>retry-action</button>
  ),
  PrimaryButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-testid="primary-btn" {...props}>
      {children}
    </button>
  ),
  SecondaryButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-testid="secondary-btn" {...props}>
      {children}
    </button>
  ),
  ProvenanceLink: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="provenance">{children}</span>
  ),
}));

// ----- Fixtures -----

const unflaggedItem = {
  hitlItemId: 'item-1',
  agentName: 'CAPAGuru',
  clauseRef: '8.5.1',
  standard: 'ISO9001',
  module: 'M2',
  draftBody: JSON.stringify({ tool: 'capa-open', args: { ncId: 'nc-1', actionDesc: 'Fix it' } }),
  status: 'PENDING',
  createdAt: '2026-07-13T00:00:00Z',
  guardrailEvidence: null,
};

const flaggedItem = {
  ...unflaggedItem,
  hitlItemId: 'item-2',
  module: 'M1',
  guardrailEvidence: {
    groundingScore: 0.72,
    arVerdict: 'PASS',
    arDetails: 'All citations verified',
    citations: [{ clauseRef: '8.5.1', sourceChunk: 'chunk', score: 0.9 }],
  },
};

const unparseableItem = {
  ...unflaggedItem,
  hitlItemId: 'item-3',
  draftBody: 'This is not JSON at all',
};

// ----- Tests -----

describe('HitlQueuePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'QualityManager';
    mockQuery.mockResolvedValue({
      listPendingHitlItems: {
        items: [unflaggedItem, flaggedItem, unparseableItem],
        nextToken: null,
      },
    });
  });

  describe('CARD-3: three action buttons', () => {
    it('renders Approve, Edit & approve, Send back for a permitted role+module (parseable)', async () => {
      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-actions-item-1')).toBeInTheDocument());

      const card = screen.getByTestId('hitl-actions-item-1');
      const buttons = card.querySelectorAll('button');
      const labels = Array.from(buttons).map((b) => b.textContent);
      expect(labels).toContain('Approve');
      expect(labels).toContain('Edit & approve');
      expect(labels).toContain('Send back with note');
    });

    it('hides Edit & approve when draftBody is not parseable JSON', async () => {
      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-actions-item-3')).toBeInTheDocument());

      const card = screen.getByTestId('hitl-actions-item-3');
      const buttons = card.querySelectorAll('button');
      const labels = Array.from(buttons).map((b) => b.textContent);
      expect(labels).toContain('Approve');
      expect(labels).not.toContain('Edit & approve');
      expect(labels).toContain('Send back with note');
    });

    it('does NOT render action buttons when canApprove(role, module) is false', async () => {
      // Employee can only approve M10 — items are M1/M2
      mockRole = 'Employee';
      render(<HitlQueuePanel />);
      await waitFor(() => expect(mockQuery).toHaveBeenCalled());
      // Wait for render to settle
      await waitFor(() => expect(screen.getByTestId('hitl-card-item-1')).toBeInTheDocument());

      expect(screen.queryByTestId('hitl-actions-item-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hitl-actions-item-2')).not.toBeInTheDocument();
    });
  });

  describe('CARD-7: justification gate', () => {
    it('Approve button is disabled for flagged item when justification is empty', async () => {
      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-card-item-2')).toBeInTheDocument());

      const card = screen.getByTestId('hitl-card-item-2');
      const approveBtn = card.querySelector('[data-testid="primary-btn"]') as HTMLButtonElement;
      expect(approveBtn).toBeDisabled();
    });

    it('Approve button enables when justification is entered for flagged item', async () => {
      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-card-item-2')).toBeInTheDocument());

      const card = screen.getByTestId('hitl-card-item-2');
      const textarea = card.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Justified because...' } });

      const approveBtn = card.querySelector('[data-testid="primary-btn"]') as HTMLButtonElement;
      expect(approveBtn).not.toBeDisabled();
    });

    it('mutation includes justification for flagged item', async () => {
      mockMutate.mockResolvedValue({
        approveHitlItem: {
          hitlItemId: 'item-2',
          auditEventId: 'evt-1',
          auditEventTimestamp: '2026-07-13T12:00:00Z',
        },
      });

      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-card-item-2')).toBeInTheDocument());

      const card = screen.getByTestId('hitl-card-item-2');
      const textarea = card.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Good reason' } });

      const approveBtn = card.querySelector('[data-testid="primary-btn"]') as HTMLButtonElement;
      fireEvent.click(approveBtn);

      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      const callArgs = mockMutate.mock.calls[0][1];
      expect(callArgs.input.justification).toBe('Good reason');
      expect(callArgs.input.decision).toBe('APPROVE');
    });

    it('unflagged item approves without justification', async () => {
      mockMutate.mockResolvedValue({
        approveHitlItem: {
          hitlItemId: 'item-1',
          auditEventId: 'evt-2',
          auditEventTimestamp: '2026-07-13T12:00:00Z',
        },
      });

      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-actions-item-1')).toBeInTheDocument());

      const card = screen.getByTestId('hitl-card-item-1');
      const approveBtn = card.querySelector('[data-testid="primary-btn"]') as HTMLButtonElement;
      expect(approveBtn).not.toBeDisabled();
      fireEvent.click(approveBtn);

      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      const callArgs = mockMutate.mock.calls[0][1];
      expect(callArgs.input.justification).toBeUndefined();
    });
  });

  describe('CARD-3: Edit & approve flow', () => {
    it('enters edit mode and sends the edited args as an AWSJSON string', async () => {
      mockMutate.mockResolvedValue({
        approveHitlItem: {
          hitlItemId: 'item-1',
          auditEventId: 'evt-3',
          auditEventTimestamp: '2026-07-13T12:00:00Z',
        },
      });

      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-actions-item-1')).toBeInTheDocument());

      // Click Edit & approve
      const actionsDiv = screen.getByTestId('hitl-actions-item-1');
      const editBtn = Array.from(actionsDiv.querySelectorAll('button')).find(
        (b) => b.textContent === 'Edit & approve',
      )!;
      fireEvent.click(editBtn);

      // Edit mode textarea appears with the args JSON
      const card = screen.getByTestId('hitl-card-item-1');
      await waitFor(() => {
        const textareas = card.querySelectorAll('textarea');
        expect(textareas.length).toBeGreaterThanOrEqual(1);
      });

      // Get the edit textarea (first one in edit section)
      const editTextarea = card.querySelector('textarea') as HTMLTextAreaElement;
      const newArgs = { ncId: 'nc-1', actionDesc: 'Fixed and verified' };
      fireEvent.change(editTextarea, { target: { value: JSON.stringify(newArgs) } });

      // Click Confirm
      const confirmBtn = Array.from(card.querySelectorAll('button')).find(
        (b) => b.textContent === 'Confirm',
      )!;
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(mockMutate).toHaveBeenCalled());
      const callArgs = mockMutate.mock.calls[0][1];
      // AWSJSON wire form: a JSON-encoded string (AppSync delivers the parsed
      // object to the resolver — services hitl-approval.test.ts asserts that side)
      expect(callArgs.input.editedPayload).toBe(JSON.stringify(newArgs));
      expect(callArgs.input.decision).toBe('APPROVE');
    });
  });

  describe('HITL-REACH-1: load-more pagination', () => {
    it('renders "Load more" button when nextToken is present', async () => {
      mockQuery.mockResolvedValue({
        listPendingHitlItems: {
          items: [unflaggedItem],
          nextToken: 'page2-token',
        },
      });
      render(<HitlQueuePanel />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument(),
      );
    });

    it('does NOT render "Load more" when nextToken is null (all items loaded)', async () => {
      mockQuery.mockResolvedValue({
        listPendingHitlItems: {
          items: [unflaggedItem],
          nextToken: null,
        },
      });
      render(<HitlQueuePanel />);
      await waitFor(() => expect(screen.getByTestId('hitl-card-item-1')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('clicking "Load more" appends page 2 items and passes nextToken', async () => {
      const page2Item = { ...unflaggedItem, hitlItemId: 'item-page2' };
      mockQuery
        .mockResolvedValueOnce({
          listPendingHitlItems: { items: [unflaggedItem], nextToken: 'page2-token' },
        })
        .mockResolvedValueOnce({
          listPendingHitlItems: { items: [page2Item], nextToken: null },
        });

      render(<HitlQueuePanel />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

      await waitFor(() => expect(screen.getByTestId('hitl-card-item-page2')).toBeInTheDocument());
      // Original item still visible
      expect(screen.getByTestId('hitl-card-item-1')).toBeInTheDocument();
      // Load more disappears (nextToken now null)
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

      // Second query passed the nextToken
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const secondCallVars = mockQuery.mock.calls[1][1];
      expect(secondCallVars.pagination.nextToken).toBe('page2-token');
    });

    // HR1-POLL-1 amendment: these three FAIL on 609f5b0's replace-and-reset poll.

    it('a loaded page SURVIVES a poll cycle (HR1-POLL-1)', async () => {
      vi.useFakeTimers();
      try {
        const page2Item = { ...unflaggedItem, hitlItemId: 'item-page2' };
        mockQuery
          .mockResolvedValueOnce({
            listPendingHitlItems: { items: [unflaggedItem], nextToken: 'page2-token' },
          })
          .mockResolvedValueOnce({
            listPendingHitlItems: { items: [page2Item], nextToken: null },
          })
          // every poll tick thereafter: page-1 window only
          .mockResolvedValue({
            listPendingHitlItems: { items: [unflaggedItem], nextToken: 'page2-token' },
          });

        render(<HitlQueuePanel />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByTestId('hitl-card-item-page2')).toBeInTheDocument();

        // Cross the 15s poll interval — the page-1 refresh must keep the tail
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(screen.getByTestId('hitl-card-item-page2')).toBeInTheDocument();
        expect(screen.getByTestId('hitl-card-item-1')).toBeInTheDocument();
        expect(screen.getAllByTestId(/^hitl-card-/)).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('overlapping cursor windows never duplicate a card (HR1-DUP-1)', async () => {
      const sharedItem = { ...unflaggedItem, hitlItemId: 'item-shared' };
      const page2Only = { ...unflaggedItem, hitlItemId: 'item-21' };
      mockQuery
        .mockResolvedValueOnce({
          listPendingHitlItems: { items: [unflaggedItem, sharedItem], nextToken: 'p2' },
        })
        // window shifted between fetches: page 2 re-serves sharedItem
        .mockResolvedValueOnce({
          listPendingHitlItems: { items: [sharedItem, page2Only], nextToken: null },
        });

      render(<HitlQueuePanel />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(screen.getByTestId('hitl-card-item-21')).toBeInTheDocument());
      expect(screen.getAllByTestId('hitl-card-item-shared')).toHaveLength(1);
      expect(screen.getAllByTestId(/^hitl-card-/)).toHaveLength(3);
    });

    it('poll does not clobber a deeper cursor — next Load more uses the deep token', async () => {
      vi.useFakeTimers();
      try {
        const p2Item = { ...unflaggedItem, hitlItemId: 'item-p2' };
        const p3Item = { ...unflaggedItem, hitlItemId: 'item-p3' };
        mockQuery
          .mockResolvedValueOnce({
            listPendingHitlItems: { items: [unflaggedItem], nextToken: 'p2' },
          })
          .mockResolvedValueOnce({
            listPendingHitlItems: { items: [p2Item], nextToken: 'p3' },
          })
          // poll tick returns a SHALLOWER page-1 token
          .mockResolvedValueOnce({
            listPendingHitlItems: { items: [unflaggedItem], nextToken: 'p1x' },
          })
          .mockResolvedValueOnce({
            listPendingHitlItems: { items: [p3Item], nextToken: null },
          });

        render(<HitlQueuePanel />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000); // poll tick (p1x)
        });
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByTestId('hitl-card-item-p3')).toBeInTheDocument();
        expect(mockQuery).toHaveBeenCalledTimes(4);
        const lastVars = mockQuery.mock.calls[3][1];
        expect(lastVars.pagination.nextToken).toBe('p3');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
