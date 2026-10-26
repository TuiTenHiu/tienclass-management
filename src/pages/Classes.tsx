import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Pencil, Trash2, Users, CheckCircle2, CalendarRange, UserRound, StickyNote, Loader2 } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { db } from '../data/db';
import { CLASS_COLORS, createClass, deleteClass, updateClass, ValidationError, type ClassInput } from '../data/repo';
import { PageHeader, Field } from '../components/ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState, LoadingState } from '../components/States';
import { useToast } from '../components/ToastNotification';
import { schoolYearOf } from '../lib/utils';
import type { ClassRoom } from '../types';

function yearOptions() {
  const y = Number(schoolYearOf().slice(0, 4));
  return [y - 1, y, y + 1].map((a) => `${a}-${a + 1}`);
}

export function ClassFormModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: ClassRoom | null }) {
  const { settings, setCurrentClassId } = useApp();
  const toast = useToast();
  const [form, setForm] = useState<ClassInput>({ name: '', schoolYear: schoolYearOf(), teacherName: '', subject: '', note: '', color: CLASS_COLORS[0] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      editing
        ? { name: editing.name, schoolYear: editing.schoolYear, teacherName: editing.teacherName, subject: editing.subject ?? '', note: editing.note ?? '', color: editing.color }
        : {
            name: '',
            schoolYear: schoolYearOf(),
            teacherName: `${settings.teacherTitle === 'cô' ? 'Cô' : 'Thầy'} ${settings.teacherName}`,
            subject: 'Chủ nhiệm',
            note: '',
            color: CLASS_COLORS[Math.floor(Math.random() * CLASS_COLORS.length)],
          },
    );
  }, [open, editing, settings]);

  const save = async () => {
    setBusy(true);
    try {
      if (editing) {
        await updateClass(editing.id, form);
        toast.success('Đã cập nhật thông tin lớp');
      } else {
        const c = await createClass(form);
        setCurrentClassId(c.id);
        toast.success(`Đã tạo lớp ${c.name}. Lớp mới đã được chọn!`);
      }
      onClose();
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields);
      else toast.error('Không lưu được lớp học. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof ClassInput, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      title={editing ? 'Chỉnh sửa lớp học' : 'Tạo lớp học mới'}
      subtitle="Mỗi lớp có danh sách học sinh, điểm danh và thi đua riêng."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? 'Lưu thay đổi' : 'Tạo lớp'}
          </button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 sm:grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Tên lớp" required error={errors.name} className="sm:col-span-2">
          <input className={`input ${errors.name ? 'input-error' : ''}`} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ví dụ: 3A1" maxLength={40} />
        </Field>
        <Field label="Năm học" required error={errors.schoolYear}>
          <input className={`input ${errors.schoolYear ? 'input-error' : ''}`} list="school-years" value={form.schoolYear} onChange={(e) => set('schoolYear', e.target.value)} placeholder="2026-2027" />
          <datalist id="school-years">
            {yearOptions().map((y) => (
              <option key={y} value={y} />
            ))}
          </datalist>
        </Field>
        <Field label="Vai trò / môn học">
          <input className="input" value={form.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Chủ nhiệm, Tiếng Anh..." maxLength={40} />
        </Field>
        <Field label="Giáo viên phụ trách" error={errors.teacherName} className="sm:col-span-2">
          <input className="input" value={form.teacherName} onChange={(e) => set('teacherName', e.target.value)} maxLength={60} />
        </Field>
        <Field label="Ghi chú lớp học" error={errors.note} className="sm:col-span-2">
          <textarea className="input" rows={3} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Lịch học, phòng học, lưu ý chung..." maxLength={1000} />
        </Field>
        <div className="sm:col-span-2">
          <span className="label">Màu nhận diện</span>
          <div className="flex gap-2">
            {CLASS_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => set('color', c)}
                className={`w-9 h-9 rounded-xl border-2 transition ${form.color === c ? 'border-ink scale-110' : 'border-transparent'}`}
                style={{ background: c }}
                aria-label={`Chọn màu ${c}`}
              />
            ))}
          </div>
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

