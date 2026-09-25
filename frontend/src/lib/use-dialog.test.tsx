import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { useDialog } from './use-dialog';

/**
 * useDialog (FE-10) — WAI-ARIA dialog mechanics: role/aria-modal attrs,
 * Escape closes, focus trap wraps Tab edges, initial focus lands inside,
 * focus returns to the trigger on close.
 */

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const { dialogRef, dialogProps } = useDialog(open, () => {
    setOpen(false);
    onClose();
  });
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <div data-testid="dialog" ref={dialogRef} {...dialogProps}>
          <button data-testid="first">first</button>
          <input data-testid="middle" />
          <button data-testid="last">last</button>
        </div>
      )}
    </>
  );
}

describe('useDialog', () => {
  it('marks the dialog element with role=dialog + aria-modal', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    const dialog = screen.getByTestId('dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('moves initial focus to the first focusable element on open', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });

  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByTestId('trigger'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
  });

  it('traps Tab: last → first, and Shift-Tab: first → last', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('trigger'));

    const first = screen.getByTestId('first');
    const last = screen.getByTestId('last');

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back into the dialog when Tab is pressed outside it', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    fireEvent.click(trigger);

    trigger.focus(); // focus escaped the dialog (e.g. backdrop click region)
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });

  it('returns focus to the trigger element on close', () => {
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});
