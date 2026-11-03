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
      <div className="card p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center justify-between sm:justify-start gap-2">
            <div className="flex items-center gap-1 bg-pink-100/70 p-1 rounded-btn">
              <button
                className="icon-btn w-9 h-9 sm:w-8 sm:h-8"
                onClick={() => setDate(addDays(date, -1))}
                aria-label="Ngày trước"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="date"
                className="bg-transparent font-semibold text-[14px] sm:text-[14.5px] px-1 sm:px-2 outline-none cursor-pointer"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <button
                className="icon-btn w-9 h-9 sm:w-8 sm:h-8"
                onClick={() => setDate(addDays(date, 1))}
                aria-label="Ngày sau"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-1 bg-pink-100/70 p-1 rounded-btn">
              <button
                className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition ${
                  session === 'morning' ? 'bg-white text-pink-600 shadow-sm' : 'text-ink-soft hover:text-ink'
                }`}
                onClick={() => setSession('morning')}
              >
                Sáng
              </button>
              <button
                className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition ${
                  session === 'afternoon' ? 'bg-white text-pink-600 shadow-sm' : 'text-ink-soft hover:text-ink'
                }`}
                onClick={() => setSession('afternoon')}
              >
                Chiều
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:hidden">
            <button className="btn-secondary btn-sm flex-1" onClick={setAllPresent}>
              <CheckCheck className="w-3.5 h-3.5" /> Cả lớp có mặt
            </button>
            <button className="btn-primary btn-sm flex-1" onClick={handleSave} disabled={saving || !students?.length}>
              <Save className="w-3.5 h-3.5" /> {saving ? 'Lưu...' : 'Lưu'}
            </button>
          </div>
        </div>

        {/* Quick summary chips */}
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 text-xs sm:text-sm pt-2 border-t border-pink-100/60">
          <span className="chip bg-mint text-mint-dark justify-center sm:justify-start">
            <CheckCircle2 className="w-3.5 h-3.5" /> Có mặt: {currentSummary.present}
          </span>
          <span className="chip bg-cream text-cream-dark justify-center sm:justify-start">
            <Clock className="w-3.5 h-3.5" /> Đi muộn: {currentSummary.late}
          </span>
          <span className="chip bg-pink-100 text-pink-600 justify-center sm:justify-start">
            <HelpCircle className="w-3.5 h-3.5" /> Nghỉ phép: {currentSummary.excused}
          </span>
          <span className="chip bg-danger-soft text-danger justify-center sm:justify-start">
            <AlertCircle className="w-3.5 h-3.5" /> K.phép: {currentSummary.unexcused}
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
        <>
          {/* Giao diện Thẻ danh sách thân thiện trên Mobile (Một tay chạm nhanh) */}
          <div className="space-y-3 block md:hidden">
            {students.map((s, idx) => {
              const state = localMap.get(s.id) ?? { status: 'present', note: '' };
              return (
                <div key={s.id} className="card p-3.5 space-y-3 border-pink-100">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-6 h-6 rounded-full bg-pink-100 text-pink-700 text-xs font-bold inline-flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <StudentAvatar student={s} size={40} />
                      <div className="min-w-0">
                        <p className="font-semibold text-ink text-[15px] truncate">{s.fullName}</p>
                        <p className="font-mono text-xs text-ink-soft">{s.code}</p>
                      </div>
                    </div>
                  </div>

                  {/* 4 nút trạng thái điểm danh touch-friendly */}
                  <div className="grid grid-cols-4 gap-1.5">
                    <button
                      type="button"
                      className={`h-10 rounded-xl text-xs font-bold transition flex items-center justify-center ${
                        state.status === 'present'
                          ? 'bg-mint-dark text-white shadow-sm ring-2 ring-mint'
                          : 'bg-pink-50 text-ink hover:bg-pink-100'
                      }`}
                      onClick={() => setStudentStatus(s.id, 'present')}
                    >
                      Có mặt
                    </button>
                    <button
                      type="button"
                      className={`h-10 rounded-xl text-xs font-bold transition flex items-center justify-center ${
                        state.status === 'late'
                          ? 'bg-cream-dark text-white shadow-sm ring-2 ring-cream-dark'
                          : 'bg-pink-50 text-ink hover:bg-pink-100'
                      }`}
                      onClick={() => setStudentStatus(s.id, 'late')}
                    >
                      Đi muộn
                    </button>
                    <button
                      type="button"
                      className={`h-10 rounded-xl text-xs font-bold transition flex items-center justify-center ${
                        state.status === 'excused'
                          ? 'bg-pink-500 text-white shadow-sm ring-2 ring-pink-300'
                          : 'bg-pink-50 text-ink hover:bg-pink-100'
                      }`}
                      onClick={() => setStudentStatus(s.id, 'excused')}
                    >
                      Có phép
                    </button>
                    <button
                      type="button"
                      className={`h-10 rounded-xl text-xs font-bold transition flex items-center justify-center ${
                        state.status === 'unexcused'
                          ? 'bg-danger text-white shadow-sm ring-2 ring-danger-soft'
                          : 'bg-pink-50 text-ink hover:bg-pink-100'
                      }`}
                      onClick={() => setStudentStatus(s.id, 'unexcused')}
                    >
                      K.phép
                    </button>
                  </div>

                  {/* Ghi chú nhanh cho học sinh nếu cần */}
                  <div>
                    <input
                      type="text"
                      placeholder="Lý do nghỉ / ghi chú..."
                      className="input !min-h-[38px] text-[13.5px] px-3 py-1.5 bg-pink-50/50"
                      value={state.note}
                      onChange={(e) => setStudentNote(s.id, e.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Giao diện Bảng truyền thống trên Máy tính */}
          <div className="card overflow-hidden hidden md:block">
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

          {/* Thanh Lưu điểm danh Nổi trên Mobile (Floating Action Bar) */}
          <div className="fixed bottom-16 left-3 right-3 z-30 md:hidden bg-white/95 backdrop-blur-md p-2.5 rounded-2xl border border-pink-200 shadow-card flex items-center justify-between gap-3 animate-fadeIn">
            <div className="text-xs font-semibold pl-1">
              <span>Có mặt: <b className="text-mint-dark">{currentSummary.present}</b>/{students.length}</span>
            </div>
            <button
              className="btn-primary !min-h-[38px] text-xs font-bold px-4"
              onClick={handleSave}
              disabled={saving}
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Đang lưu...' : 'Lưu điểm danh'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
