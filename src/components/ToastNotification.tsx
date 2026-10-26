import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X, Undo2 } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (msg: string, action?: ToastItem['action']) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast phải dùng trong ToastProvider');
  return ctx;
}

/** ToastNotification: thông báo nhỏ góc màn hình, có thể kèm nút hoàn tác */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastItem['action']) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, kind, message, action }]);
      setTimeout(() => remove(id), action ? 6500 : 3800);
    },
    [remove],
  );

  const api = useRef<ToastApi>({
    success: (m, a) => push('success', m, a),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  });
  api.current.success = (m, a) => push('success', m, a);
  api.current.error = (m) => push('error', m);
  api.current.info = (m) => push('info', m);

  const icon = { success: CheckCircle2, error: AlertCircle, info: Info };
  const tone = {
    success: 'border-mint-dark/30 [&_.ic]:text-mint-dark',
    error: 'border-danger/40 [&_.ic]:text-danger',
    info: 'border-sky-dark/30 [&_.ic]:text-sky-dark',
  };

  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div className="fixed z-[100] bottom-4 right-4 left-4 sm:left-auto flex flex-col gap-2 items-end no-print" role="status" aria-live="polite">
        {items.map((t) => {
          const Ic = icon[t.kind];
          return (
            <div key={t.id} className={`animate-slideIn bg-white border ${tone[t.kind]} shadow-soft rounded-2xl pl-3.5 pr-2 py-2.5 flex items-center gap-3 max-w-md w-full sm:w-auto`}>
              <Ic className="ic w-5 h-5 shrink-0" />
              <span className="text-[14px] text-ink flex-1">{t.message}</span>
              {t.action && (
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    t.action!.onClick();
                    remove(t.id);
                  }}
                >
                  <Undo2 className="w-4 h-4" />
                  {t.action.label}
                </button>
              )}
              <button className="icon-btn w-8 h-8" onClick={() => remove(t.id)} aria-label="Đóng thông báo">
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
