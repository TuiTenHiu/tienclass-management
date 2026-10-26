import { useMemo, useState } from 'react';
import {
  Star,
  Award,
  History,
  Settings2,
  Check,
  Undo2,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useCriteria, useTransactions } from '../state/hooks';
import { PageHeader, Field } from '../components/ui';
import { StudentAvatar } from '../components/StudentAvatar';
import { EmptyState, LoadingState } from '../components/States';
import { Modal } from '../components/Modal';
import { useToast } from '../components/ToastNotification';
import {
  awardPoints,
  saveCriterion,
  undoTransaction,
  undoBatch,
} from '../data/repo';
import { pointsByStudent } from '../lib/stats';
import { formatDateTimeVN } from '../lib/utils';
import type { Criterion } from '../types';

export default function PointsPage() {
  const { currentClass } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const criteria = useCriteria(classId);
  const txs = useTransactions(classId);

  // Chọn học sinh để cộng/trừ điểm
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Modal quản lý tiêu chí
  const [critModalOpen, setCritModalOpen] = useState(false);
  const [editingCrit, setEditingCrit] = useState<Criterion | null>(null);
  const [critForm, setCritForm] = useState({ name: '', points: 2, type: 'reward' as 'reward' | 'penalty', icon: 'star' });

  // Tab xem (Chấm điểm vs Lịch sử)
  const [tab, setTab] = useState<'award' | 'history'>('award');

  // Tính tổng điểm mỗi học sinh
  const studentPoints = useMemo(() => {
    return pointsByStudent(txs ?? []);
  }, [txs]);

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const selectAll = () => {
    if (!students) return;
    if (selectedIds.size === students.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(students.map((s) => s.id)));
  };

  // Trao điểm
  const handleAward = async (criterion: Criterion) => {
    if (!classId || selectedIds.size === 0) {
      toast.error('Vui lòng chọn ít nhất một học sinh');
      return;
    }
    try {
      const res = await awardPoints({
        classId,
        studentIds: Array.from(selectedIds),
        criterion,
      });
      toast.success(
        `Đã ${criterion.points > 0 ? 'cộng' : 'trừ'} ${Math.abs(criterion.points)} điểm "${criterion.name}" cho ${res.count} bạn!`,
        {
          label: 'Hoàn tác',
          onClick: () => handleUndoBatch(res.batchId),
        }
      );
      setSelectedIds(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lỗi khi cộng điểm');
    }
  };

  const handleUndoBatch = async (batchId: string) => {
    try {
      await undoBatch(batchId);
      toast.info('Đã hoàn tác lượt chấm điểm');
    } catch {
      toast.error('Không thể hoàn tác');
    }
  };

  const handleUndoTx = async (txId: string) => {
    try {
      await undoTransaction(txId);
      toast.info('Đã hoàn tác giao dịch');
    } catch {
      toast.error('Không thể hoàn tác');
    }
  };

  const handleSaveCriterion = async () => {
    if (!classId) return;
    try {
      await saveCriterion(
        classId,
        {
          name: critForm.name,
          points: Number(critForm.points),
          type: critForm.type,
          icon: critForm.icon,
        },
        editingCrit?.id
      );
      toast.success(editingCrit ? 'Đã cập nhật tiêu chí' : 'Đã thêm tiêu chí mới');
      setCritModalOpen(false);
      setEditingCrit(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lỗi lưu tiêu chí');
    }
  };

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title={`Thi đua & Điểm thưởng: Lớp ${currentClass.name}`}
        description="Ghi nhận thành tích tích cực, khuyến khích học sinh thi đua học tập."
        actions={
          <div className="flex gap-2">
            <button
              className={`btn ${tab === 'award' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setTab('award')}
            >
              <Award className="w-4 h-4" /> Chấm điểm
            </button>
            <button
              className={`btn ${tab === 'history' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setTab('history')}
            >
              <History className="w-4 h-4" /> Lịch sử ({txs?.length ?? 0})
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setEditingCrit(null);
                setCritForm({ name: '', points: 2, type: 'reward', icon: 'star' });
                setCritModalOpen(true);
              }}
            >
              <Settings2 className="w-4 h-4" /> Tiêu chí
            </button>
          </div>
        }
      />

      {tab === 'award' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Cột 1 & 2: Danh sách học sinh chọn để cộng điểm */}
          <div className="lg:col-span-2 space-y-4">
            <div className="card p-4 flex items-center justify-between">
              <span className="font-semibold text-sm">
                Đã chọn: <b className="text-pink-600">{selectedIds.size}</b> / {students?.length ?? 0} học sinh
              </span>
              <div className="flex gap-2">
                <button className="btn-secondary btn-sm" onClick={selectAll}>
                  {selectedIds.size === students?.length ? 'Bỏ chọn cả lớp' : 'Chọn cả lớp'}
                </button>
                {selectedIds.size > 0 && (
                  <button className="btn-ghost btn-sm" onClick={() => setSelectedIds(new Set())}>
                    Xóa chọn
                  </button>
                )}
              </div>
            </div>

            {students === undefined ? (
              <LoadingState />
            ) : students.length === 0 ? (
              <div className="card">
                <EmptyState illustration="bunny-star" title="Lớp chưa có học sinh" />
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {students.map((s) => {
                  const isSel = selectedIds.has(s.id);
                  const pts = studentPoints.get(s.id) ?? 0;
                  return (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => toggleSelect(s.id)}
                      className={`card p-3 flex flex-col items-center text-center relative transition-all duration-150 hover:-translate-y-0.5 ${
                        isSel ? 'border-pink-500 ring-4 ring-pink-100 bg-pink-50/70' : 'hover:border-pink-200'
                      }`}
                    >
                      <div
                        className={`absolute top-2 left-2 w-5 h-5 rounded-md border-2 flex items-center justify-center transition ${
                          isSel ? 'bg-pink-500 border-pink-500 text-white' : 'border-pink-200 bg-white'
                        }`}
                      >
                        {isSel && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                      </div>

                      <span className="absolute top-2 right-2 chip bg-pink-100 text-pink-600 !text-[11px] font-bold">
                        <Star className="w-3 h-3 fill-pink-400 text-pink-400" /> {pts}
                      </span>

                      <div className="mt-2">
                        <StudentAvatar student={s} size={48} />
                      </div>
                      <span className="font-semibold text-sm mt-2 line-clamp-1">{s.fullName}</span>
                      <span className="text-[11px] text-ink-soft">{s.code}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cột 3: Bảng tiêu chí để bấm thưởng/phạt */}
          <div className="space-y-4">
            <div className="card p-4 space-y-4">
              <h3 className="font-display font-extrabold text-base flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-pink-500" />
                Tiêu chí khen thưởng
              </h3>
              <div className="space-y-2">
                {criteria
                  ?.filter((c) => c.type === 'reward')
                  .map((c) => (
                    <button
                      key={c.id}
                      disabled={selectedIds.size === 0}
                      onClick={() => handleAward(c)}
                      className="w-full card p-3 flex items-center justify-between border-mint-dark/20 hover:bg-mint/30 transition text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="font-semibold text-sm">{c.name}</span>
                      <span className="chip bg-mint text-mint-dark font-bold">
                        +{c.points}
                      </span>
                    </button>
                  ))}
              </div>

              <h3 className="font-display font-extrabold text-base flex items-center gap-2 pt-2 border-t border-pink-100">
                <AlertTriangle className="w-5 h-5 text-danger" />
                Nhắc nhở & trừ điểm
              </h3>
              <div className="space-y-2">
                {criteria
                  ?.filter((c) => c.type === 'penalty')
                  .map((c) => (
                    <button
                      key={c.id}
                      disabled={selectedIds.size === 0}
                      onClick={() => handleAward(c)}
                      className="w-full card p-3 flex items-center justify-between border-danger/20 hover:bg-danger-soft/40 transition text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span className="font-semibold text-sm">{c.name}</span>
                      <span className="chip bg-danger-soft text-danger font-bold">
                        {c.points}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Tab Lịch sử giao dịch */
        <div className="card overflow-hidden">
          {txs === undefined ? (
            <LoadingState />
          ) : txs.length === 0 ? (
            <EmptyState
              illustration="bear-book"
              title="Chưa có lịch sử điểm thưởng"
              description="Các lượt cộng/trừ điểm sẽ được lưu chi tiết kèm thời gian tại đây."
            />
          ) : (
            <div className="overflow-x-auto scroll-soft p-2">
              <table className="table-base min-w-[700px]">
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Học sinh</th>
                    <th>Tiêu chí</th>
                    <th>Điểm</th>
                    <th>Người thực hiện</th>
                    <th>Trạng thái</th>
                    <th className="text-right">Hành động</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((t) => {
                    const st = students?.find((s) => s.id === t.studentId);
                    return (
                      <tr key={t.id} className={t.undone ? 'opacity-40 line-through' : ''}>
                        <td className="text-sm text-ink-soft">{formatDateTimeVN(t.createdAt)}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            {st && <StudentAvatar student={st} size={28} />}
                            <span className="font-semibold">{st?.fullName ?? 'Học sinh'}</span>
                          </div>
                        </td>
                        <td>{t.criterionName}</td>
                        <td>
                          <span
                            className={`chip font-bold ${
                              t.delta > 0 ? 'bg-mint text-mint-dark' : 'bg-danger-soft text-danger'
                            }`}
                          >
                            {t.delta > 0 ? `+${t.delta}` : t.delta}
                          </span>
                        </td>
                        <td className="text-sm">{t.actor}</td>
                        <td>
                          {t.undone ? (
                            <span className="chip bg-pink-100 text-ink-soft">Đã hoàn tác</span>
                          ) : (
                            <span className="chip bg-mint/50 text-mint-dark">Hợp lệ</span>
                          )}
                        </td>
                        <td className="text-right">
                          {!t.undone && (
                            <button
                              className="btn-ghost btn-sm"
                              onClick={() => handleUndoTx(t.id)}
                              data-tip="Hoàn tác lượt cộng này"
                            >
                              <Undo2 className="w-3.5 h-3.5" /> Hoàn tác
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal Quản lý Tiêu chí */}
      <Modal
        open={critModalOpen}
        onClose={() => setCritModalOpen(false)}
        title={editingCrit ? 'Chỉnh sửa tiêu chí' : 'Thêm tiêu chí thi đua mới'}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setCritModalOpen(false)}>
              Hủy
            </button>
            <button className="btn-primary" onClick={handleSaveCriterion}>
              Lưu tiêu chí
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Tên tiêu chí" required>
            <input
              className="input"
              placeholder="Ví dụ: Giúp đỡ bạn bè..."
              value={critForm.name}
              onChange={(e) => setCritForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Loại tiêu chí">
              <select
                className="input"
                value={critForm.type}
                onChange={(e) => {
                  const type = e.target.value as 'reward' | 'penalty';
                  setCritForm((f) => ({
                    ...f,
                    type,
                    points: type === 'reward' ? Math.abs(f.points) : -Math.abs(f.points),
                  }));
                }}
              >
                <option value="reward">Thưởng (+ Điểm)</option>
                <option value="penalty">Nhắc nhở (- Điểm)</option>
              </select>
            </Field>
            <Field label="Số điểm">
              <input
                type="number"
                className="input"
                value={critForm.points}
                onChange={(e) => setCritForm((f) => ({ ...f, points: Number(e.target.value) }))}
              />
            </Field>
          </div>
        </div>
      </Modal>
    </div>
  );
}
