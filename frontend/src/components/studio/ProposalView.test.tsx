import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProposalView } from './ProposalView';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    const t = (key: string) => `${ns}.${key}`;
    t.has = () => true;
    return t;
  },
}));

describe('ProposalView (owner screenshots 2026-07-22: raw JSON on live cards)', () => {
  it('manual-section-draft: sentences render as prose + rationale; raw JSON behind a disclosure', () => {
    render(
      <ProposalView
        draftBody={JSON.stringify({
          tool: 'manual-section-draft',
          args: {
            generationRunId: 'g-1',
            harmonizationKey: '10.2#ISO14001',
            sentences: [{ text: 'First sentence.' }, { text: 'Second sentence.' }],
            rationale: 'Covers 10.2 intents.',
          },
        })}
      />,
    );
    expect(screen.getByTestId('proposal-view')).toBeInTheDocument();
    expect(screen.getByText('First sentence. Second sentence.')).toBeInTheDocument();
    expect(screen.getByText('Covers 10.2 intents.')).toBeInTheDocument();
    expect(screen.getByText('10.2#ISO14001')).toBeInTheDocument();
    // Raw JSON preserved for audit, one disclosure away
    expect(screen.getByText('proposal.rawJson')).toBeInTheDocument();
  });

  it('doc-draft: title, chips, and sections with headings', () => {
    render(
      <ProposalView
        draftBody={JSON.stringify({
          tool: 'doc-draft',
          args: {
            title: 'Sales Policy',
            standard: 'ISO9001',
            docType: 'policy',
            sections: [{ clauseRef: '5.2', heading: 'Policy statement', body: 'We commit.' }],
            rationale: 'Aligned with 5.2.',
          },
        })}
      />,
    );
    expect(screen.getByText('Sales Policy')).toBeInTheDocument();
    expect(screen.getByText('5.2 — Policy statement')).toBeInTheDocument();
    expect(screen.getByText('We commit.')).toBeInTheDocument();
  });

  it('nc-draft-write: labeled field chips + description', () => {
    render(
      <ProposalView
        draftBody={JSON.stringify({
          tool: 'nc-draft-write',
          args: {
            standard: 'ISO9001',
            clauseRef: '8.7',
            severity: 'medium',
            source: 'complaint',
            ncType: 'nonconforming_output',
            description: 'Packing quality complaints received.',
            rationale: 'Nonconforming output before delivery.',
          },
        })}
      />,
    );
    expect(screen.getByText('8.7')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.getByText('Packing quality complaints received.')).toBeInTheDocument();
  });

  it('unknown tools and non-JSON fall back to the verbatim body (prior behavior)', () => {
    const { rerender } = render(
      <ProposalView draftBody={'{"tool":"capa-open","args":{"ncId":"nc-1"}}'} />,
    );
    expect(screen.queryByTestId('proposal-view')).toBeNull();
    expect(screen.getByText('{"tool":"capa-open","args":{"ncId":"nc-1"}}')).toBeInTheDocument();

    rerender(<ProposalView draftBody="This is not JSON at all" />);
    expect(screen.getByText('This is not JSON at all')).toBeInTheDocument();
  });
});

describe('ProposalView — rca-write (C1)', () => {
  it('5 Whys chain renders as an ordered list ending in the root cause', () => {
    render(
      <ProposalView
        draftBody={JSON.stringify({
          tool: 'rca-write',
          args: {
            ncId: 'nc-1',
            method: '5why',
            findings: {
              whys: [
                {
                  question: 'Why did the finish not match?',
                  answer: 'Wrong lacquer batch was pulled.',
                },
                {
                  question: 'Why was the wrong batch pulled?',
                  answer: 'Bins are not labeled by job.',
                },
              ],
            },
            rootCauseSummary: 'No job-level material identification at the finishing station.',
            rationale: 'Derived from the NC description; confirm via bin audit.',
          },
        })}
      />,
    );
    // Texts also appear inside the raw-JSON disclosure — assert presence, not uniqueness
    expect(screen.getAllByText('Wrong lacquer batch was pulled.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bins are not labeled by job.').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No job-level material identification/).length).toBeGreaterThan(0);
  });

  it('fishbone categories render grouped causes', () => {
    render(
      <ProposalView
        draftBody={JSON.stringify({
          tool: 'rca-write',
          args: {
            ncId: 'nc-1',
            method: 'fishbone',
            findings: {
              categories: [
                { category: 'Method', causes: ['No labeling SOP', 'No verification step'] },
                { category: 'Material', causes: ['Similar-looking lacquer tins'] },
              ],
            },
            rootCauseSummary: 'Missing verification step in the finishing SOP.',
            rationale: 'Most probable branch first.',
          },
        })}
      />,
    );
    expect(screen.getAllByText(/No labeling SOP; No verification step/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Missing verification step/).length).toBeGreaterThan(0);
  });
});
