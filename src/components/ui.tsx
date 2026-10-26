import type { ReactNode } from 'react';

export function Field({
  label,
  error,
  hint,
  required,
  children,
  className = '',
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label">
        {label}
        {required && <span className="text-pink-500 ml-0.5">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-danger mt-1">{error}</p>
      ) : hint ? (
        <p className="text-[12.5px] text-ink-soft mt-1">{hint}</p>
      ) : null}
    </div>
  );
}

export function Card({ title, action, children, className = '', icon }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <section className={`card card-pad ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="section-title flex items-center gap-2">
            {icon}
            {title}
          </h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="text-ink-soft mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-pink-500' : 'bg-pink-200'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
      <span>
        <span className="block text-[14.5px] font-semibold text-ink">{label}</span>
        {hint && <span className="block text-[12.5px] text-ink-soft">{hint}</span>}
      </span>
    </label>
  );
}
