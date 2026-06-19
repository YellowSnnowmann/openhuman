import { useEffect, useRef, useState } from 'react';

export interface FilterOption {
  value: string;
  label: string;
}

interface FeedbackFilterSelectProps {
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  /** Accessible label for the trigger button. */
  ariaLabel: string;
}

/**
 * Lightweight styled dropdown for the board filters. Native `<select>` is hard
 * to theme consistently across platforms, so this renders a button + popover
 * with the app's tokens, closing on outside-click or Escape.
 */
export default function FeedbackFilterSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: FeedbackFilterSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = options.find(option => option.value === value) ?? options[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(prev => !prev)}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
          open
            ? 'border-primary-500/50 bg-white text-neutral-900 ring-2 ring-primary-500/20 dark:bg-neutral-800 dark:text-neutral-100'
            : 'border-neutral-200 bg-neutral-50 text-neutral-600 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:text-neutral-100'
        }`}>
        {current?.label}
        <svg
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1.5 min-w-[10rem] animate-scale-in overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-medium dark:border-neutral-700 dark:bg-neutral-800">
          {options.map(option => {
            const selected = option.value === value;
            return (
              <li key={option.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? 'bg-primary-500/10 font-medium text-primary-600 dark:text-primary-400'
                      : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/[0.06]'
                  }`}>
                  {option.label}
                  {selected && (
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2.2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
