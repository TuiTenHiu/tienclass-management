import {
  Bell,
  CalendarCheck,
  CheckCircle2,
  Gamepad2,
  Home,
  MessageSquareHeart,
  Star,
  Users,
} from 'lucide-react';
import { AnimalAvatarSVG } from '../../components/avatars';
import { LogoMark } from '../../components/illustrations';

/**
 * Mockup giao diện TienClass dùng cho trang giới thiệu công khai.
 * TOÀN BỘ dữ liệu ở đây là dữ liệu minh họa cố định (tên giả, số liệu giả),
 * không đọc từ IndexedDB / Supabase và không chứa thông tin học sinh thật.
 */

const DEMO_ROWS = [
  { name: 'Bạn Thỏ Hồng', avatar: 'bunny-pink', status: 'Có mặt', tone: 'bg-mint text-mint-dark' },
  { name: 'Bạn Gấu Nâu', avatar: 'bear-cream', status: 'Có mặt', tone: 'bg-mint text-mint-dark' },
  { name: 'Bạn Mèo Mướp', avatar: 'cat-lavender', status: 'Vắng có phép', tone: 'bg-cream text-cream-dark' },
  { name: 'Bạn Gà Con', avatar: 'chick-sky', status: 'Có mặt', tone: 'bg-mint text-mint-dark' },
];

