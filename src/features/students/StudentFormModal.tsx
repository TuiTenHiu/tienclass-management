import { useEffect, useState } from 'react';
import { Loader2, Shuffle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/ui';
import { useToast } from '../../components/ToastNotification';
import { ALL_AVATAR_KEYS, ANIMALS, ANIMAL_LABEL, AnimalAvatarSVG, BG_KEYS, AVATAR_BGS, parseAvatarKey, randomAvatarKey } from '../../components/avatars';
import { addStudent, suggestNextCode, updateStudent, ValidationError, type StudentInput } from '../../data/repo';
import type { Student } from '../../types';

const EMPTY: StudentInput = { code: '', fullName: '', birthDate: '', gender: '', avatar: 'cat-pink', parentName: '', parentPhone: '', note: '' };

export function StudentFormModal({ open, onClose, classId, editing }: { open: boolean; onClose: () => void; classId: string; editing: Student | null }) {
  const toast = useToast();
  const [form, setForm] = useState<StudentInput>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [addAnother, setAddAnother] = useState(false);

  const reset = async () => {
    setErrors({});
    if (editing) {
      setForm({
        code: editing.code,
        fullName: editing.fullName,
        birthDate: editing.birthDate ?? '',
        gender: editing.gender,
        avatar: editing.avatar,
        parentName: editing.parentName ?? '',
        parentPhone: editing.parentPhone ?? '',
        note: editing.note ?? '',
      });
    } else {
      setForm({ ...EMPTY, code: await suggestNextCode(), avatar: randomAvatarKey() });
    }
  };

  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const set = <K extends keyof StudentInput>(k: K, v: StudentInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k as string]) setErrors((e) => ({ ...e, [k]: '' }));
  };

  const save = async () => {
    setBusy(true);
    try {
      if (editing) {
        await updateStudent(editing.id, form);
        toast.success('Đã lưu hồ sơ học sinh');
        onClose();
      } else {
        const s = await addStudent(classId, form);
        toast.success(`Đã thêm ${s.fullName}`);
        if (addAnother) await reset();
        else onClose();
      }
    } catch (e) {
      if (e instanceof ValidationError) setErrors(e.fields);
      else toast.error('Không lưu được hồ sơ. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const { animal } = parseAvatarKey(form.avatar);
  const bgKey = form.avatar.split('-')[1] ?? 'pink';

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      size="lg"
      title={editing ? 'Chỉnh sửa hồ sơ học sinh' : 'Thêm học sinh mới'}
      footer={
        <>
          {!editing && (
            <label className="mr-auto flex items-center gap-2 text-[14px] text-ink-soft cursor-pointer">
              <input type="checkbox" className="accent-pink-500 w-4 h-4" checked={addAnother} onChange={(e) => setAddAnother(e.target.checked)} />
              Thêm tiếp học sinh khác
            </label>
          )}
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? 'Lưu thay đổi' : 'Thêm học sinh'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6"
      >
        {/* Chọn avatar */}
        <div className="flex flex-col items-center">
          <AnimalAvatarSVG avatarKey={form.avatar} size={120} />
          <p className="text-[13px] text-ink-soft mt-1">{ANIMAL_LABEL[animal]}</p>
          <div className="grid grid-cols-4 gap-1.5 mt-3">
            {ANIMALS.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => set('avatar', `${a}-${bgKey}`)}
                className={`rounded-xl transition ${a === animal ? 'ring-2 ring-pink-400' : 'opacity-80 hover:opacity-100'}`}
                aria-label={ANIMAL_LABEL[a]}
                data-tip={ANIMAL_LABEL[a]}
              >
                <AnimalAvatarSVG avatarKey={`${a}-${bgKey}`} size={40} />
              </button>
            ))}
          </div>
          <div className="flex gap-1.5 mt-2.5">
            {BG_KEYS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => set('avatar', `${animal}-${b}`)}
                className={`w-6 h-6 rounded-full border-2 ${b === bgKey ? 'border-ink' : 'border-white'}`}
                style={{ background: AVATAR_BGS[b] }}
                aria-label={`Màu nền ${b}`}
              />
            ))}
          </div>
          <button type="button" className="btn-ghost btn-sm mt-2" onClick={() => set('avatar', ALL_AVATAR_KEYS[Math.floor(Math.random() * ALL_AVATAR_KEYS.length)])}>
            <Shuffle className="w-4 h-4" /> Ngẫu nhiên
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 content-start">
          <Field label="Họ và tên" required error={errors.fullName} className="sm:col-span-2">
            <input className={`input ${errors.fullName ? 'input-error' : ''}`} value={form.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="Nguyễn Thị Bông" maxLength={60} />
          </Field>
          <Field label="Mã học sinh" required error={errors.code} hint="Duy nhất trong hệ thống">
            <input className={`input font-mono ${errors.code ? 'input-error' : ''}`} value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={20} />
          </Field>
          <Field label="Ngày sinh" error={errors.birthDate}>
            <input type="date" className={`input ${errors.birthDate ? 'input-error' : ''}`} value={form.birthDate} onChange={(e) => set('birthDate', e.target.value)} />
          </Field>
          <Field label="Giới tính" hint="Không bắt buộc">
            <select className="input" value={form.gender} onChange={(e) => set('gender', e.target.value as StudentInput['gender'])}>
              <option value="">Không ghi</option>
              <option value="male">Nam</option>
              <option value="female">Nữ</option>
              <option value="other">Khác</option>
            </select>
          </Field>
          <div className="hidden sm:block" />
          <Field label="Họ tên phụ huynh" hint="Chỉ nhập khi cần liên hệ">
            <input className="input" value={form.parentName} onChange={(e) => set('parentName', e.target.value)} maxLength={60} />
          </Field>
          <Field label="SĐT phụ huynh" error={errors.parentPhone}>
            <input className={`input ${errors.parentPhone ? 'input-error' : ''}`} value={form.parentPhone} onChange={(e) => set('parentPhone', e.target.value)} inputMode="tel" placeholder="09xx xxx xxx" maxLength={15} />
          </Field>
          <Field label="Ghi chú chủ nhiệm" error={errors.note} className="sm:col-span-2">
            <textarea className="input" rows={3} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Sức khỏe, sở thích, lưu ý riêng..." maxLength={1000} />
          </Field>
        </div>
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
