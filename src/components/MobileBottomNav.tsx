import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarCheck,
  Star,
  Users,
  Menu,
} from 'lucide-react';

interface MobileBottomNavProps {
  onOpenMenu: () => void;
}

export function MobileBottomNav({ onOpenMenu }: MobileBottomNavProps) {
  const mainTabs = [
    { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
    { to: '/attendance', label: 'Điểm danh', icon: CalendarCheck },
    { to: '/points', label: 'Thi đua', icon: Star },
    { to: '/students', label: 'Học sinh', icon: Users },
  ];

  return (
    <nav
      className="no-print lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-pink-100 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      aria-label="Điều hướng di động nhanh"
    >
      <div className="grid grid-cols-5 h-14 items-center px-1">
        {mainTabs.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center h-full py-1 text-center select-none transition-colors ${
                isActive ? 'text-pink-600 font-bold' : 'text-ink-soft hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`w-10 h-7 flex items-center justify-center rounded-full transition-all ${
                    isActive ? 'bg-pink-100 text-pink-600' : ''
                  }`}
                >
                  <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
                </span>
                <span className="text-[11px] leading-tight mt-0.5 truncate max-w-full px-0.5">
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}

        {/* Nút Mở Menu đầy đủ (Xem thêm) */}
        <button
          type="button"
          onClick={onOpenMenu}
          className="flex flex-col items-center justify-center h-full py-1 text-center text-ink-soft hover:text-ink select-none active:scale-95 transition"
          aria-label="Xem thêm chức năng"
        >
          <span className="w-10 h-7 flex items-center justify-center rounded-full text-ink-soft">
            <Menu className="w-5 h-5" strokeWidth={2} />
          </span>
          <span className="text-[11px] leading-tight mt-0.5 truncate max-w-full px-0.5">
            Thêm
          </span>
        </button>
      </div>
    </nav>
  );
}
