import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FormDrawer, type FieldDef } from './FormDrawer';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string) => {
      const map: Record<string, string> = {
        loading: 'Loading...',
        error: 'Error',
        submit: 'Submit',
        cancel: 'Cancel',
        close: 'Close',
      };
      return map[key] ?? key;
    };
    return t;
  },
}));

// Mock Buttons
vi.mock('./Buttons', () => ({
  PrimaryButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-testid="submit-btn" {...props}>
      {children}
    </button>
  ),
  SecondaryButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-testid="cancel-btn" {...props}>
      {children}
    </button>
  ),
}));

const fields: FieldDef[] = [
  { name: 'title', label: 'Title', type: 'text', required: true, defaultValue: 'Default Title' },
  { name: 'dueDate', label: 'Due', type: 'date', required: true },
  { name: 'active', label: 'Active', type: 'checkbox' },
];

describe('FormDrawer', () => {
  let onSubmit: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSubmit = vi.fn().mockResolvedValue(undefined);
    onClose = vi.fn();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <FormDrawer
        open={false}
        onClose={onClose}
        title="Test"
        fields={fields}
        onSubmit={onSubmit}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('submits values on form submission', async () => {
    render(
      <FormDrawer open={true} onClose={onClose} title="Test" fields={fields} onSubmit={onSubmit} />,
    );

    // Change the date field
    const dateInput = screen.getByLabelText('Due') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-08-15' } });

    fireEvent.click(screen.getByTestId('submit-btn'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.title).toBe('Default Title');
    expect(submitted.active).toBe(false);
  });

  it('G5: converts date fields to full ISO before submission', async () => {
    render(
      <FormDrawer open={true} onClose={onClose} title="Test" fields={fields} onSubmit={onSubmit} />,
    );

    const dateInput = screen.getByLabelText('Due') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-08-15' } });

    fireEvent.click(screen.getByTestId('submit-btn'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    // Date should be converted to ISO string
    expect(submitted.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('G5: resets values when opened with new defaults (chip prefill)', async () => {
    const fieldsWithPrefill: FieldDef[] = [
      { name: 'title', label: 'Title', type: 'text', required: true, defaultValue: 'Chip Title' },
    ];

    const { rerender } = render(
      <FormDrawer
        open={false}
        onClose={onClose}
        title="Test"
        fields={fieldsWithPrefill}
        onSubmit={onSubmit}
      />,
    );

    // Open the drawer
    rerender(
      <FormDrawer
        open={true}
        onClose={onClose}
        title="Test"
        fields={fieldsWithPrefill}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByLabelText('Title') as HTMLInputElement;
    expect(input.value).toBe('Chip Title');
  });

  it('required fields block submission via native validation', () => {
    render(
      <FormDrawer open={true} onClose={onClose} title="Test" fields={fields} onSubmit={onSubmit} />,
    );

    // Clear the required title field
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '' } });

    // Submit — the form has required fields, browser blocks (onSubmit not called)
    // In jsdom, required is not enforced, so we test that the required attr is present
    expect(titleInput).toHaveAttribute('required');
  });

  it('FE-3: a resolved submit closes the drawer', async () => {
    render(
      <FormDrawer open={true} onClose={onClose} title="Test" fields={fields} onSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByTestId('submit-btn'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('FE-3: keepOpen skips the auto-close on a resolved submit', async () => {
    render(
      <FormDrawer
        open={true}
        onClose={onClose}
        title="Test"
        fields={fields}
        onSubmit={onSubmit}
        keepOpen={true}
      />,
    );

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByTestId('submit-btn'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('FE-3: a thrown submit error stays open and shows it inline (no close)', async () => {
    onSubmit.mockRejectedValue(new Error('Mutation failed'));
    render(
      <FormDrawer open={true} onClose={onClose} title="Test" fields={fields} onSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByTestId('submit-btn'));

    // err.message prose is never rendered — unmapped errors resolve to the
    // errors.generic catalog string.
    await waitFor(() => expect(screen.getByText('generic')).toBeInTheDocument());
    expect(screen.queryByText('Mutation failed')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('FE-3: a resolver error code maps to its catalog string, not the prose', async () => {
    onSubmit.mockRejectedValue(new Error('RECORD_NOT_FOUND: English internals here'));
    render(
      <FormDrawer open={true} onClose={onClose} title="Test" fields={fields} onSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByTestId('submit-btn'));

    await waitFor(() => expect(screen.getByText('recordNotFound')).toBeInTheDocument());
    expect(screen.queryByText(/English internals/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
