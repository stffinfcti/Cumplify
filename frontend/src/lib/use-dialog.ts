'use client';

import { useEffect, useRef, type HTMLAttributes, type RefObject } from 'react';

/**
 * useDialog — WAI-ARIA dialog mechanics shared by FormDrawer and AskOverlay
 * (FE-10): Escape closes, Tab/Shift-Tab trap focus inside the dialog, focus
 * lands on the first focusable element on open, and returns to the trigger
 * element on close.
 *
 * Spread `dialogProps` onto the dialog element and attach `dialogRef`.
 * Accessible NAME still comes from the caller's aria-label (localized).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  // The selector excludes disabled/tabIndex=-1; `hidden` is the only other
  // cheap structural exclusion (CSS-level visibility is intentionally not
  // probed — dialogs hide their content by unmounting, not styling).
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden'),
  );
}

export function useDialog(
  open: boolean,
  onClose: () => void,
): {
  dialogRef: RefObject<HTMLElement>;
  dialogProps: Pick<HTMLAttributes<HTMLElement>, 'role' | 'aria-modal' | 'tabIndex'>;
} {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const node = dialogRef.current;

    // Remember the trigger to return focus on close
    returnFocusRef.current = document.activeElement as HTMLElement | null;

    // Initial focus: first focusable element, else the dialog itself
    const first = getFocusable(node)[0] ?? node;
    first?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = getFocusable(node);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      // Wrap edges: Shift-Tab on first → last; Tab on last → first. Focus
      // outside the dialog (backdrop click region) is pulled back in.
      if (e.shiftKey && (active === firstEl || !node.contains(active))) {
        lastEl.focus();
        e.preventDefault();
      } else if (!e.shiftKey && (active === lastEl || !node.contains(active))) {
        firstEl.focus();
        e.preventDefault();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, [open]);

  return {
    dialogRef,
    dialogProps: { role: 'dialog', 'aria-modal': true, tabIndex: -1 },
  };
}
