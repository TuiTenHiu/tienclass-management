import { useMemo, useState } from 'react';
import {
  Plus,
  FileSpreadsheet,
  Download,
  LayoutGrid,
  List,
  Pencil,
  Archive,
  RotateCcw,
  Trash2,
  ArrowRightLeft,
  Star,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { useStudents } from '../state/hooks';
import { PageHeader } from '../components/ui';
import { SearchBar } from '../components/SearchBar';
import { SegmentedFilter, FilterBar } from '../components/FilterBar';
import { StudentCard } from '../components/StudentCard';
import { StudentTable } from '../components/StudentTable';
import { EmptyState, LoadingState } from '../components/States';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { useToast } from '../components/ToastNotification';
import { StudentFormModal } from '../features/students/StudentFormModal';
import { ImportExcelModal } from '../features/students/ImportExcelModal';
import { StudentProfileModal } from '../features/students/StudentProfileModal';
import {
  archiveStudents,
  deleteStudentsPermanently,
  restoreStudents,
  transferStudents,
} from '../data/repo';
import { downloadSheets, studentsToRows } from '../lib/excel';
import { matchesSearch } from '../lib/utils';
import type { Student } from '../types';

export default function StudentsPage() {
  const { classes, currentClass } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const classId = currentClass?.id;

  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const students = useStudents(classId, statusFilter);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [profileStudent, setProfileStudent] = useState<Student | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [targetClassId, setTargetClassId] = useState<string>('');

  // Dialogs
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Filtered students by search
  const filtered = useMemo(() => {
    if (!students) return [];
    return students.filter((s) => matchesSearch([s.fullName, s.code, s.parentName ?? '', s.parentPhone ?? ''], query));
  }, [students, query]);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((s) => s.id)));
    }
  };

  const handleArchive = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    await archiveStudents(ids);
    setSelected(new Set());
    toast.success(`Đã chuyển ${ids.length} học sinh vào mục lưu trữ`);
  };

  const handleRestore = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    await restoreStudents(ids);
    setSelected(new Set());
    toast.success(`Đã khôi phục ${ids.length} học sinh`);
  };

  const handleDelete = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    await deleteStudentsPermanently(ids);
    setSelected(new Set());
    toast.success(`Đã xóa vĩnh viễn ${ids.length} học sinh`);
  };

  const handleTransfer = async () => {
    const ids = Array.from(selected);
    if (!ids.length || !targetClassId) return;
    try {
      await transferStudents(ids, targetClassId);
      setSelected(new Set());
      setTransferOpen(false);
      const targetCls = classes.find((c) => c.id === targetClassId);
      toast.success(`Đã chuyển ${ids.length} học sinh sang lớp ${targetCls?.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Chuyển lớp thất bại');
    }
  };

  const exportExcel = () => {
    if (!currentClass || !students) return;
    const rows = studentsToRows(students, (id) => classes.find((c) => c.id === id)?.name ?? '');
    downloadSheets(`Danh_sach_lop_${currentClass.name}`, [{ name: currentClass.name, rows }]);
    toast.success('Đã tải xuống danh sách học sinh dạng Excel');
  };

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn">
      <PageHeader
        title={`Học sinh lớp ${currentClass.name}`}
        description={`Tổng số: ${filtered.length} học sinh ${statusFilter === 'archived' ? '(Lưu trữ)' : ''}`}
        actions={
          <>
            <button className="btn-outline" onClick={exportExcel} disabled={!students?.length}>
              <Download className="w-4 h-4" /> Xuất Excel
            </button>
            <button className="btn-secondary" onClick={() => setImportOpen(true)}>
              <FileSpreadsheet className="w-4 h-4" /> Nhập Excel
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                setEditingStudent(null);
                setFormOpen(true);
              }}
            >
              <Plus className="w-4 h-4" /> Thêm học sinh
            </button>
          </>
        }
      />

      {/* Filter and search bar */}
      <FilterBar
        actions={
          <div className="flex items-center gap-1 bg-pink-100/70 p-1 rounded-btn">
            <button
              className={`p-1.5 rounded-lg transition ${viewMode === 'grid' ? 'bg-white text-pink-600 shadow-sm' : 'text-ink-soft hover:text-ink'}`}
              onClick={() => setViewMode('grid')}
              aria-label="Chế độ lưới"
              data-tip="Xem dạng lưới"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              className={`p-1.5 rounded-lg transition ${viewMode === 'table' ? 'bg-white text-pink-600 shadow-sm' : 'text-ink-soft hover:text-ink'}`}
              onClick={() => setViewMode('table')}
              aria-label="Chế độ bảng"
              data-tip="Xem dạng bảng"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        }
      >
        <SearchBar value={query} onChange={setQuery} className="w-full sm:w-72" />
        <SegmentedFilter
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'active', label: 'Đang học' },
            { value: 'archived', label: 'Đã lưu trữ' },
            { value: 'all', label: 'Tất cả' },
          ]}
        />
      </FilterBar>

      {/* Bulk actions bar if items are selected */}
      {selected.size > 0 && (
        <div className="mb-4 card p-3 bg-pink-100/80 border-pink-200 flex flex-wrap items-center justify-between gap-3 animate-fadeIn">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[14px]">Đã chọn {selected.size} học sinh</span>
            <button className="btn-ghost btn-sm text-[13px]" onClick={() => setSelected(new Set())}>
              Bỏ chọn
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-outline btn-sm bg-white"
              onClick={() => navigate('/points')}
              data-tip="Cộng điểm cho các bạn đã chọn"
            >
              <Star className="w-3.5 h-3.5 text-pink-500" /> Thưởng điểm
            </button>
            <button
              className="btn-outline btn-sm bg-white"
              onClick={() => {
                const other = classes.filter((c) => c.id !== classId);
                if (other.length) {
                  setTargetClassId(other[0].id);
                  setTransferOpen(true);
                } else {
                  toast.error('Chưa có lớp khác để chuyển sang');
                }
              }}
            >
              <ArrowRightLeft className="w-3.5 h-3.5 text-lavender-dark" /> Chuyển lớp
            </button>

            {statusFilter === 'archived' ? (
              <button className="btn-secondary btn-sm" onClick={handleRestore}>
                <RotateCcw className="w-3.5 h-3.5" /> Khôi phục
              </button>
            ) : (
              <button className="btn-secondary btn-sm" onClick={() => setConfirmArchive(true)}>
                <Archive className="w-3.5 h-3.5" /> Lưu trữ
              </button>
            )}

            <button className="btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="w-3.5 h-3.5" /> Xóa vĩnh viễn
            </button>
          </div>
        </div>
      )}

      {/* List content */}
      {students === undefined ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            illustration="bunny-star"
            title={query ? 'Không tìm thấy học sinh phù hợp' : 'Lớp chưa có học sinh nào'}
            description={
              query
                ? 'Hãy thử tìm kiếm bằng từ khóa khác hoặc xóa bộ lọc tìm kiếm.'
                : 'Thêm học sinh thủ công hoặc nhập danh sách nhanh từ file Excel có sẵn.'
            }
            action={
              !query && (
                <div className="flex gap-2">
                  <button className="btn-secondary" onClick={() => setImportOpen(true)}>
                    <FileSpreadsheet className="w-4 h-4" /> Nhập Excel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      setEditingStudent(null);
                      setFormOpen(true);
                    }}
                  >
                    <Plus className="w-4 h-4" /> Thêm học sinh
                  </button>
                </div>
              )
            }
          />
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((s) => (
            <StudentCard
              key={s.id}
              student={s}
              selectable
              selected={selected.has(s.id)}
              onClick={() => setProfileStudent(s)}
              dim={s.status === 'archived'}
              badge={
                <button
                  className="w-7 h-7 rounded-lg bg-pink-50 hover:bg-pink-200 inline-flex items-center justify-center text-ink-soft hover:text-ink transition"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingStudent(s);
                    setFormOpen(true);
                  }}
                  data-tip="Sửa hồ sơ"
                  aria-label="Sửa hồ sơ"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              }
            />
          ))}
        </div>
      ) : (
        <StudentTable
          students={filtered}
          selected={selected}
          onToggle={toggleSelect}
          onToggleAll={toggleSelectAll}
          onOpen={(s) => setProfileStudent(s)}
          rowActions={(s) => (
            <button
              className="icon-btn w-8 h-8"
              onClick={() => {
                setEditingStudent(s);
                setFormOpen(true);
              }}
              data-tip="Chỉnh sửa"
              aria-label="Chỉnh sửa"
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
        />
      )}

      {/* Modals & Dialogs */}
      <StudentFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        classId={classId!}
        editing={editingStudent}
      />

      <ImportExcelModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        classId={classId!}
        className={currentClass.name}
      />

      <StudentProfileModal
        student={profileStudent}
        onClose={() => setProfileStudent(null)}
        onEdit={(s) => {
          setProfileStudent(null);
          setEditingStudent(s);
          setFormOpen(true);
        }}
        className={currentClass.name}
      />

      {/* Transfer modal */}
      <Modal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Chuyển lớp cho học sinh"
        subtitle={`Chuyển ${selected.size} học sinh được chọn sang lớp mới`}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setTransferOpen(false)}>
              Hủy
            </button>
            <button className="btn-primary" onClick={handleTransfer} disabled={!targetClassId}>
              Xác nhận chuyển
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="label">Chọn lớp chuyển đến:</label>
          <select
            className="input"
            value={targetClassId}
            onChange={(e) => setTargetClassId(e.target.value)}
          >
            {classes
              .filter((c) => c.id !== classId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  Lớp {c.name} ({c.schoolYear})
                </option>
              ))}
          </select>
          <p className="text-[13px] text-ink-soft">
            * Lưu ý: Hồ sơ học sinh sẽ được chuyển sang lớp mới. Lịch sử điểm và điểm danh cũ vẫn được lưu theo lớp ban đầu.
          </p>
        </div>
      </Modal>

      {/* Confirm Archive */}
      <ConfirmDialog
        open={confirmArchive}
        title="Lưu trữ học sinh?"
        confirmLabel="Lưu trữ"
        message={
          <>
            Học sinh được lưu trữ sẽ tạm ẩn khỏi danh sách lớp và điểm danh hằng ngày. Bạn vẫn có thể khôi phục lại bất kỳ lúc nào.
          </>
        }
        onConfirm={handleArchive}
        onClose={() => setConfirmArchive(false)}
      />

      {/* Confirm Delete */}
      <ConfirmDialog
        open={confirmDelete}
        danger
        title="Xóa vĩnh viễn học sinh?"
        confirmLabel="Xóa vĩnh viễn"
        message={
          <>
            Bạn có chắc chắn muốn xóa vĩnh viễn <b>{selected.size} học sinh</b> đã chọn?
            Toàn bộ điểm danh, nhận xét và điểm thi đua của học sinh này sẽ bị xóa và <b>không thể khôi phục</b>.
          </>
        }
        onConfirm={handleDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
