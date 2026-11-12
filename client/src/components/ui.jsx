import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';

/** Joins class names, skipping falsy ones. */
export const cx = (...parts) => parts.filter(Boolean).join(' ');

export function Spinner({ className = 'size-4' }) {
  return <LoaderCircle className={cx('animate-spin', className)} aria-hidden />;
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-sunken',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink',
  danger: 'bg-danger text-white hover:opacity-90 shadow-sm dark:text-paper',
  dangerGhost: 'text-danger hover:bg-danger-soft',
};
const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 rounded-lg px-2.5 text-[13px]',
  md: 'h-10 gap-2 rounded-xl px-4 text-sm',
  icon: 'size-9 rounded-lg',
};

const buttonClasses = (variant, size, className) =>
  cx(
    'inline-flex shrink-0 select-none items-center justify-center font-medium transition-colors disabled:opacity-55',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  );

export function Button({ variant = 'primary', size = 'md', loading = false, className, children, disabled, type = 'button', ...props }) {
  return (
    <button type={type} disabled={disabled || loading} className={buttonClasses(variant, size, className)} {...props}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** A navigation link that looks like a button (a <button> inside an <a> is invalid HTML). */
export function ButtonLink({ variant = 'primary', size = 'md', className, ...props }) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}

const FIELD_CLASS =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 text-ink placeholder:text-ink-3 transition-colors hover:border-ink-3 focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/25 disabled:opacity-60';

/** Labelled text input with an inline validation message. */
export function Field({ label, error, hint, className, inputClassName, ...props }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? `${id}-help` : undefined}
        className={cx(FIELD_CLASS, 'h-11', error && 'border-danger', inputClassName)}
        {...props}
      />
      {(error || hint) && (
        <p id={`${id}-help`} className={cx('mt-1.5 text-[13px]', error ? 'text-danger' : 'text-ink-3')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function TextInput({ className, ...props }) {
  return <input className={cx(FIELD_CLASS, 'h-10', className)} {...props} />;
}

export function Select({ className, children, ...props }) {
  return (
    <select className={cx(FIELD_CLASS, 'h-10 pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export function Card({ className, as: Tag = 'div', ...props }) {
  return <Tag className={cx('rounded-2xl border border-line bg-surface shadow-card', className)} {...props} />;
}

export function Tag({ children, active = false, onClick, className }) {
  const classes = cx(
    'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium transition-colors',
    active ? 'bg-accent text-on-accent' : 'bg-sunken text-ink-2',
    onClick && !active && 'hover:bg-line',
    className,
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-pressed={active} className={classes}>
      {children}
    </button>
  ) : (
    <span className={classes}>{children}</span>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-serif text-[28px] font-medium leading-tight tracking-tight text-ink md:text-[32px]">{title}</h1>
        {description && <p className="mt-1 max-w-xl text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center">
      {Icon && (
        <div className="mb-4 grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <h2 className="font-serif text-xl font-medium text-ink">{title}</h2>
      {children && <p className="mt-1.5 max-w-sm text-ink-2">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, onRetry }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Try again
        </button>
      )}
    </div>
  );
}

/** Placeholder block shown while content loads. */
export function Skeleton({ className }) {
  return <div className={cx('animate-pulse rounded-lg bg-sunken', className)} aria-hidden />;
}

/** Modal dialog built on the native <dialog>, which handles focus trapping and Escape. */
export function Dialog({ open, onClose, title, children, footer }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-[min(92vw,26rem)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-black/40 open:animate-rise"
    >
      {open && (
        <div className="p-5">
          <div className="mb-2 flex items-start justify-between gap-4">
            <h2 className="font-serif text-xl font-medium">{title}</h2>
            <button type="button" onClick={onClose} className="-mr-1 -mt-1 rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
          <div className="text-ink-2">{children}</div>
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Delete', loading = false }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