export default function ClassesPage() {
  const { ready, classes, currentClass, setCurrentClassId } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClassRoom | null>(null);
  const [deleting, setDeleting] = useState<ClassRoom | null>(null);

  const counts = useLiveQuery(async () => {
    const all = await db.students.toArray();
    const m = new Map<string, { active: number; archived: number }>();
    all.forEach((s) => {
      const c = m.get(s.classId) ?? { active: 0, archived: 0 };
      c[s.status] += 1;
      m.set(s.classId, c);
    });
    return m;
  }, []);

  useEffect(() => {
    if (params.get('new') === '1') {
      setEditing(null);
      setFormOpen(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  if (!ready) return <LoadingState />;

  return (
    <div className="animate-fadeIn">
      <PageHeader
        title="Lớp học của tôi"
        description="Tạo, chỉnh sửa và chuyển đổi giữa các lớp. Dữ liệu mỗi lớp hoàn toàn độc lập."
        actions={
          <button
            className="btn-primary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="w-[18px] h-[18px]" /> Tạo lớp mới
          </button>
        }
      />

      {classes.length === 0 ? (
        <div className="card">
          <EmptyState
            illustration="rainbow"
            title="Chưa có lớp học nào"
            description="Tạo lớp đầu tiên để bắt đầu hành trình lớp học hạnh phúc nhé!"
            action={
              <button className="btn-primary" onClick={() => setFormOpen(true)}>
                <Plus className="w-4 h-4" /> Tạo lớp mới
              </button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {classes.map((c) => {
            const isCur = c.id === currentClass?.id;
            const cnt = counts?.get(c.id);
            return (
              <article key={c.id} className={`card overflow-hidden flex flex-col ${isCur ? 'ring-2 ring-pink-300' : ''}`}>
                <div className="h-20 relative" style={{ background: `linear-gradient(120deg, ${c.color}, #FFF6FA)` }}>
                  <svg className="absolute right-4 top-3 opacity-80" width="56" height="56" viewBox="0 0 64 64" aria-hidden="true">
                    <path d="M32 8 l6 13 14 2 -10 10 2.4 14 -12.4 -6.6 -12.4 6.6 2.4 -14 -10 -10 14 -2z" fill="#fff" />
                  </svg>
                  {isCur && (
                    <span className="absolute left-4 top-3 chip bg-white text-pink-600">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Đang chọn
                    </span>
                  )}
                </div>
                <div className="p-5 pt-3 flex-1 flex flex-col">
                  <h3 className="font-display font-black text-2xl">{c.name}</h3>
                  <ul className="mt-2 space-y-1.5 text-[14px] text-ink-soft">
                    <li className="flex items-center gap-2">
                      <CalendarRange className="w-4 h-4 text-pink-400" /> Năm học {c.schoolYear}
                      {c.subject && <span className="chip bg-lavender/60 text-lavender-dark ml-1">{c.subject}</span>}
                    </li>
                    <li className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-pink-400" /> Sĩ số: <b className="text-ink">{cnt?.active ?? 0}</b>
                      {cnt?.archived ? <span className="text-[12.5px]">({cnt.archived} lưu trữ)</span> : null}
                    </li>
                    <li className="flex items-center gap-2">
                      <UserRound className="w-4 h-4 text-pink-400" /> {c.teacherName || 'Chưa có giáo viên phụ trách'}
                    </li>
                    {c.note && (
                      <li className="flex items-start gap-2">
                        <StickyNote className="w-4 h-4 text-pink-400 mt-0.5 shrink-0" />
                        <span className="line-clamp-2">{c.note}</span>
                      </li>
                    )}
                  </ul>
                  <div className="mt-auto pt-4 flex items-center gap-2">
                    {isCur ? (
                      <button className="btn-secondary flex-1" onClick={() => navigate('/students')}>
                        Xem học sinh
                      </button>
                    ) : (
                      <button
                        className="btn-primary flex-1"
                        onClick={() => {
                          setCurrentClassId(c.id);
                          toast.info(`Đã chuyển sang lớp ${c.name}`);
                        }}
                      >
                        Chọn lớp này
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      data-tip="Chỉnh sửa lớp"
                      aria-label="Chỉnh sửa lớp"
                      onClick={() => {
                        setEditing(c);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="w-[18px] h-[18px]" />
                    </button>
                    <button className="icon-btn hover:!text-danger hover:!bg-danger-soft" data-tip="Xóa lớp" aria-label="Xóa lớp" onClick={() => setDeleting(c)}>
                      <Trash2 className="w-[18px] h-[18px]" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ClassFormModal open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      <ConfirmDialog
        open={!!deleting}
        danger
        title="Xóa lớp học?"
        requireText={deleting?.name}
        confirmLabel="Xóa vĩnh viễn"
        message={
          <>
            Toàn bộ học sinh, điểm danh, điểm thi đua và nhận xét của lớp <b>{deleting?.name}</b> sẽ bị xóa và <b>không thể khôi phục</b>.
            <br />
            <span className="text-ink-soft">Gợi ý: vào Cài đặt → Sao lưu dữ liệu trước khi xóa.</span>
          </>
        }
        onConfirm={async () => {
          if (!deleting) return;
          await deleteClass(deleting.id);
          toast.success(`Đã xóa lớp ${deleting.name}`);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
