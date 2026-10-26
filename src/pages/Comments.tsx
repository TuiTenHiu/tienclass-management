import { useState, useMemo } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Search,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useComments } from '../state/hooks';
import { PageHeader, Field } from '../components/ui';
import { StudentAvatar } from '../components/StudentAvatar';
import { EmptyState, LoadingState } from '../components/States';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/ToastNotification';
import { saveComment, deleteComment } from '../data/repo';
import { formatDateVN, toISODate } from '../lib/utils';
import type { StudentComment } from '../types';

const SUGGESTIONS = [
  'Hôm nay con rất tích cực giơ tay phát biểu xây dựng bài.',
  'Con có nhiều tiến bộ trong việc làm bài tập và chữ viết nắn nót.',
  'Con biết giúp đỡ bạn bè và hòa đồng cùng cả lớp.',
  'Con cần tập trung hơn trong giờ học và tránh nói chuyện riêng.',
  'Con giữ gìn vệ sinh chỗ ngồi rất sạch sẽ, cô khen con!',
];

export default function CommentsPage() {
  const { currentClass } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const students = useStudents(classId, 'active');
  const comments = useComments(classId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StudentComment | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [studentId, setStudentId] = useState('');
  const [date, setDate] = useState(() => toISODate());
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');

  const openCreate = () => {
    setEditing(null);
    setStudentId(students?.[0]?.id ?? '');
    setDate(toISODate());
    setContent('');
    setModalOpen(true);
  };

  const openEdit = (c: StudentComment) => {
    setEditing(c);
    setStudentId(c.studentId);
    setDate(c.date);
    setContent(c.content);
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!classId || !studentId || !content.trim()) {
      toast.error('Vui lòng chọn học sinh và nhập nội dung nhận xét');
      return;
    }
    try {
      await saveComment(
        classId,
        {
          studentId,
          date,
          session: 'all',
          content: content.trim(),
          tags: [],
        },
        editing?.id
      );
      toast.success(editing ? 'Đã cập nhật nhận xét' : 'Đã lưu nhận xét học sinh');
      setModalOpen(false);
    } catch (e) {
      toast.error('Lỗi khi lưu nhận xét');
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      await deleteComment(deletingId);
      toast.success('Đã xóa nhận xét');
      setDeletingId(null);
    } catch {
      toast.error('Không thể xóa nhận xét');
    }
  };

  const filteredComments = useMemo(() => {
    if (!comments) return [];
    if (!query.trim()) return comments;
    const q = query.toLowerCase();
    return comments.filter((c) => {
      const st = students?.find((s) => s.id === c.studentId);
      return (
        c.content.toLowerCase().includes(q) ||
        st?.fullName.toLowerCase().includes(q) ||
        st?.code.toLowerCase().includes(q)
      );
    });
  }, [comments, students, query]);

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn space-y-6">
      <PageHeader
        title={`Nhận xét học sinh: Lớp ${currentClass.name}`}
        description="Ghi chú quá trình học tập, rèn luyện và sinh hoạt hằng ngày của từng học sinh."
        actions={
          <button className="btn-primary" onClick={openCreate} disabled={!students?.length}>
            <Plus className="w-4 h-4" /> Viết nhận xét
          </button>
        }
      />

      <div className="card p-3 max-w-sm">
        <div className="relative">
          <Search className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            className="input pl-9 h-9 text-sm"
            placeholder="Tìm theo tên học sinh, nội dung..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {comments === undefined ? (
        <LoadingState />
      ) : filteredComments.length === 0 ? (
        <div className="card">
          <EmptyState
            illustration="sleepy-cat"
            title={query ? 'Không có nhận xét phù hợp' : 'Chưa có nhận xét nào'}
            description="Hãy ghi lại những điểm mạnh và nhắc nhở nhỏ để đồng hành cùng học sinh mỗi ngày nhé!"
            action={
              !query && (
                <button className="btn-primary" onClick={openCreate}>
                  <Plus className="w-4 h-4" /> Thêm nhận xét đầu tiên
                </button>
              )
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredComments.map((c) => {
            const st = students?.find((s) => s.id === c.studentId);
            return (
              <div key={c.id} className="card p-5 flex flex-col justify-between hover:shadow-soft transition">
                <div>
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2.5">
                      {st && <StudentAvatar student={st} size={38} />}
                      <div>
                        <h4 className="font-semibold text-sm text-ink">{st?.fullName ?? 'Học sinh'}</h4>
                        <span className="text-[12px] text-ink-soft font-mono">{st?.code}</span>
                      </div>
                    </div>
                    <span className="chip bg-pink-100 text-pink-600 !text-[11.5px]">
                      {formatDateVN(c.date)}
                    </span>
                  </div>

                  <p className="text-[14px] text-ink whitespace-pre-line leading-relaxed bg-pink-50/50 p-3 rounded-xl border border-pink-100/60">
                    "{c.content}"
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-pink-100 flex items-center justify-end gap-1">
                  <button
                    className="icon-btn w-8 h-8"
                    onClick={() => openEdit(c)}
                    aria-label="Chỉnh sửa nhận xét"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="icon-btn w-8 h-8 hover:!text-danger hover:!bg-danger-soft"
                    onClick={() => setDeletingId(c.id)}
                    aria-label="Xóa nhận xét"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Viết / Sửa nhận xét */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        size="lg"
        title={editing ? 'Chỉnh sửa nhận xét' : 'Nhận xét học sinh'}
        subtitle="Ghi nhận sự tiến bộ hoặc nhắc nhở dành cho học sinh"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setModalOpen(false)}>
              Hủy
            </button>
            <button className="btn-primary" onClick={handleSave}>
              Lưu nhận xét
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Chọn học sinh" required>
              <select
                className="input"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                disabled={!!editing}
              >
                {students?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.code})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Ngày ghi nhận" required>
              <input
                type="date"
                className="input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Nội dung nhận xét" required>
            <textarea
              className="input"
              rows={4}
              placeholder="Nhập cảm nhận, đánh giá hoặc sự tiến bộ của con..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>

          {/* Gợi ý câu nhận xét thân thiện */}
          <div>
            <span className="text-[12.5px] font-semibold text-ink-soft flex items-center gap-1 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-pink-500" />
              Gợi ý câu nhận xét (bấm để thêm):
            </span>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((text, i) => (
                <button
                  key={i}
                  type="button"
                  className="chip bg-pink-50 hover:bg-pink-100 text-ink text-left transition"
                  onClick={() => setContent((c) => (c ? `${c}\n${text}` : text))}
                >
                  + {text}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Xác nhận xóa */}
      <ConfirmDialog
        open={!!deletingId}
        danger
        title="Xóa nhận xét?"
        message="Nhận xét này sẽ bị xóa khỏi hồ sơ học sinh."
        confirmLabel="Xóa"
        onConfirm={handleDelete}
        onClose={() => setDeletingId(null)}
      />
    </div>
  );
}
