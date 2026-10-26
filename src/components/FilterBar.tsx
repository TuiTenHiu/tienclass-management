import type { ReactNode } from 'react';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Nhóm nút lọc dạng "viên thuốc" */
export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: FilterOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="inline-flex bg-pink-100/70 rounded-btn p-1 gap-1 flex-wrap" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-[11px] font-semibold transition-all ${size === 'sm' ? 'px-2.5 h-7 text-[13px]' : 'px-3.5 h-8 text-[13.5px]'}
            ${value === o.value ? 'bg-white text-pink-700 shadow-card' : 'text-ink-soft hover:text-ink'}`}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1.5 text-[12px] opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** FilterBar: thanh chứa tìm kiếm + bộ lọc + hành động, tự xuống dòng trên màn hình nhỏ */
export function FilterBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-5">
      <div className="flex flex-1 flex-wrap items-center gap-3">{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
