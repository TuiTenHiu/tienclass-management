import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { Student } from '../types';
import { StudentAvatar } from './StudentAvatar';

/** Thẻ học sinh trong chế độ lưới – luôn hiển thị rõ họ tên */
export function StudentCard({
  student,
  selected,
  onClick,
  badge,
  footer,
  dim,
  selectable,
}: {
  student: Student;
  selected?: boolean;
  onClick?: () => void;
  badge?: ReactNode;
  footer?: ReactNode;
  dim?: boolean;
  selectable?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative card p-3 pt-4 flex flex-col items-center text-center transition-all duration-150 hover:-translate-y-0.5 hover:shadow-soft
        ${selected ? 'border-pink-400 ring-4 ring-pink-100 bg-pink-50' : ''} ${dim ? 'opacity-55' : ''}`}
    >
      {selectable && (
        <span
          className={`absolute top-2 left-2 w-6 h-6 rounded-lg border-2 inline-flex items-center justify-center transition
          ${selected ? 'bg-pink-500 border-pink-500 text-white' : 'bg-white border-pink-200 text-transparent group-hover:border-pink-300'}`}
        >
          <Check className="w-4 h-4" strokeWidth={3} />
        </span>
      )}
      {badge && <span className="absolute top-2 right-2">{badge}</span>}
      <StudentAvatar student={student} size={64} />
      <span className="mt-2 font-semibold text-[14.5px] leading-snug text-ink line-clamp-2 min-h-[2.5em]">{student.fullName}</span>
      <span className="text-[12px] text-ink-soft">{student.code}</span>
      {footer && <div className="mt-2 w-full">{footer}</div>}
    </button>
  );
}
