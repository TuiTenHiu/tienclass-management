import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  School,
  Users,
  CalendarCheck,
  Star,
  MessageSquareHeart,
  Gamepad2,
  BarChart3,
  Settings,
  X,
  MessageCircle,
  DatabaseBackup,
  type LucideIcon,
} from 'lucide-react';
import { LogoMark } from './illustrations';

export const NAV_ITEMS: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/classes', label: 'Lớp học của tôi', icon: School },
  { to: '/students', label: 'Danh sách học sinh', icon: Users },
  { to: '/attendance', label: 'Điểm danh', icon: CalendarCheck },
  { to: '/points', label: 'Điểm thưởng & thi đua', icon: Star },
  { to: '/comments', label: 'Nhận xét học sinh', icon: MessageSquareHeart },
  { to: '/parent-links', label: 'Sổ liên lạc & Zalo', icon: MessageCircle },
  { to: '/games', label: 'Trò chơi lớp học', icon: Gamepad2 },
  { to: '/reports', label: 'Báo cáo thống kê', icon: BarChart3 },
  { to: '/settings', label: 'Cài đặt', icon: Settings },
  { to: '/migration', label: 'Di trú dữ liệu', icon: DatabaseBackup },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {/* lớp phủ trên màn hình nhỏ */}
      <div
        className={`fixed inset-0 bg-ink/25 z-40 lg:hidden transition-opacity no-print ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />
      <aside
        className={`no-print fixed lg:sticky top-0 left-0 z-50 h-screen w-[264px] shrink-0 p-3 lg:p-4 transition-transform duration-200
          ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
        aria-label="Điều hướng chính"
      >
        <div className="h-full bg-white rounded-[26px] border border-pink-100 shadow-card flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 px-5 pt-5 pb-4">
            <LogoMark size={44} />
            <div className="min-w-0">
              <div className="font-display font-black text-[19px] leading-tight text-ink">
                Pink <span className="text-pink-500">Classroom</span>
              </div>
              <div className="text-[12px] text-ink-soft">Lớp học hạnh phúc</div>
            </div>
            <button className="icon-btn ml-auto lg:hidden" onClick={onClose} aria-label="Đóng menu">
              <X className="w-5 h-5" />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto scroll-soft px-3 py-1 space-y-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3.5 h-11 rounded-[14px] text-[14.5px] font-semibold transition-all
                  ${isActive ? 'bg-pink-100 text-pink-700' : 'text-ink-soft hover:bg-pink-50 hover:text-ink'}`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={`w-8 h-8 rounded-xl inline-flex items-center justify-center ${isActive ? 'bg-white text-pink-500 shadow-card' : ''}`}>
                      <Icon className="w-[18px] h-[18px]" strokeWidth={2.2} />
                    </span>
                    {label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="m-3 rounded-[20px] bg-gradient-to-br from-pink-100 to-lavender/60 p-4 relative overflow-hidden">
            <svg className="absolute -right-2 -top-2 opacity-70" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
              <path d="M32 6 l6 13 14 2 -10 10 2.4 14 -12.4 -6.6 -12.4 6.6 2.4 -14 -10 -10 14 -2z" fill="#fff" />
            </svg>
            <p className="font-display font-extrabold text-[14px] text-ink relative">Mỗi ngày một niềm vui</p>
            <p className="text-[12.5px] text-ink-soft mt-0.5 relative">Cùng xây dựng lớp học hạnh phúc nhé!</p>
          </div>
        </div>
      </aside>
    </>
  );
}
