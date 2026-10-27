import { useMemo, useState, useEffect } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  HelpCircle,
  Save,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useStudents, useAttendance } from '../state/hooks';
import { PageHeader } from '../components/ui';
import { StudentAvatar } from '../components/StudentAvatar';
import { EmptyState, LoadingState } from '../components/States';
import { useToast } from '../components/ToastNotification';
import { saveAttendance } from '../data/repo';
import { addDays, toISODate } from '../lib/utils';
import type { AttendanceStatus, Session } from '../types';

export default function AttendancePage() {
  const { currentClass, settings } = useApp();
  const toast = useToast();
  const classId = currentClass?.id;

  const [date, setDate] = useState(() => toISODate());
  const [session, setSession] = useState<Session>(settings.defaultSession);
  const [saving, setSaving] = useState(false);

  const students = useStudents(classId, 'active');
  const attendance = useAttendance(classId);

  // Trạng thái cục bộ hiện tại của các học sinh trong ngày + buổi đã chọn
  const [localMap, setLocalMap] = useState<Map<string, { status: AttendanceStatus; note: string }>>(
    new Map()
  );

  // Khi đổi lớp, ngày, buổi, hoặc dữ liệu db thay đổi: đồng bộ vào local state
  useEffect(() => {
    if (!students) return;
    const records = (attendance ?? []).filter(
      (r) => r.date === date && r.session === session
    );
    const map = new Map<string, { status: AttendanceStatus; note: string }>();

    students.forEach((s) => {
      const rec = records.find((r) => r.studentId === s.id);
      if (rec) {
        map.set(s.id, { status: rec.status, note: rec.note ?? '' });
      } else {
        // Mặc định có mặt nếu chưa lưu
        map.set(s.id, { status: 'present', note: '' });
      }
    });

    setLocalMap(map);
  }, [students, attendance, date, session]);

  const setStudentStatus = (studentId: string, status: AttendanceStatus) => {
    const next = new Map(localMap);
    const cur = next.get(studentId) ?? { status: 'present', note: '' };
    next.set(studentId, { ...cur, status });
    setLocalMap(next);
  };

  const setStudentNote = (studentId: string, note: string) => {
    const next = new Map(localMap);
    const cur = next.get(studentId) ?? { status: 'present', note: '' };
    next.set(studentId, { ...cur, note });
    setLocalMap(next);
  };

  const setAllPresent = () => {
    if (!students) return;
    const next = new Map(localMap);
    students.forEach((s) => {
      const cur = next.get(s.id) ?? { status: 'present', note: '' };
      next.set(s.id, { ...cur, status: 'present' });
    });
    setLocalMap(next);
    toast.info('Đã chuyển tất cả sang Có mặt');
  };

  const handleSave = async () => {
    if (!classId || !students?.length) return;
    setSaving(true);
    try {
      const entries = students.map((s) => {
        const item = localMap.get(s.id) ?? { status: 'present', note: '' };
        return {
          studentId: s.id,
          status: item.status,
          note: item.note,
        };
      });
      await saveAttendance(classId, date, session, entries);
      toast.success('Đã lưu dữ liệu điểm danh thành công!');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lỗi khi lưu điểm danh');
    } finally {
      setSaving(false);
    }
  };

  // Thống kê nhanh buổi này
  const currentSummary = useMemo(() => {
    const counts = { present: 0, late: 0, excused: 0, unexcused: 0 };
    localMap.forEach((v) => {
      counts[v.status] += 1;
    });
    return counts;
  }, [localMap]);

  if (!currentClass) return null;

  return (
    <div className="animate-fadeIn space-y-5">
      <PageHeader
        title={`Điểm danh: Lớp ${currentClass.name}`}
        description="Điểm danh theo ngày và buổi học. Hệ thống tự động ngăn chặn lưu bản ghi trùng lặp."
        actions={
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={setAllPresent}>
              <CheckCheck className="w-4 h-4" /> Cả lớp có mặt
            </button>
            <button className="btn-primary" onClick={handleSave} disabled={saving || !students?.length}>
              <Save className="w-4 h-4" /> {saving ? 'Đang lưu...' : 'Lưu điểm danh'}
            </button>
          </div>
        }
      />

      {/* Date & Session Selector Bar */}
      <div className="card p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-pink-100/70 p-1 rounded-btn">
            <button
              className="icon-btn w-8 h-8"
              onClick={() => setDate(addDays(date, -1))}
              aria-label="Ngày trước"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="date"
              className="bg-transparent font-semibold text-[14.5px] px-2 outline-none cursor-pointer"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <button
              className="icon-btn w-8 h-8"
              onClick={() => setDate(addDays(date, 1))}
              aria-label="Ngày sau"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1 bg-pink-100/70 p-1 rounded-btn">
            <button
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${
                session === 'morning' ? 'bg-white text-pink-600 shadow-sm' : 'text-ink-soft hover:text-ink'
              }`}
              onClick={() => setSession('morning')}
            >
              Buổi Sáng
            </button>
            <button
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${
                session === 'afternoon' ? 'bg-white text-pink-600 shadow-sm' : 'text-ink-soft hover:text-ink'
              }`}
              onClick={() => setSession('afternoon')}
            >
              Buổi Chiều
            </button>
          </div>
        </div>

        {/* Quick summary chips */}
        <div className="flex items-center gap-2 text-sm">
          <span className="chip bg-mint text-mint-dark">
            <CheckCircle2 className="w-3.5 h-3.5" /> Có mặt: {currentSummary.present}
          </span>
          <span className="chip bg-cream text-cream-dark">
            <Clock className="w-3.5 h-3.5" /> Đi muộn: {currentSummary.late}
          </span>
          <span className="chip bg-pink-100 text-pink-600">
            <HelpCircle className="w-3.5 h-3.5" /> Nghỉ có phép: {currentSummary.excused}
          </span>
          <span className="chip bg-danger-soft text-danger">
            <AlertCircle className="w-3.5 h-3.5" /> Không phép: {currentSummary.unexcused}
          </span>
        </div>
      </div>

      {/* Attendance List */}
      {students === undefined ? (
        <LoadingState />
      ) : students.length === 0 ? (
        <div className="card">
          <EmptyState
            illustration="bunny-star"
            title="Chưa có học sinh trong lớp"
            description="Vui lòng thêm học sinh vào lớp trước khi tiến hành điểm danh."
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto scroll-soft p-2">
            <table className="table-base min-w-[700px]">
              <thead>
                <tr>
                  <th className="w-12">STT</th>
                  <th>Học sinh</th>
                  <th>Mã HS</th>
                  <th className="text-center">Trạng thái điểm danh</th>
                  <th>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s, idx) => {
                  const state = localMap.get(s.id) ?? { status: 'present', note: '' };
                  return (
                    <tr key={s.id} className="hover:bg-pink-50/50">
                      <td className="text-ink-soft">{idx + 1}</td>
                      <td>
                        <div className="flex items-center gap-3">
                          <StudentAvatar student={s} size={36} />
                          <span className="font-semibold text-ink">{s.fullName}</span>
                        </div>
                      </td>
                      <td className="font-mono text-sm text-ink-soft">{s.code}</td>
                      <td>
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            className={`px-2.5 py-1 text-[13px] font-semibold rounded-lg transition ${
                              state.status === 'present'
                                ? 'bg-mint-dark text-white'
                                : 'bg-pink-50 text-ink-soft hover:bg-pink-100'
                            }`}
                            onClick={() => setStudentStatus(s.id, 'present')}
                          >
                            Có mặt
                          </button>
                          <button
                            type="button"
                            className={`px-2.5 py-1 text-[13px] font-semibold rounded-lg transition ${
                              state.status === 'late'
                                ? 'bg-cream-dark text-white'
                                : 'bg-pink-50 text-ink-soft hover:bg-pink-100'
                            }`}
                            onClick={() => setStudentStatus(s.id, 'late')}
                          >
                            Đi muộn
                          </button>
                          <button
                            type="button"
                            className={`px-2.5 py-1 text-[13px] font-semibold rounded-lg transition ${
                              state.status === 'excused'
                                ? 'bg-pink-500 text-white'
                                : 'bg-pink-50 text-ink-soft hover:bg-pink-100'
                            }`}
                            onClick={() => setStudentStatus(s.id, 'excused')}
                          >
                            Có phép
                          </button>
                          <button
                            type="button"
                            className={`px-2.5 py-1 text-[13px] font-semibold rounded-lg transition ${
                              state.status === 'unexcused'
                                ? 'bg-danger text-white'
                                : 'bg-pink-50 text-ink-soft hover:bg-pink-100'
                            }`}
                            onClick={() => setStudentStatus(s.id, 'unexcused')}
                          >
                            Không phép
                          </button>
                        </div>
                      </td>
                      <td>
                        <input
                          type="text"
                          placeholder="Lý do nghỉ / ghi chú..."
                          className="input h-8 text-[13px] px-2.5 max-w-[200px]"
                          value={state.note}
                          onChange={(e) => setStudentNote(s.id, e.target.value)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
