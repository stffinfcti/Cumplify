import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { DocumentEditor } from './DocumentEditor';

/**
 * DocumentEditor component tests (architect addition, 2026-07-22 — closing
 * the gap that triggered the P2 Session 3 bounce: the component itself had
 * zero test coverage, unlike its siblings in this codebase
 * (document-viewer.test.tsx, generation-view.test.tsx) which test rendering
 * with @testing-library/react, not just underlying pure logic).
 *
 * @tiptap/react is mocked — this codebase has no existing Tiptap-in-jsdom
 * test precedent, and the goal here is DocumentEditor's OWN wiring (state
 * management, callback attribution, section-kind routing), not ProseMirror
 * internals. onUpdate is captured from useEditor's options and invoked
 * manually to simulate a human edit.
 */

const mockMutate = vi.fn();
let capturedOnUpdate: ((args: { editor: { getHTML: () => string } }) => void) | null = null;
let capturedContent = '';
const chainCommands: string[] = [];

vi.mock('@tiptap/react', () => ({
  useEditor: (opts: {
    content?: string;
    onUpdate?: (args: { editor: { getHTML: () => string } }) => void;
  }) => {
    capturedOnUpdate = opts.onUpdate ?? null;
    capturedContent = opts.content ?? '';
    return {
      getHTML: () => '<p>mock content</p>',
      chain: () => ({
        focus: () => ({
          insertMermaidBlock: () => ({
            run: () => {
              chainCommands.push('insertMermaidBlock');
            },
          }),
        }),
      }),
    };
  },
  EditorContent: () => <div data-testid="tiptap-editor-content" />,
}));

vi.mock('@tiptap/starter-kit', () => ({ default: {} }));
vi.mock('@tiptap/extension-table', () => ({ default: { configure: () => ({}) } }));
vi.mock('@tiptap/extension-table-row', () => ({ default: {} }));
vi.mock('@tiptap/extension-table-cell', () => ({ default: {} }));
vi.mock('@tiptap/extension-table-header', () => ({ default: {} }));
vi.mock('./MermaidNode', () => ({ MermaidNode: {} }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { sub: 'user-9', email: 'jane@acme.com' } }),
}));
vi.mock('@/lib/api', () => ({ useGraphQL: () => ({ mutate: mockMutate }) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `editor.${key}`,
}));
vi.mock('@/components/shared', () => ({
  SecondaryButton: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  PrimaryButton: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  StatusBadge: ({ status }: { status: string }) => (
    <span data-testid={`badge-${status}`}>{status}</span>
  ),
}));
vi.mock('@/components/shared/GuidanceBanner', () => ({
  GuidanceBanner: ({ message }: { message: string }) => (
    <div data-testid="guidance-banner">{message}</div>
  ),
}));

const PROSE_SECTION = {
  harmonizationKey: '4.1',
  kind: 'prose',
  sentences: [{ text: 'Original content.' }],
};
const GAP_SECTION = {
  harmonizationKey: '6.1',
  kind: 'gap',
  gap: { missingSources: ['register.risk_assessments'] },
};
const NA_SECTION = {
  harmonizationKey: '7.2',
  kind: 'na_justified',
  naJustification: 'Design not in scope',
};
const FAILED_SECTION = { harmonizationKey: '8.1', kind: 'failed' };

beforeEach(() => {
  mockMutate.mockReset();
  capturedOnUpdate = null;
  capturedContent = '';
  chainCommands.length = 0;
});

describe('DocumentEditor — section-kind routing', () => {
  it('renders a Tiptap editor for prose sections', () => {
    render(<DocumentEditor sections={[PROSE_SECTION]} runId="run-1" />);
    expect(screen.getByTestId('tiptap-editor-content')).toBeInTheDocument();
  });

  it('renders non-editable content for gap sections (missingSources, no Tiptap instance)', () => {
    render(<DocumentEditor sections={[GAP_SECTION]} runId="run-1" />);
    expect(screen.queryByTestId('tiptap-editor-content')).not.toBeInTheDocument();
    expect(screen.getByText(/register.risk_assessments/)).toBeInTheDocument();
  });

  it('renders na_justified sections with the justification text', () => {
    render(<DocumentEditor sections={[NA_SECTION]} runId="run-1" />);
    expect(screen.getByText('Design not in scope')).toBeInTheDocument();
  });

  it('renders failed sections with the failed marker', () => {
    render(<DocumentEditor sections={[FAILED_SECTION]} runId="run-1" />);
    expect(screen.getByTestId('badge-REJECTED')).toBeInTheDocument();
  });
});

