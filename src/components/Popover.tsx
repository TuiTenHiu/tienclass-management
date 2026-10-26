import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Popover đơn giản: tự đóng khi bấm ra ngoài hoặc nhấn Esc */
export function Popover({
  trigger,
  children,
  align = 'right',
  width = 'w-72',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={`absolute z-[60] mt-2 ${align === 'right' ? 'right-0' : 'left-0'} ${width} max-w-[calc(100vw-1.5rem)] bg-white rounded-2xl border border-pink-100 shadow-soft p-2 animate-fadeIn`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
