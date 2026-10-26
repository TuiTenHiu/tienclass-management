import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

const TONES = {
  pink: { bg: 'bg-pink-100', fg: 'text-pink-600' },
  lavender: { bg: 'bg-lavender', fg: 'text-lavender-dark' },
  cream: { bg: 'bg-cream', fg: 'text-cream-dark' },
  mint: { bg: 'bg-mint', fg: 'text-mint-dark' },
  sky: { bg: 'bg-sky', fg: 'text-sky-dark' },
};
export type Tone = keyof typeof TONES;

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'pink',
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
}) {
  const t = TONES[tone];
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={`card p-4 md:p-5 flex items-center gap-4 text-left w-full ${onClick ? 'hover:-translate-y-0.5 hover:shadow-soft transition-all cursor-pointer' : ''}`}
    >
      <span className={`w-12 h-12 md:w-14 md:h-14 rounded-2xl ${t.bg} ${t.fg} inline-flex items-center justify-center shrink-0`}>
        <Icon className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.2} />
      </span>
      <span className="min-w-0">
        <span className="block text-ink-soft text-[13.5px] font-medium">{label}</span>
        <span className="block font-display font-extrabold text-2xl md:text-[28px] leading-tight text-ink">{value}</span>
        {hint && <span className="block text-[12.5px] text-ink-soft mt-0.5 truncate">{hint}</span>}
      </span>
    </Comp>
  );
}
