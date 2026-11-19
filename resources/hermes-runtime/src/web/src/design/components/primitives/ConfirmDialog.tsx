// ConfirmDialog — KnockDesk v2 primitive
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  variant?: 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

function FocusTrap({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement;
    const container = containerRef.current;
    if (!container) return;

    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    container.addEventListener('keydown', handleTab);
    firstElement?.focus();

    return () => {
      container.removeEventListener('keydown', handleTab);
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  return React.createElement('div', { ref: containerRef }, children);
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  variant = 'secondary',
  size = 'md',
}: ConfirmDialogProps) {
  if (!open) return null;

  const overlay = React.createElement('div', {
    className: 'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
    onClick: onCancel,
    'aria-hidden': 'true',
  });

  const content = React.createElement(
    FocusTrap,
    null,
    React.createElement(
      'div',
      {
        className: 'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 px-4',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'confirm-dialog-title',
        'aria-describedby': description ? 'confirm-dialog-description' : undefined,
      },
      React.createElement(
        'div',
        {
          className: 'bg-background-base border border-border-default rounded-xl shadow-xl overflow-hidden',
          style: {
            background: 'var(--kd-color-bg-secondary)',
            borderColor: 'var(--kd-color-border-default)',
          },
        },
        React.createElement(
          'div',
          { className: 'px-6 py-4 border-b border-border-default' },
          React.createElement('h2', { id: 'confirm-dialog-title', className: 'text-lg font-semibold text-text-primary' }, title),
          description && React.createElement('p', { id: 'confirm-dialog-description', className: 'mt-2 text-sm text-text-secondary' }, description),
        ),
        React.createElement(
          'div',
          { className: 'px-6 py-4 flex justify-end gap-3' },
          React.createElement(Button, { variant: 'ghost', size, onClick: onCancel, disabled: loading }, cancelLabel),
          React.createElement(Button, { variant, size, onClick: onConfirm, loading, disabled: loading }, confirmLabel),
        ),
      ),
    ),
  );

  return createPortal(React.createElement(React.Fragment, null, overlay, content), document.body);
}

export default ConfirmDialog;