/** Mockup màn hình tổng quan lớp học (desktop) */
export function DashboardMockup() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="rounded-[22px] bg-white border border-pink-100 shadow-[0_24px_60px_-28px_rgba(180,72,122,0.35)] overflow-hidden">
        {/* Thanh trình duyệt */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-pink-100 bg-pink-50/70">
          <span className="w-2.5 h-2.5 rounded-full bg-pink-300" />
          <span className="w-2.5 h-2.5 rounded-full bg-cream" />
          <span className="w-2.5 h-2.5 rounded-full bg-mint" />
          <span className="ml-3 flex-1 h-5 rounded-full bg-white border border-pink-100 text-[10px] text-ink-soft flex items-center px-3">
            tienclass · Tổng quan lớp học
          </span>
        </div>

        <div className="flex">
          {/* Sidebar thu gọn */}
          <div className="hidden sm:flex flex-col items-center gap-3 py-4 px-2.5 border-r border-pink-100 bg-white">
            <LogoMark size={30} />
            {[Home, Users, CalendarCheck, Star, MessageSquareHeart, Gamepad2].map((Icon, i) => (
              <span
                key={i}
                className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                  i === 0 ? 'bg-pink-100 text-pink-600' : 'text-ink-soft/70'
                }`}
              >
                <Icon className="w-4 h-4" />
              </span>
            ))}
          </div>

          {/* Nội dung */}
          <div className="flex-1 p-4 sm:p-5 bg-pink-50/40 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10.5px] text-ink-soft">Chào buổi sáng!</p>
                <p className="font-display font-extrabold text-[15px] text-ink truncate">Lớp 3A · Năm học mới</p>
              </div>
              <span className="chip bg-white border border-pink-100 text-pink-600 text-[10.5px] shrink-0">
                Thứ Hai
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-2.5 mt-3">
              {[
                { label: 'Sĩ số', value: '32', tone: 'bg-white text-ink', icon: Users, ic: 'text-pink-500' },
                { label: 'Có mặt', value: '31', tone: 'bg-white text-ink', icon: CheckCircle2, ic: 'text-mint-dark' },
                { label: 'Điểm thưởng', value: '+86', tone: 'bg-white text-ink', icon: Star, ic: 'text-cream-dark' },
              ].map((s) => (
                <div key={s.label} className={`rounded-2xl border border-pink-100 p-2.5 ${s.tone}`}>
                  <s.icon className={`w-4 h-4 ${s.ic}`} />
                  <p className="font-display font-black text-lg leading-tight mt-1">{s.value}</p>
                  <p className="text-[10px] text-ink-soft">{s.label}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-2xl bg-white border border-pink-100 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="font-display font-extrabold text-[12.5px]">Điểm danh hôm nay</p>
                <span className="text-[10px] text-pink-600 font-semibold">Xem tất cả</span>
              </div>
              <ul className="space-y-1.5">
                {DEMO_ROWS.map((r) => (
                  <li key={r.name} className="flex items-center gap-2.5">
                    <AnimalAvatarSVG avatarKey={r.avatar} size={26} />
                    <span className="text-[11.5px] font-semibold text-ink flex-1 truncate">{r.name}</span>
                    <span className={`chip text-[10px] px-2 py-0 ${r.tone}`}>{r.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Thẻ nổi nhỏ */}
      <div className="hidden md:flex absolute -left-6 bottom-10 items-center gap-2.5 rounded-2xl bg-white border border-pink-100 shadow-card px-3.5 py-2.5">
        <span className="w-8 h-8 rounded-xl bg-cream flex items-center justify-center">
          <Star className="w-4 h-4 text-cream-dark" />
        </span>
        <div>
          <p className="text-[11.5px] font-bold text-ink leading-tight">+2 Phát biểu xây dựng bài</p>
          <p className="text-[10px] text-ink-soft">Vừa ghi nhận</p>
        </div>
      </div>
      <div className="hidden md:flex absolute -right-4 top-16 items-center gap-2 rounded-2xl bg-white border border-pink-100 shadow-card px-3 py-2">
        <CheckCircle2 className="w-4 h-4 text-mint-dark" />
        <p className="text-[11px] font-bold text-ink">Đã điểm danh xong</p>
      </div>
    </div>
  );
}

/** Mockup giao diện Cổng phụ huynh trên điện thoại */
export function ParentPhoneMockup() {
  const week = [
    { d: 'T2', s: 'ok' },
    { d: 'T3', s: 'ok' },
    { d: 'T4', s: 'ok' },
    { d: 'T5', s: 'excused' },
    { d: 'T6', s: 'ok' },
  ];
  return (
    <div className="relative mx-auto w-[270px] sm:w-[290px]" aria-hidden="true">
      <div className="rounded-[40px] bg-ink p-2.5 shadow-[0_30px_60px_-30px_rgba(81,69,83,0.55)]">
        <div className="rounded-[32px] bg-pink-50 overflow-hidden">
          {/* Status bar */}
          <div className="relative h-7 flex items-center justify-between px-6 text-[10px] font-semibold text-ink">
            <span>7:30</span>
            <span className="absolute left-1/2 -translate-x-1/2 top-1.5 w-20 h-4 rounded-full bg-ink" />
            <span>100%</span>
          </div>

          <div className="px-3.5 pb-5 pt-1 space-y-2.5">
            {/* Thông tin con (minh họa) */}
            <div className="flex items-center gap-2.5 rounded-2xl bg-white border border-pink-100 p-2.5">
              <AnimalAvatarSVG avatarKey="bunny-pink" size={36} />
              <div className="flex-1 min-w-0">
                <p className="font-display font-extrabold text-[13px] text-ink leading-tight">Bé Thỏ Hồng</p>
                <p className="text-[10px] text-ink-soft">Lớp 3A · Dữ liệu minh họa</p>
              </div>
              <span className="relative w-7 h-7 rounded-full bg-pink-100 flex items-center justify-center">
                <Bell className="w-3.5 h-3.5 text-pink-600" />
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-pink-500" />
              </span>
            </div>

            {/* Nhận xét tuần */}
            <div className="rounded-2xl bg-white border border-pink-100 p-3">
              <div className="flex items-center gap-1.5">
                <MessageSquareHeart className="w-3.5 h-3.5 text-pink-500" />
                <p className="text-[11.5px] font-bold text-ink">Nhận xét tuần</p>
              </div>
              <p className="text-[10.5px] text-ink-soft mt-1.5 leading-relaxed">
                Con chăm chỉ, hăng hái phát biểu và biết giúp đỡ bạn bè. Cô khen con nhé!
              </p>
            </div>

            {/* Điểm danh + điểm thưởng */}
            <div className="grid grid-cols-5 gap-2">
              <div className="col-span-3 rounded-2xl bg-white border border-pink-100 p-2.5">
                <div className="flex items-center gap-1.5">
                  <CalendarCheck className="w-3.5 h-3.5 text-mint-dark" />
                  <p className="text-[11px] font-bold text-ink">Điểm danh</p>
                </div>
                <div className="flex justify-between mt-2">
                  {week.map((w) => (
                    <div key={w.d} className="flex flex-col items-center gap-1">
                      <span
                        className={`w-5 h-5 rounded-full flex items-center justify-center ${
                          w.s === 'ok' ? 'bg-mint' : 'bg-cream'
                        }`}
                      >
                        {w.s === 'ok' ? (
                          <CheckCircle2 className="w-3 h-3 text-mint-dark" />
                        ) : (
                          <span className="text-[8px] font-bold text-cream-dark">P</span>
                        )}
                      </span>
                      <span className="text-[8.5px] text-ink-soft">{w.d}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="col-span-2 rounded-2xl bg-pink-500 text-white p-2.5 flex flex-col justify-between">
                <Star className="w-3.5 h-3.5 fill-white" />
                <div>
                  <p className="font-display font-black text-xl leading-none">+24</p>
                  <p className="text-[9.5px] opacity-90 mt-0.5">Điểm thưởng</p>
                </div>
              </div>
            </div>

            {/* Thông báo */}
            <div className="rounded-2xl bg-white border border-pink-100 p-3">
              <div className="flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-lavender-dark" />
                <p className="text-[11.5px] font-bold text-ink">Thông báo</p>
              </div>
              <ul className="mt-1.5 space-y-1.5">
                <li className="flex items-start gap-2 text-[10.5px] text-ink-soft">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-lavender-dark shrink-0" />
                  Cô đã cập nhật nhận xét tuần mới.
                </li>
                <li className="flex items-start gap-2 text-[10.5px] text-ink-soft">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-pink-400 shrink-0" />
                  Con được cộng điểm “Giữ gìn vệ sinh lớp”.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
