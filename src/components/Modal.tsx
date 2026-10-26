import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Không cho đóng khi bấm nền (ví dụ đang lưu) */
  locked?: boolean;
}

const SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', locked }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // focus phần tử đầu tiên có thể nhập
    setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button[data-autofocus]');
      el?.focus();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, locked, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4 no-print" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px] animate-fadeIn" onClick={() => !locked && onClose()} />
      <div
        ref={panelRef}
        className={`relative w-full ${SIZES[size]} bg-white rounded-t-[24px] sm:rounded-[24px] shadow-soft animate-pop flex flex-col max-h-[92vh]`}
      >
        <div className="flex items-start gap-3 px-6 pt-5 pb-3">
          <div className="flex-1 min-w-0">
            <h2 className="font-display font-extrabold text-xl text-ink">{title}</h2>
            {subtitle && <p className="text-ink-soft text-sm mt-0.5">{subtitle}</p>}
          </div>
          <button className="icon-btn -mr-2 -mt-1" onClick={onClose} disabled={locked} aria-label="Đóng">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 pb-4 overflow-y-auto scroll-soft flex-1">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-pink-100 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
