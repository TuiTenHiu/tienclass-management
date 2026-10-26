import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bell, CalendarDays, ChevronDown, Menu, Plus, CalendarCheck, Star, UserPlus, Dog, School, Check, ClipboardList } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { useActivities, useStudents, useTasks } from '../state/hooks';
import { db } from '../data/db';
import { formatDateVN, timeAgo, toISODate } from '../lib/utils';
import { NAV_ITEMS } from './Sidebar';
import { Popover } from './Popover';
import { AnimalAvatarSVG } from './avatars';

export function Header({ onMenu }: { onMenu: () => void }) {
  const { classes, currentClass, setCurrentClassId, teacherCall, settings } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const classId = currentClass?.id;
  const today = toISODate();

  const title = useMemo(() => {
    const item = [...NAV_ITEMS].sort((a, b) => b.to.length - a.to.length).find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));
    return item?.label ?? 'Pink Classroom';
  }, [location.pathname]);

  const students = useStudents(classId);
  const tasks = useTasks(classId);
  const activities = useActivities(classId, 6);
  const attendanceToday = useLiveQuery(
    async () => (classId ? db.attendance.where('[classId+date]').equals([classId, today]).count() : 0),
    [classId, today],
  );

  const alerts: { text: string; to: string }[] = [];
  const isWeekday = new Date().getDay() !== 0;
  if (classId && students && students.length > 0 && attendanceToday === 0 && isWeekday)
    alerts.push({ text: 'Lớp chưa được điểm danh hôm nay', to: '/attendance' });
  const pending = (tasks ?? []).filter((t) => !t.done);
  const overdue = pending.filter((t) => t.dueDate && t.dueDate < today);
  if (overdue.length) alerts.push({ text: `${overdue.length} hoạt động đã quá hạn`, to: '/' });
  else if (pending.length) alerts.push({ text: `${pending.length} hoạt động cần hoàn thành`, to: '/' });

  const quick = [
    { label: 'Điểm danh hôm nay', icon: CalendarCheck, to: '/attendance' },
    { label: 'Cộng điểm thi đua', icon: Star, to: '/points' },
    { label: 'Thêm học sinh', icon: UserPlus, to: '/students?new=1' },
    { label: 'Chú chó chọn học sinh', icon: Dog, to: '/games/dog' },
    { label: 'Tạo lớp mới', icon: School, to: '/classes?new=1' },
  ];

  return (
    <header className="no-print sticky top-0 z-30 bg-pink-50/85 backdrop-blur-md">
      <div className="flex items-center gap-2 md:gap-3 px-4 md:px-6 lg:px-8 py-3">
        <button className="icon-btn lg:hidden" onClick={onMenu} aria-label="Mở menu">
          <Menu className="w-5 h-5" />
        </button>
        <h1 className="font-display font-extrabold text-lg md:text-xl text-ink truncate hidden sm:block">{title}</h1>

        <div className="ml-auto flex items-center gap-1.5 md:gap-2">
          {/* Bộ chọn lớp */}
          <Popover
            align="right"
            width="w-64"
            trigger={({ toggle }) => (
              <button className="btn-outline h-10 px-3 max-w-[180px] md:max-w-[240px]" onClick={toggle} data-tip="Chuyển lớp đang làm việc" data-tip-pos="bottom">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: currentClass?.color ?? '#F7A8C4' }} />
                <span className="truncate">{currentClass ? currentClass.name : 'Chưa có lớp'}</span>
                <ChevronDown className="w-4 h-4 text-ink-soft shrink-0" />
              </button>
            )}
          >
            {(close) => (
              <div>
                <p className="px-3 pt-1 pb-2 text-[12px] font-semibold text-ink-soft uppercase tracking-wide">Chọn lớp</p>
                {classes.length === 0 && <p className="px-3 pb-2 text-sm text-ink-soft">Chưa có lớp nào.</p>}
                <div className="max-h-64 overflow-y-auto scroll-soft">
                  {classes.map((c) => (
                    <button
                      key={c.id}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-pink-50 ${c.id === classId ? 'bg-pink-50' : ''}`}
                      onClick={() => {
                        setCurrentClassId(c.id);
                        close();
                      }}
                    >
                      <span className="w-3 h-3 rounded-full" style={{ background: c.color }} />
                      <span className="flex-1 min-w-0">
                        <span className="block font-semibold text-[14px] truncate">{c.name}</span>
                        <span className="block text-[12px] text-ink-soft">Năm học {c.schoolYear}</span>
                      </span>
                      {c.id === classId && <Check className="w-4 h-4 text-pink-500" />}
                    </button>
                  ))}
                </div>
                <button
                  className="w-full mt-1 flex items-center gap-2 px-3 py-2 rounded-xl text-pink-600 font-semibold text-[14px] hover:bg-pink-50"
                  onClick={() => {
                    close();
                    navigate('/classes?new=1');
                  }}
                >
                  <Plus className="w-4 h-4" /> Tạo lớp mới
                </button>
              </div>
            )}
          </Popover>

          <div className="hidden xl:flex items-center gap-2 h-10 px-3 rounded-btn bg-white border border-pink-100 text-[14px] text-ink-soft">
            <CalendarDays className="w-4 h-4 text-pink-400" />
            {formatDateVN(new Date(), true)}
          </div>

          {/* Thao tác nhanh */}
          <Popover
            width="w-64"
            trigger={({ toggle }) => (
              <button className="btn-primary h-10 px-3 md:px-4" onClick={toggle} data-tip="Thao tác nhanh" data-tip-pos="bottom">
                <Plus className="w-[18px] h-[18px]" />
                <span className="hidden md:inline">Thao tác nhanh</span>
              </button>
            )}
          >
            {(close) => (
              <div>
                {quick.map((q) => (
                  <button
                    key={q.to}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-pink-50 text-[14px] font-medium"
                    onClick={() => {
                      close();
                      navigate(q.to);
                    }}
                  >
                    <span className="w-8 h-8 rounded-xl bg-pink-100 text-pink-600 inline-flex items-center justify-center">
                      <q.icon className="w-4 h-4" />
                    </span>
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </Popover>

          {/* Thông báo */}
          <Popover
            width="w-80"
            trigger={({ toggle }) => (
              <button className="icon-btn relative bg-white border border-pink-100" onClick={toggle} aria-label="Thông báo" data-tip="Thông báo" data-tip-pos="bottom">
                <Bell className="w-5 h-5" />
                {alerts.length > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-pink-500 text-white text-[11px] font-bold inline-flex items-center justify-center">
                    {alerts.length}
                  </span>
                )}
              </button>
            )}
          >
            {(close) => (
              <div className="max-h-[70vh] overflow-y-auto scroll-soft">
                <p className="px-3 pt-1 pb-2 text-[12px] font-semibold text-ink-soft uppercase tracking-wide">Cần chú ý</p>
                {alerts.length === 0 && <p className="px-3 pb-2 text-sm text-ink-soft">Mọi thứ đều ổn, không có việc cần chú ý.</p>}
                {alerts.map((a) => (
                  <button
                    key={a.text}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left hover:bg-pink-50 text-[14px]"
                    onClick={() => {
                      close();
                      navigate(a.to);
                    }}
                  >
                    <span className="w-8 h-8 rounded-xl bg-cream text-cream-dark inline-flex items-center justify-center shrink-0">
                      <ClipboardList className="w-4 h-4" />
                    </span>
                    {a.text}
                  </button>
                ))}
                <p className="px-3 pt-3 pb-2 text-[12px] font-semibold text-ink-soft uppercase tracking-wide border-t border-pink-100 mt-2">Hoạt động gần đây</p>
                {(activities ?? []).length === 0 && <p className="px-3 pb-2 text-sm text-ink-soft">Chưa có hoạt động nào.</p>}
                {(activities ?? []).map((a) => (
                  <div key={a.id} className="px-3 py-1.5 text-[13.5px]">
                    <p className="text-ink">{a.message}</p>
                    <p className="text-[12px] text-ink-soft">{timeAgo(a.createdAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </Popover>

          <button
            className="flex items-center gap-2 rounded-btn hover:bg-white px-1 md:pr-3 h-10 transition"
            onClick={() => navigate('/settings')}
            data-tip="Tài khoản & cài đặt"
            data-tip-pos="bottom"
          >
            <span className="rounded-full overflow-hidden ring-2 ring-white shadow-card">
              <AnimalAvatarSVG avatarKey={settings.teacherTitle === 'cô' ? 'bunny-pink' : 'bear-sky'} size={36} />
            </span>
            <span className="hidden md:block text-left leading-tight">
              <span className="block text-[13.5px] font-semibold capitalize">{teacherCall}</span>
              <span className="block text-[11.5px] text-ink-soft">Giáo viên</span>
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
