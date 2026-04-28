import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { cx } from '../lib/format.js';

export function Modal({ open, onClose, title, subtitle, children, size = 'md' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-xl',
    lg: 'max-w-3xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className={cx(
        'relative w-full rounded-xl border border-ink-700 bg-ink-900 shadow-2xl',
        sizes[size]
      )}>
        <div className="flex items-start justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-ink-300">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          >
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function ModalFooter({ children }) {
  return <div className="-mx-5 -mb-5 mt-5 flex items-center justify-end gap-2 border-t border-ink-700 bg-ink-900/60 px-5 py-3">{children}</div>;
}
