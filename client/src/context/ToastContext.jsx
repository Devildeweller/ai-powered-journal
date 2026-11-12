import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

/** Small, self-dismissing confirmations ("Entry saved") in the corner of the screen. */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message, kind = 'success') => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-2), { id, message, kind }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({ success: (message) => show(message, 'success'), error: (message) => show(message, 'error') }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6"
        aria-live="polite"
      >
        {toasts.map((toast) => {
          const Icon = toast.kind === 'error' ? CircleAlert : CheckCircle2;
          return (
            <div
              key={toast.id}
              role={toast.kind === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex max-w-sm animate-rise items-start gap-2.5 rounded-xl border border-line bg-surface py-2.5 pl-3 pr-2 text-sm shadow-pop"
            >
              <Icon className={`mt-0.5 size-4 shrink-0 ${toast.kind === 'error' ? 'text-danger' : 'text-success'}`} aria-hidden />
              <span className="text-ink">{toast.message}</span>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded-md p-0.5 text-ink-3 hover:bg-sunken hover:text-ink"
                aria-label="Dismiss"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