describe('DocumentEditor — human edit attribution', () => {
  it('a human edit shows the RS-9 sync-pending banner (honest, never faked as saved)', () => {
    render(<DocumentEditor sections={[PROSE_SECTION]} runId="run-1" />);
    expect(screen.queryByTestId('guidance-banner')).not.toBeInTheDocument();

    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edited content.</p>' } });
    });

    expect(screen.getByTestId('guidance-banner')).toBeInTheDocument();
  });
});

describe('DocumentEditor — iterate with agent (regenerateSection)', () => {
  it('calls regenerateSection + onSaved (worker writes the new version; no synthetic proposal)', async () => {
    mockMutate.mockResolvedValue({ regenerateSection: { harmonizationKey: '4.1', kind: 'PROSE' } });
    const onSaved = vi.fn();
    render(
      <DocumentEditor
        sections={[PROSE_SECTION]}
        runId="run-1"

        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByText('editor.iterateWithAgent'));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    const [statement, variables] = mockMutate.mock.calls[0];
    expect(statement).toContain('regenerateSection');
    expect(variables).toEqual({ input: { runId: 'run-1', harmonizationKey: '4.1' } });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // No proposal yet — the real text only arrives when the parent's refetch
    // delivers new section content (never a synthetic placeholder)
    expect(screen.queryByText('editor.accept')).not.toBeInTheDocument();
  });

  it('re-baselines when the server content moves: real text becomes the agent proposal', async () => {
    mockMutate.mockResolvedValue({ regenerateSection: { harmonizationKey: '4.1', kind: 'PROSE' } });
    const { rerender } = render(<DocumentEditor sections={[PROSE_SECTION]} runId="run-1" />);

    fireEvent.click(screen.getByText('editor.iterateWithAgent'));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));

    // Parent refetch returns the regenerated text — lands as a tracked
    // proposal attributed to the agent → sync-pending banner appears
    rerender(
      <DocumentEditor
        sections={[{ ...PROSE_SECTION, sentences: [{ text: 'Regenerated content.' }] }]}
        runId="run-1"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('guidance-banner')).toBeInTheDocument());
    expect(screen.getByText(/Regenerated content\./)).toBeInTheDocument();
  });
});

describe('DocumentEditor — Mermaid insertion (P2S3 gap closure)', () => {
  it('the insert-diagram button calls editor.chain().insertMermaidBlock()', () => {
    render(<DocumentEditor sections={[PROSE_SECTION]} runId="run-1" />);

    fireEvent.click(screen.getByText('editor.insertDiagram'));

    expect(chainCommands).toContain('insertMermaidBlock');
  });
});

