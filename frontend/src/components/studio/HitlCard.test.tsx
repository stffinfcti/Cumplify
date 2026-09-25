import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HitlCard } from './HitlCard';
import type { HitlItem } from './hitl';

// ----- Mocks -----

const mockMutate = vi.fn();

vi.mock('@/lib/api', () => ({
  useGraphQL: () => ({ query: vi.fn(), mutate: mockMutate }),
}));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
}));

vi.mock('@/components/shared', () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
  ClauseChip: ({ clauseRef }: { clauseRef: string }) => <span>{clauseRef}</span>,
  PrimaryButton: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  SecondaryButton: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  ProvenanceLink: ({ children }: { children: React.ReactNode }) => (
    <a data-testid="provenance">{children}</a>
  ),
}));

const ITEM: HitlItem = {
  hitlItemId: 'item-1',
  agentName: 'CAPAGuru',
  clauseRef: '10.2',
  standard: 'ISO9001',
  module: 'M2',
  draftBody: '{"tool":"capa-open","args":{"ncId":"nc-1"}}',
  status: 'PENDING',
  createdAt: '2026-07-22T15:00:00Z',
  guardrailEvidence: null,
};

// ----- Tests -----

describe('HitlCard (shared studio card)', () => {
  beforeEach(() => {
    mockMutate.mockReset();
  });

  it('approve calls the mutation and shows the ProvenanceLink banner; onApproved fires', async () => {
    mockMutate.mockResolvedValueOnce({
      approveHitlItem: {
        hitlItemId: 'item-1',
        auditEventId: 'evt-1',
        auditEventTimestamp: '2026-07-22T15:01:00Z',
      },
    });
    const onApproved = vi.fn();
    render(<HitlCard item={ITEM} role="QualityManager" onApproved={onApproved} />);

    fireEvent.click(screen.getByText('hitlCard.approve'));

    await waitFor(() => expect(screen.getByTestId('provenance')).toBeInTheDocument());
    expect(onApproved).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ auditEventId: 'evt-1' }),
    );
    const input = mockMutate.mock.calls[0][1].input;
    expect(input).toMatchObject({ hitlItemId: 'item-1', decision: 'APPROVE' });
  });

  it('SoD/matrix rejection surfaces the backend message verbatim on the card', async () => {
    mockMutate.mockRejectedValueOnce(
      new Error('SoD violation: the proposer cannot approve their own item'),
    );
    render(<HitlCard item={ITEM} role="QualityManager" />);

    fireEvent.click(screen.getByText('hitlCard.approve'));

    await waitFor(() =>
      expect(
        screen.getByText('SoD violation: the proposer cannot approve their own item'),
      ).toBeInTheDocument(),
    );
    // Card stays actionable (a second approver could still act in another session)
    expect(screen.getByTestId('hitl-actions-item-1')).toBeInTheDocument();
  });

  it('role without module rights sees the proposal but NO actions (CON-6 presentation gate)', () => {
    render(<HitlCard item={ITEM} role="Employee" />);
    expect(screen.getByTestId('hitl-card-item-1')).toBeInTheDocument();
    expect(screen.queryByTestId('hitl-actions-item-1')).not.toBeInTheDocument();
  });

  it('send back removes the card via onRemove', async () => {
    mockMutate.mockResolvedValueOnce({ approveHitlItem: null });
    const onRemove = vi.fn();
    render(<HitlCard item={ITEM} role="QualityManager" onRemove={onRemove} />);

    fireEvent.click(screen.getByText('hitlCard.sendBack'));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('item-1'));
    expect(mockMutate.mock.calls[0][1].input.decision).toBe('SEND_BACK');
  });
});
