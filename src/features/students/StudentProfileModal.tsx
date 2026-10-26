import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, Cake, Phone, UserRound, StickyNote, Star, CalendarCheck, MessageSquareHeart } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { StudentAvatar } from '../../components/StudentAvatar';
import { db } from '../../data/db';
import { summarizeAttendance } from '../../lib/stats';
import { formatDateTimeVN, formatDateVN } from '../../lib/utils';
import type { Student } from '../../types';

/** Hồ sơ học sinh – chỉ đọc, không thay đổi dữ liệu khi mở */
export function StudentProfileModal({ student, onClose, onEdit, className }: { student: Student | null; onClose: () => void; onEdit: (s: Student) => void; className: string }) {
  const data = useLiveQuery(async () => {
    if (!student) return null;
    const [txs, att, comments] = await Promise.all([
      db.transactions.where('studentId').equals(student.id).toArray(),
      db.attendance.where('studentId').equals(student.id).toArray(),
      db.comments.where('studentId').equals(student.id).toArray(),
    ]);
    const inClass = txs.filter((t) => t.classId === student.classId && !t.undone).sort((a, b) => b.createdAt - a.createdAt);
    return {
      points: inClass.reduce((s, t) => s + t.delta, 0),
      recentTx: inClass.slice(0, 5),
      att: summarizeAttendance(att.filter((a) => a.classId === student.classId)),
      comments: comments.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3),
    };
  }, [student?.id, student?.classId]);

  if (!student) return null;
  const G: Record<string, string> = { male: 'Nam', female: 'Nữ', other: 'Khác', '': 'Không ghi' };

  return (
    <Modal
      open={!!student}
      onClose={onClose}
      size="lg"
      title="Hồ sơ học sinh"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Đóng
          </button>
          <button className="btn-primary" onClick={() => onEdit(student)}>
            <Pencil className="w-4 h-4" /> Chỉnh sửa
          </button>
        </>
      }
    >
      <div className="flex flex-col sm:flex-row gap-5 items-center sm:items-start">
        <StudentAvatar student={student} size={104} />
        <div className="flex-1 text-center sm:text-left">
          <h3 className="font-display font-black text-2xl">{student.fullName}</h3>
          <div className="flex flex-wrap gap-2 mt-1 justify-center sm:justify-start">
            <span className="chip bg-pink-100 text-pink-700 font-mono">{student.code}</span>
            <span className="chip bg-lavender/60 text-lavender-dark">Lớp {className}</span>
            {student.status === 'archived' && <span className="chip bg-cream text-cream-dark">Đang lưu trữ</span>}
          </div>
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-[14px] text-ink-soft text-left">
            <li className="flex items-center gap-2">
              <Cake className="w-4 h-4 text-pink-400" /> {student.birthDate ? formatDateVN(student.birthDate) : 'Chưa có ngày sinh'}
            </li>
            <li className="flex items-center gap-2">
              <UserRound className="w-4 h-4 text-pink-400" /> Giới tính: {G[student.gender]}
            </li>
            <li className="flex items-center gap-2">
              <UserRound className="w-4 h-4 text-pink-400" /> PH: {student.parentName || '—'}
            </li>
            <li className="flex items-center gap-2">
              <Phone className="w-4 h-4 text-pink-400" /> {student.parentPhone || '—'}
            </li>
          </ul>
        </div>
      </div>
      {student.note && (
        <div className="mt-4 rounded-2xl bg-cream/40 p-3 text-[14px] flex gap-2">
          <StickyNote className="w-4 h-4 text-cream-dark mt-0.5 shrink-0" />
          <span className="whitespace-pre-line">{student.note}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
        <div className="rounded-2xl bg-pink-50 p-3">
          <p className="text-[12.5px] text-ink-soft flex items-center gap-1">
            <Star className="w-3.5 h-3.5" /> Tổng điểm thi đua
          </p>
          <p className="font-display font-black text-2xl">{data ? data.points : '…'}</p>
        </div>
        <div className="rounded-2xl bg-mint/50 p-3">
          <p className="text-[12.5px] text-ink-soft flex items-center gap-1">
            <CalendarCheck className="w-3.5 h-3.5" /> Chuyên cần
          </p>
          <p className="font-display font-black text-2xl">{data?.att.rate != null ? `${Math.round(data.att.rate * 100)}%` : '—'}</p>
          {data && data.att.total > 0 && (
            <p className="text-[12px] text-ink-soft">
              Vắng {data.att.excused + data.att.unexcused} · Muộn {data.att.late}
            </p>
          )}
        </div>
        <div className="rounded-2xl bg-lavender/40 p-3">
          <p className="text-[12.5px] text-ink-soft flex items-center gap-1">
            <MessageSquareHeart className="w-3.5 h-3.5" /> Nhận xét gần nhất
          </p>
          <p className="text-[13.5px] line-clamp-2">{data?.comments[0]?.content ?? 'Chưa có nhận xét'}</p>
        </div>
      </div>

      {data && data.recentTx.length > 0 && (
        <div className="mt-4">
          <p className="font-semibold text-[14px] mb-2">Điểm thi đua gần đây</p>
          <ul className="space-y-1.5">
            {data.recentTx.map((t) => (
              <li key={t.id} className="flex items-center gap-3 text-[14px]">
                <span className={`chip ${t.delta > 0 ? 'bg-mint text-mint-dark' : 'bg-danger-soft text-danger'}`}>{t.delta > 0 ? `+${t.delta}` : t.delta}</span>
                <span className="flex-1">{t.criterionName}</span>
                <span className="text-[12px] text-ink-soft">{formatDateTimeVN(t.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