describe('DocumentEditor — accept/reject + onConverge', () => {
  it('accepting the only pending change fires onConverge with the converged content', async () => {
    const onConverge = vi.fn();
    render(
      <DocumentEditor
        sections={[PROSE_SECTION]}
        runId="run-1"

        onConverge={onConverge}
      />,
    );
    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edited content.</p>' } });
    });

    fireEvent.click(screen.getByText('editor.accept'));

    // Effect-driven: converged content = accepted human edit (a 'replace'
    // carries the full editor HTML)
    await waitFor(() => expect(onConverge).toHaveBeenCalledWith('4.1', '<p>Edited content.</p>'));
    expect(onConverge).toHaveBeenCalledTimes(1);
  });

  it('rejecting the only pending change also fires onConverge (base content stands)', async () => {
    const onConverge = vi.fn();
    render(
      <DocumentEditor
        sections={[PROSE_SECTION]}
        runId="run-1"

        onConverge={onConverge}
      />,
    );
    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edited content.</p>' } });
    });

    fireEvent.click(screen.getByText('editor.reject'));

    await waitFor(() => expect(onConverge).toHaveBeenCalledWith('4.1', 'Original content.'));
  });

  it('does NOT fire onConverge while a second change is still pending', async () => {
    // A typing burst COALESCES into one change (2026-07-22 fix) — the real
    // two-pending scenario is human edit + agent proposal (which arrives via
    // the server refetch, never inline from the regenerate call).
    mockMutate.mockResolvedValue({
      regenerateSection: { harmonizationKey: '4.1', kind: 'PROSE' },
    });
    const onConverge = vi.fn();
    const { rerender } = render(
      <DocumentEditor
        sections={[PROSE_SECTION]}
        runId="run-1"

        onConverge={onConverge}
      />,
    );
    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edit 1.</p>' } });
    });
    fireEvent.click(screen.getByText('editor.iterateWithAgent'));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    rerender(
      <DocumentEditor
        sections={[{ ...PROSE_SECTION, sentences: [{ text: 'Regenerated.' }] }]}
        runId="run-1"

        onConverge={onConverge}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('editor.accept').length).toBe(2));

    fireEvent.click(screen.getAllByText('editor.accept')[0]);

    await act(async () => {});
    expect(onConverge).not.toHaveBeenCalled();
  });

  it('a typing burst coalesces into ONE tracked change (found live 2026-07-22: four identical entries per sentence)', () => {
    render(<DocumentEditor sections={[PROSE_SECTION]} runId="run-1" />);
    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edit a.</p>' } });
    });
    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edit ab.</p>' } });
    });
    act(() => {
      capturedOnUpdate!({ editor: { getHTML: () => '<p>Edit abc.</p>' } });
    });
    expect(screen.getAllByText('editor.accept').length).toBe(1);
  });
});

describe('DocumentEditor — RS-9 save wire (owner 2026-07-22: drafts must be editable)', () => {
  it('an edit enables Save version; save calls saveDocumentSectionEdit with versionId + body + trackedChanges', async () => {
    mockMutate.mockResolvedValue({
      saveDocumentSectionEdit: {
        id: 'v2',
        versionNo: 2,
        changeSummary: 'Section edit: 4.1',
        createdAt: 'now',
      },
    });
    const onSaved = vi.fn();
    render(
      <DocumentEditor
        sections={[PROSE_SECTION]}
        runId="doc-1"

        versionId="v1"
        onSaved={onSaved}
      />,
    );

    // Save disabled until the human edits (syncStatus 'local')
    const saveBtn = screen.getByText('editor.saveVersion');
    expect(saveBtn).toBeDisabled();

    // Simulate a Tiptap edit
    capturedOnUpdate!({ editor: { getHTML: () => '<p>Edited content.</p>' } } as never);
    await waitFor(() => expect(screen.getByText('editor.saveVersion')).not.toBeDisabled());

    fireEvent.click(screen.getByText('editor.saveVersion'));
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());

    const [mutation, vars] = mockMutate.mock.calls[0];
    expect(mutation).toContain('saveDocumentSectionEdit');
    expect(vars.input.versionId).toBe('v1');
    expect(vars.input.harmonizationKey).toBe('4.1');
    expect(vars.input.body).toBe('<p>Edited content.</p>');
    // ES-4: attribution payload rides as a JSON string
    const changes = JSON.parse(vars.input.trackedChanges);
    expect(Array.isArray(changes)).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // Sync banner clears after a successful save
    expect(screen.queryByTestId('guidance-banner')).toBeNull();
  });

  it('a prior humanEditedBody becomes the editor baseline (round-trip)', () => {
    render(
      <DocumentEditor
        sections={[{ ...PROSE_SECTION, humanEditedBody: '<p>Previously saved.</p>' }]}
        runId="doc-1"

        versionId="v1"
      />,
    );
    expect(capturedContent).toContain('Previously saved.');
  });
});
