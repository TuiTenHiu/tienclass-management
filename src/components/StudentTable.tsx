import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { Student } from '../types';
import { StudentAvatar } from './StudentAvatar';
import { formatDateVN } from '../lib/utils';

const GENDER: Record<string, string> = { male: 'Nam', female: 'Nữ', other: 'Khác', '': '—' };

export function StudentTable({
  students,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  className,
  rowActions,
}: {
  students: Student[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onOpen: (s: Student) => void;
  className?: (id: string) => string;
  rowActions?: (s: Student) => ReactNode;
}) {
  const allSel = students.length > 0 && students.every((s) => selected.has(s.id));
  const Box = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className={`w-5 h-5 rounded-md border-2 inline-flex items-center justify-center transition ${on ? 'bg-pink-500 border-pink-500 text-white' : 'bg-white border-pink-200 text-transparent hover:border-pink-400'}`}
    >
      <Check className="w-3.5 h-3.5" strokeWidth={3} />
    </button>
  );
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto scroll-soft p-2">
        <table className="table-base min-w-[760px]">
          <thead>
            <tr>
              <th className="w-10">
                <Box on={allSel} onClick={onToggleAll} label="Chọn tất cả" />
              </th>
              <th className="w-14">STT</th>
              <th>Học sinh</th>
              <th>Mã HS</th>
              <th>Ngày sinh</th>
              <th>Giới tính</th>
              {className && <th>Lớp</th>}
              <th>Phụ huynh</th>
              <th className="text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s, i) => (
              <tr key={s.id} className={`cursor-pointer ${selected.has(s.id) ? '!bg-pink-50' : ''}`} onClick={() => onOpen(s)}>
                <td>
                  <Box on={selected.has(s.id)} onClick={() => onToggle(s.id)} label={`Chọn ${s.fullName}`} />
                </td>
                <td className="text-ink-soft">{i + 1}</td>
                <td>
                  <div className="flex items-center gap-3">
                    <StudentAvatar student={s} size={38} />
                    <div>
                      <div className="font-semibold">{s.fullName}</div>
                      {s.status === 'archived' && <span className="chip bg-cream text-cream-dark !text-[11px]">Lưu trữ</span>}
                    </div>
                  </div>
                </td>
                <td className="font-mono text-[13.5px]">{s.code}</td>
                <td>{s.birthDate ? formatDateVN(s.birthDate) : '—'}</td>
                <td>{GENDER[s.gender] ?? '—'}</td>
                {className && <td>{className(s.classId)}</td>}
                <td className="text-[13.5px]">
                  {s.parentName || s.parentPhone ? (
                    <>
                      <div>{s.parentName || '—'}</div>
                      <div className="text-ink-soft">{s.parentPhone}</div>
                    </>
                  ) : (
                    <span className="text-ink-soft">—</span>
                  )}
                </td>
                <td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex gap-1">{rowActions?.(s)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
