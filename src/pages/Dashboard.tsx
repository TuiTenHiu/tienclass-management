import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Users,
  UserCheck,
  UserX,
  Star,
  ListTodo,
  CalendarCheck,
  Dog,
  ChevronRight,
  Plus,
  Trash2,
  Trophy,
  Activity,
  School,
  Check,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useActivities, useAttendance, useStudents, useTasks, useTransactions } from '../state/hooks';
import { db } from '../data/db';
import { addTask, deleteTask, toggleTask, ValidationError } from '../data/repo';
import { StatCard } from '../components/StatCard';
import { Card } from '../components/ui';
import { EmptyState, LoadingState } from '../components/States';
import { StudentAvatar } from '../components/StudentAvatar';
import { Illustration } from '../components/illustrations';
import { useToast } from '../components/ToastNotification';
import { pointsByStudent, rankStudents, summarizeAttendance, totalPoints } from '../lib/stats';
import { formatDateVN, periodRange, timeAgo, toISODate } from '../lib/utils';

export default function Dashboard() {
  const { ready, classes, currentClass, setCurrentClassId, teacherCall, settings } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const classId = currentClass?.id;
  const today = toISODate();

  const students = useStudents(classId);
  const attendance = useAttendance(classId);
  const txs = useTransactions(classId);
  const tasks = useTasks(classId);
  const activities = useActivities(classId, 7);
  const classCounts = useLiveQuery(async () => {
    const all = await db.students.where('status').equals('active').toArray();
    const m = new Map<string, number>();
    all.forEach((s) => m.set(s.classId, (m.get(s.classId) ?? 0) + 1));
    return m;
  }, []);

  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');

  const activeIds = useMemo(() => new Set((students ?? []).map((s) => s.id)), [students]);

  const todayInfo = useMemo(() => {
    const recs = (attendance ?? []).filter((r) => r.date === today && activeIds.has(r.studentId));
    if (!recs.length) return null;
    const pref = recs.filter((r) => r.session === settings.defaultSession);
    const use = pref.length ? pref : recs.filter((r) => r.session === recs[0].session);
    return { ...summarizeAttendance(use), session: use[0].session };
  }, [attendance, today, activeIds, settings.defaultSession]);

  const last7 = useMemo(() => {
    const byDate = new Map<string, typeof attendance>();
    for (const r of attendance ?? []) {
      if (!activeIds.has(r.studentId)) continue;
      const arr = byDate.get(r.date) ?? [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    return [...byDate.keys()]
      .sort()
      .slice(-7)
      .map((d) => ({ date: d, ...summarizeAttendance(byDate.get(d)!) }));
  }, [attendance, activeIds]);

  const month = periodRange('month');
  const top = useMemo(() => {
    if (!students || !txs) return [];
    const pts = pointsByStudent(txs, month);
    return rankStudents(students, pts).filter((x) => x.points > 0).slice(0, 5);
  }, [students, txs, month.from]);

  const classTotal = txs ? totalPoints(txs, undefined, activeIds) : 0;
  const pending = (tasks ?? []).filter((t) => !t.done);

  if (!ready) return <LoadingState />;

  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Chào buổi sáng' : hour < 14 ? 'Chào buổi trưa' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
  const call = teacherCall.charAt(0).toUpperCase() + teacherCall.slice(1);
  const pronoun = settings.teacherTitle;

  const submitTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!classId) return;
    try {
      await addTask(classId, taskTitle, taskDue);
      setTaskTitle('');
      setTaskDue('');
      toast.success('Đã thêm hoạt động');
    } catch (err) {
      toast.error(err instanceof ValidationError ? err.message : 'Không thêm được hoạt động');
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Lời chào */}
      <section className="relative overflow-hidden rounded-[26px] bg-gradient-to-r from-pink-100 via-[#FDEFF6] to-lavender/50 border border-pink-100 p-6 md:p-8">
        <div className="relative z-10 max-w-2xl">
          <p className="text-pink-600 font-semibold text-sm">{formatDateVN(new Date(), true)}</p>
          <h2 className="font-display font-black text-2xl md:text-[32px] leading-tight mt-1">
            {greet}, {call}!
          </h2>
          <p className="text-ink-soft mt-2 text-[15px] md:text-base">
            Chúc {pronoun} có một ngày dạy học thật vui nhé! {currentClass ? `Lớp ${currentClass.name} đang chờ ${pronoun} đó.` : ''}
          </p>
          <div className="flex flex-wrap gap-2 mt-5">
            {currentClass ? (
              <>
                <button className="btn-primary" onClick={() => navigate('/attendance')}>
                  <CalendarCheck className="w-[18px] h-[18px]" /> Điểm danh nhanh
                </button>
                <button className="btn-outline" onClick={() => navigate('/games/dog')}>
                  <Dog className="w-[18px] h-[18px]" /> Chú chó chọn học sinh
                </button>
              </>
            ) : (
              <button className="btn-primary" onClick={() => navigate('/classes?new=1')}>
                <Plus className="w-[18px] h-[18px]" /> Tạo lớp học đầu tiên
              </button>
            )}
          </div>
        </div>
        <div className="hidden md:block absolute right-6 bottom-0 z-0">
          <Illustration name="bunny-star" size={220} />
        </div>
      </section>

      {!currentClass ? (
        <div className="card">
          <EmptyState
            illustration="rainbow"
            title="Bắt đầu với lớp học đầu tiên"
            description={
              <>
                Pink Classroom chưa có dữ liệu. Hãy tạo lớp, sau đó thêm học sinh thủ công hoặc nhập từ Excel. Muốn xem thử? Vào <b>Cài đặt</b> để tạo dữ liệu
                minh họa (tên giả).
              </>
            }
            action={
              <>
                <button className="btn-primary" onClick={() => navigate('/classes?new=1')}>
                  Tạo lớp mới
                </button>
                <button className="btn-outline" onClick={() => navigate('/settings')}>
                  Mở Cài đặt
                </button>
              </>
            }
          />
        </div>
      ) : (
        <>
          {/* Thẻ thống kê */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <StatCard icon={Users} tone="pink" label="Tổng số học sinh" value={students ? students.length : '…'} hint={`Lớp ${currentClass.name}`} onClick={() => navigate('/students')} />
            <StatCard
              icon={UserCheck}
              tone="mint"
              label="Có mặt hôm nay"
              value={todayInfo ? todayInfo.present + todayInfo.late : '—'}
              hint={todayInfo ? `Buổi ${todayInfo.session === 'morning' ? 'sáng' : 'chiều'} · ${todayInfo.late} đi muộn` : 'Chưa điểm danh'}
              onClick={() => navigate('/attendance')}
            />
            <StatCard
              icon={UserX}
              tone="cream"
              label="Vắng hôm nay"
              value={todayInfo ? todayInfo.excused + todayInfo.unexcused : '—'}
              hint={todayInfo ? `${todayInfo.excused} có phép · ${todayInfo.unexcused} không phép` : 'Chưa điểm danh'}
              onClick={() => navigate('/attendance')}
            />
            <StatCard icon={Star} tone="lavender" label="Tổng điểm thi đua" value={txs ? classTotal : '…'} hint="Cả lớp, từ đầu đến nay" onClick={() => navigate('/points')} />
            <StatCard icon={ListTodo} tone="sky" label="Hoạt động cần làm" value={tasks ? pending.length : '…'} hint={pending[0]?.title ?? 'Không có việc tồn đọng'} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Chuyên cần */}
            <Card
              className="xl:col-span-2"
              title="Tình hình chuyên cần"
              icon={<CalendarCheck className="w-5 h-5 text-pink-500" />}
              action={
                <button className="btn-ghost btn-sm" onClick={() => navigate('/reports')}>
                  Xem báo cáo <ChevronRight className="w-4 h-4" />
                </button>
              }
            >
              {attendance === undefined ? (
                <LoadingState compact />
              ) : last7.length === 0 ? (
                <EmptyState
                  compact
                  illustration="bear-book"
                  title="Chưa có dữ liệu điểm danh"
                  description="Sau khi điểm danh, biểu đồ chuyên cần 7 ngày gần nhất sẽ hiện ở đây."
                  action={
                    <button className="btn-primary btn-sm" onClick={() => navigate('/attendance')}>
                      Điểm danh ngay
                    </button>
                  }
                />
              ) : (
                <div>
                  <div className="flex items-end gap-3 h-48 pt-4">
                    {last7.map((d) => {
                      const pct = d.total ? ((d.present + d.late) / d.total) * 100 : 0;
                      return (
                        <div key={d.date} className="flex-1 flex flex-col items-center gap-2 h-full justify-end group">
                          <span className="text-[12.5px] font-semibold text-ink">{Math.round(pct)}%</span>
                          <div className="w-full max-w-[52px] bg-pink-50 rounded-xl flex-1 flex items-end overflow-hidden">
                            <div className="w-full rounded-xl bg-gradient-to-t from-pink-300 to-pink-200 transition-all" style={{ height: `${pct}%` }} title={`${d.present} có mặt, ${d.late} muộn, ${d.excused + d.unexcused} vắng`} />
                          </div>
                          <span className="text-[12px] text-ink-soft">{d.date.slice(8, 10)}/{d.date.slice(5, 7)}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[12.5px] text-ink-soft mt-3">Tỷ lệ chuyên cần = (có mặt + đi muộn) / tổng lượt điểm danh trong ngày.</p>
                </div>
              )}
            </Card>

            {/* Top học sinh */}
            <Card title="Ngôi sao tháng này" icon={<Trophy className="w-5 h-5 text-cream-dark" />}>
              {txs === undefined || students === undefined ? (
                <LoadingState compact />
              ) : top.length === 0 ? (
                <EmptyState compact illustration="bunny-star" title="Chưa có điểm thi đua" description="Cộng điểm cho học sinh để thấy bảng vinh danh." action={<button className="btn-secondary btn-sm" onClick={() => navigate('/points')}>Cộng điểm</button>} />
              ) : (
                <ol className="space-y-2.5">
                  {top.map((x, i) => (
                    <li key={x.student.id} className="flex items-center gap-3">
                      <span className={`w-7 h-7 rounded-full text-[13px] font-bold inline-flex items-center justify-center ${i === 0 ? 'bg-cream text-cream-dark' : i === 1 ? 'bg-lavender text-lavender-dark' : i === 2 ? 'bg-pink-100 text-pink-600' : 'bg-pink-50 text-ink-soft'}`}>
                        {i + 1}
                      </span>
                      <StudentAvatar student={x.student} size={38} />
                      <span className="flex-1 min-w-0 font-semibold text-[14.5px] truncate">{x.student.fullName}</span>
                      <span className="chip bg-pink-100 text-pink-700">
                        <Star className="w-3.5 h-3.5 fill-pink-400 text-pink-400" />
                        {x.points}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
            {/* Lớp gần đây */}
            <Card
              title="Lớp học của tôi"
              icon={<School className="w-5 h-5 text-lavender-dark" />}
              action={
                <button className="btn-ghost btn-sm" onClick={() => navigate('/classes')}>
                  Quản lý <ChevronRight className="w-4 h-4" />
                </button>
              }
            >
              <ul className="space-y-2">
                {[...classes]
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .slice(0, 5)
                  .map((c) => (
                    <li key={c.id}>
                      <button
                        className={`w-full flex items-center gap-3 p-3 rounded-2xl text-left transition hover:bg-pink-50 ${c.id === classId ? 'bg-pink-50 ring-1 ring-pink-200' : ''}`}
                        onClick={() => setCurrentClassId(c.id)}
                      >
                        <span className="w-10 h-10 rounded-xl inline-flex items-center justify-center font-display font-black text-ink" style={{ background: c.color }}>
                          {c.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block font-semibold truncate">{c.name}</span>
                          <span className="block text-[12.5px] text-ink-soft">
                            {classCounts?.get(c.id) ?? 0} học sinh · {c.schoolYear}
                          </span>
                        </span>
                        {c.id === classId && <span className="chip bg-pink-500 text-white">Đang chọn</span>}
                      </button>
                    </li>
                  ))}
              </ul>
            </Card>

            {/* Hoạt động cần hoàn thành */}
            <Card title="Hoạt động cần hoàn thành" icon={<ListTodo className="w-5 h-5 text-sky-dark" />}>
              <form onSubmit={submitTask} className="flex gap-2 mb-3">
                <input className="input flex-1 min-w-0" placeholder="Ví dụ: Thu phiếu khảo sát..." value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} maxLength={120} aria-label="Tên hoạt động" />
                <input type="date" className="input w-[140px] px-2" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} aria-label="Hạn hoàn thành" data-tip="Hạn hoàn thành (không bắt buộc)" />
                <button className="btn-primary px-3" disabled={!taskTitle.trim()} aria-label="Thêm hoạt động">
                  <Plus className="w-5 h-5" />
                </button>
              </form>
              {tasks === undefined ? (
                <LoadingState compact />
              ) : tasks.length === 0 ? (
                <p className="text-sm text-ink-soft text-center py-6">Chưa có hoạt động nào. Thêm việc cần làm cho lớp ở ô phía trên.</p>
              ) : (
                <ul className="space-y-1 max-h-64 overflow-y-auto scroll-soft pr-1">
                  {tasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2.5 p-2 rounded-xl hover:bg-pink-50 group">
                      <button
                        onClick={() => toggleTask(t.id)}
                        className={`w-6 h-6 rounded-lg border-2 inline-flex items-center justify-center shrink-0 transition ${t.done ? 'bg-mint-dark border-mint-dark text-white' : 'border-pink-200 hover:border-pink-400'}`}
                        aria-label={t.done ? 'Đánh dấu chưa xong' : 'Đánh dấu đã xong'}
                      >
                        {t.done && <Check className="w-4 h-4" strokeWidth={3} />}
                      </button>
                      <span className={`flex-1 min-w-0 text-[14.5px] ${t.done ? 'line-through text-ink-soft' : ''}`}>
                        {t.title}
                        {t.dueDate && (
                          <span className={`block text-[12px] ${!t.done && t.dueDate < today ? 'text-danger' : 'text-ink-soft'}`}>Hạn {formatDateVN(t.dueDate)}</span>
                        )}
                      </span>
                      <button className="icon-btn w-8 h-8 opacity-60 group-hover:opacity-100" onClick={() => deleteTask(t.id)} aria-label="Xóa hoạt động">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Hoạt động gần đây */}
            <Card title="Hoạt động gần đây" icon={<Activity className="w-5 h-5 text-mint-dark" />} className="lg:col-span-2 xl:col-span-1">
              {activities === undefined ? (
                <LoadingState compact />
              ) : activities.length === 0 ? (
                <p className="text-sm text-ink-soft text-center py-6">Chưa có hoạt động nào được ghi nhận.</p>
              ) : (
                <ul className="relative space-y-3 before:absolute before:left-[7px] before:top-2 before:bottom-2 before:w-0.5 before:bg-pink-100">
                  {activities.map((a) => (
                    <li key={a.id} className="relative pl-6">
                      <span className="absolute left-0 top-1.5 w-4 h-4 rounded-full bg-white border-[3px] border-pink-300" />
                      <p className="text-[14px] text-ink leading-snug">{a.message}</p>
                      <p className="text-[12px] text-ink-soft">{timeAgo(a.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
