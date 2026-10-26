import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Illustration, type IllustrationName } from './illustrations';

export function EmptyState({
  title,
  description,
  action,
  illustration = 'bunny-star',
  compact,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  illustration?: IllustrationName;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'py-6' : 'py-12'} px-4 animate-fadeIn`}>
      <Illustration name={illustration} size={compact ? 100 : 150} />
      <h3 className="font-display font-extrabold text-lg mt-3">{title}</h3>
      {description && <p className="text-ink-soft text-[14.5px] mt-1 max-w-md">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap gap-2 justify-center">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Đang tải dữ liệu...', compact }: { label?: string; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center ${compact ? 'py-6' : 'py-16'} text-ink-soft gap-3`} role="status">
      <div className="relative">
        <span className="absolute inset-0 rounded-full bg-pink-200 animate-ping opacity-40" />
        <span className="relative w-12 h-12 rounded-full bg-pink-100 inline-flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-pink-500 animate-spin" />
        </span>
      </div>
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card card-pad border-danger/30 bg-danger-soft/40 text-center">
      <p className="font-semibold text-danger">Có lỗi xảy ra</p>
      <p className="text-sm text-ink-soft mt-1">{message}</p>
      {onRetry && (
        <button className="btn-outline btn-sm mt-3" onClick={onRetry}>
          Thử lại
        </button>
      )}
    </div>
  );
}
