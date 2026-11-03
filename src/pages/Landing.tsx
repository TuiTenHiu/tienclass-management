import { useEffect, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarCheck,
  Gamepad2,
  HeartHandshake,
  LogIn,
  Menu,
  MessageSquareHeart,
  MousePointerClick,
  Play,
  School,
  ShieldCheck,
  Sparkles,
  Star,
  UserRoundSearch,
  X,
} from 'lucide-react';
import { LogoMark } from '../components/illustrations';
import { DashboardMockup, ParentPhoneMockup } from '../features/landing/LandingMockups';

/**
 * Trang chủ giới thiệu công khai TienClass – Lớp học Cô Tiên.
 * Hiển thị cho khách chưa đăng nhập. Trang này KHÔNG đọc dữ liệu lớp học,
 * học sinh, điểm số hay nhận xét – mọi hình minh họa đều dùng dữ liệu giả cố định.
 */

const NAV_ITEMS = [
  { id: 'trang-chu', label: 'Trang chủ' },
  { id: 'tinh-nang', label: 'Tính năng' },
  { id: 'tro-choi', label: 'Trò chơi' },
  { id: 'phu-huynh', label: 'Phụ huynh' },
  { id: 'gioi-thieu', label: 'Giới thiệu' },
] as const;

const FEATURES = [
  {
    icon: School,
    title: 'Quản lý lớp học',
    desc: 'Danh sách học sinh, thông tin lớp và các hoạt động được sắp xếp gọn gàng, dễ tra cứu.',
    tone: 'bg-pink-100 text-pink-600',
  },
  {
    icon: CalendarCheck,
    title: 'Điểm danh',
    desc: 'Theo dõi chuyên cần mỗi ngày: đi học, đi muộn, vắng có phép chỉ với vài lần chạm.',
    tone: 'bg-mint text-mint-dark',
  },
  {
    icon: Star,
    title: 'Điểm thưởng và nề nếp',
    desc: 'Ghi nhận, khuyến khích kịp thời những hành vi tích cực để con thêm tự tin.',
    tone: 'bg-cream text-cream-dark',
  },
  {
    icon: MessageSquareHeart,
    title: 'Nhận xét học sinh',
    desc: 'Theo dõi quá trình học tập và rèn luyện qua những lời nhận xét chân thành.',
    tone: 'bg-lavender text-lavender-dark',
  },
  {
    icon: HeartHandshake,
    title: 'Kết nối phụ huynh',
    desc: 'Phụ huynh tra cứu thông tin, nhận xét của cô và cùng đồng hành với con.',
    tone: 'bg-sky text-sky-dark',
  },
  {
    icon: ShieldCheck,
    title: 'Đồng bộ và an toàn',
    desc: 'Dữ liệu được lưu trữ ổn định, đồng bộ đám mây và phân quyền truy cập bảo mật.',
    tone: 'bg-pink-100 text-pink-600',
  },
];

const STEPS = [
  {
    icon: LogIn,
    title: 'Đăng nhập tài khoản',
    desc: 'Giáo viên dùng tài khoản được cấp; phụ huynh đăng nhập tại Cổng phụ huynh.',
  },
  {
    icon: UserRoundSearch,
    title: 'Chọn lớp hoặc học sinh',
    desc: 'Giáo viên chọn lớp đang dạy, phụ huynh chọn hồ sơ của con đã được liên kết.',
  },
  {
    icon: MousePointerClick,
    title: 'Khám phá tiện ích',
    desc: 'Điểm danh, điểm thưởng, nhận xét và Mini Game – tất cả trong một nơi.',
  },
];

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function SectionHeading({ eyebrow, title, desc }: { eyebrow: string; title: string; desc?: string }) {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <span className="inline-block text-[12.5px] font-bold uppercase tracking-[0.14em] text-pink-500">{eyebrow}</span>
      <h2 className="font-display font-black text-[28px] sm:text-[34px] leading-tight text-ink mt-2">{title}</h2>
      {desc && <p className="text-ink-soft text-[15.5px] sm:text-base mt-3 leading-relaxed">{desc}</p>}
    </div>
  );
}

export default function LandingPage() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState<string>('trang-chu');

  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'TienClass – Lớp học Cô Tiên';
    return () => {
      document.title = prevTitle;
    };
  }, []);

  // Header đổ bóng nhẹ khi cuộn
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Đánh dấu mục menu tương ứng khu vực đang xem
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: [0, 0.25, 0.5] },
    );
    NAV_ITEMS.forEach((n) => {
      const el = document.getElementById(n.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const handleNav = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    setMenuOpen(false);
    setActive(id);
    scrollToSection(id);
  };

  const goLogin = () => navigate('/login');

  return (
    <div className="min-h-screen bg-white text-ink pt-16 md:pt-[72px]">
      {/* ============ 1. HEADER (Cố định fixed trên cùng) ============ */}
      <header
        className={`fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md transition-all duration-200 ${
          scrolled
            ? 'shadow-[0_4px_20px_-10px_rgba(81,69,83,0.25)] border-b border-pink-100'
            : 'border-b border-pink-50'
        }`}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 md:h-[72px] flex items-center justify-between gap-4">
          <a href="#trang-chu" onClick={(e) => handleNav(e, 'trang-chu')} className="flex items-center gap-2.5 shrink-0">
            <LogoMark size={40} />
            <span className="leading-tight">
              <span className="block font-display font-black text-[19px] text-ink">
                Tien<span className="text-pink-500">Class</span>
              </span>
              <span className="block text-[11.5px] text-ink-soft font-medium">Lớp học Cô Tiên</span>
            </span>
          </a>

          <nav className="hidden lg:flex items-center gap-1" aria-label="Điều hướng trang chủ">
            {NAV_ITEMS.map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                onClick={(e) => handleNav(e, n.id)}
                aria-current={active === n.id ? 'true' : undefined}
                className={`px-3.5 py-2 rounded-full text-[14.5px] font-semibold transition-colors ${
                  active === n.id ? 'text-pink-600 bg-pink-50' : 'text-ink hover:text-pink-600'
                }`}
              >
                {n.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary hidden sm:inline-flex" onClick={goLogin}>
              <LogIn className="w-4 h-4" /> Đăng nhập
            </button>
            <button
              type="button"
              className="icon-btn lg:hidden"
              aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'}
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
              onClick={() => setMenuOpen((v) => !v)}
            >
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <div id="landing-mobile-menu" className="lg:hidden border-t border-pink-100 bg-white animate-fadeIn">
            <nav className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-col" aria-label="Điều hướng trang chủ (di động)">
              {NAV_ITEMS.map((n) => (
                <a
                  key={n.id}
                  href={`#${n.id}`}
                  onClick={(e) => handleNav(e, n.id)}
                  className={`px-3 py-3 rounded-xl text-[15px] font-semibold ${
                    active === n.id ? 'text-pink-600 bg-pink-50' : 'text-ink'
                  }`}
                >
                  {n.label}
                </a>
              ))}
              <button type="button" className="btn-primary mt-2 sm:hidden" onClick={goLogin}>
                <LogIn className="w-4 h-4" /> Đăng nhập
              </button>
            </nav>
          </div>
        )}
      </header>

      <main>
        {/* ============ 2. HERO ============ */}
        <section id="trang-chu" className="relative overflow-hidden scroll-mt-20">
          <div className="absolute inset-0 bg-gradient-to-b from-pink-50 via-pink-50/60 to-white" aria-hidden="true" />
          <div
            className="absolute -top-24 -right-24 w-[420px] h-[420px] rounded-full bg-pink-100/70 blur-3xl"
            aria-hidden="true"
          />
          <div className="absolute top-40 -left-32 w-[300px] h-[300px] rounded-full bg-lavender/40 blur-3xl" aria-hidden="true" />

          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-10 sm:pt-14 lg:pt-20 pb-16 lg:pb-24 grid lg:grid-cols-[1.02fr_1fr] gap-12 lg:gap-10 items-center">
            <div className="text-center lg:text-left">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white border border-pink-100 px-3 py-1 text-[12.5px] font-semibold text-pink-600 shadow-card">
                <Sparkles className="w-3.5 h-3.5" /> Không gian lớp học số cho bậc tiểu học
              </span>
              <h1 className="font-display font-black text-ink text-[36px] leading-[1.12] sm:text-[46px] lg:text-[54px] mt-5">
                Mỗi ngày đến lớp là <span className="text-pink-500">một ngày vui!</span>
              </h1>
              <p className="text-ink-soft text-[16px] sm:text-[17px] leading-relaxed mt-5 max-w-xl mx-auto lg:mx-0">
                Không gian học tập số dành cho giáo viên, học sinh và phụ huynh. Cùng đồng hành, theo dõi và lưu giữ những
                hành trình trưởng thành đáng yêu.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                <button type="button" className="btn-primary btn-lg" onClick={goLogin}>
                  Đăng nhập ngay <ArrowRight className="w-4 h-4" />
                </button>
                <a
                  href="#tinh-nang"
                  onClick={(e) => handleNav(e, 'tinh-nang')}
                  className="btn-outline btn-lg"
                >
                  Khám phá tính năng
                </a>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 justify-center lg:justify-start text-[13.5px] text-ink-soft">
                {['Dành cho giáo viên', 'Cổng phụ huynh riêng', 'Dùng tốt trên điện thoại'].map((t) => (
                  <li key={t} className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-pink-400" /> {t}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative max-w-xl w-full mx-auto lg:mr-0">
              <DashboardMockup />
            </div>
          </div>
        </section>

        {/* ============ 3. TIỆN ÍCH NỔI BẬT ============ */}
        <section id="tinh-nang" className="scroll-mt-20 py-16 sm:py-20 lg:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <SectionHeading
              eyebrow="Tiện ích nổi bật"
              title="Mọi việc của lớp học, gọn gàng trong một nơi"
              desc="Những công cụ thiết thực giúp cô giáo tiết kiệm thời gian và giúp phụ huynh hiểu con hơn mỗi ngày."
            />
            <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {FEATURES.map((f) => (
                <article
                  key={f.title}
                  className="group rounded-card bg-white border border-pink-100 p-6 shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-pink-200 hover:shadow-soft motion-reduce:transform-none"
                >
                  <span className={`w-12 h-12 rounded-2xl flex items-center justify-center ${f.tone}`}>
                    <f.icon className="w-6 h-6" />
                  </span>
                  <h3 className="font-display font-extrabold text-[18px] mt-4">{f.title}</h3>
                  <p className="text-ink-soft text-[14.5px] leading-relaxed mt-1.5">{f.desc}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ============ 4. THẾ GIỚI MINI GAME ============ */}
        <section id="tro-choi" className="scroll-mt-20 py-16 sm:py-20 lg:py-24 bg-pink-50/70">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <SectionHeading
              eyebrow="Thế giới Mini Game"
              title="Thế giới Mini Game"
              desc="Học mà chơi – Chơi mà học! Những trò chơi sinh động giúp lớp học thêm sôi nổi và gắn kết."
            />

            <div className="mt-12 grid lg:grid-cols-[1.35fr_1fr] gap-6">
              {/* Game chính: Chú chó đuổi bắt */}
              <article className="rounded-[24px] bg-white border border-pink-100 shadow-card overflow-hidden">
                <div className="relative aspect-[1000/560] bg-pink-100">
                  <img
                    src="/assets/landing/schoolyard.webp"
                    alt="Sân trường trong trò chơi Chú chó đuổi bắt của TienClass"
                    width={1000}
                    height={560}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {/* Nhân vật thật trong game */}
                  <img
                    src="/assets/game/girl_run.png"
                    alt=""
                    width={58}
                    height={84}
                    loading="lazy"
                    className="absolute left-[30%] bottom-[9%] w-[7%] drop-shadow"
                  />
                  <img
                    src="/assets/game/boy_run.png"
                    alt=""
                    width={58}
                    height={84}
                    loading="lazy"
                    className="absolute left-[39%] bottom-[6%] w-[7%] drop-shadow"
                  />
                  <img
                    src="/assets/game/corgi_run.png"
                    alt=""
                    width={108}
                    height={90}
                    loading="lazy"
                    className="absolute left-[12%] bottom-[5%] w-[12%] drop-shadow"
                  />
                  <span className="absolute top-3 left-3 chip bg-white/95 text-pink-600 shadow-card">
                    <Star className="w-3.5 h-3.5 fill-pink-500 text-pink-500" /> Trò chơi nổi bật
                  </span>
                </div>
                <div className="p-6 sm:p-7">
                  <h3 className="font-display font-black text-[24px]">Chú chó đuổi bắt</h3>
                  <p className="text-ink-soft text-[15px] leading-relaxed mt-2">
                    Sân trường hoạt hình 2D sinh động: các bạn rón rén vào lớp, một quyển sách rơi đánh thức chú Corgi
                    đáng yêu và cuộc rượt đuổi bắt đầu – người được chọn sẽ lên bảng!
                  </p>
                  <ul className="mt-4 grid sm:grid-cols-2 gap-2 text-[14px]">
                    {['Chọn ngẫu nhiên công bằng', 'Gọi tên học sinh trong lớp', 'Hoạt hình 2D vui nhộn', 'Phù hợp màn chiếu lớp học'].map(
                      (t) => (
                        <li key={t} className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-mint flex items-center justify-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-mint-dark" />
                          </span>
                          {t}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              </article>

              <div className="flex flex-col gap-6">
                {/* Game thứ hai: UFO gắp học sinh */}
                <article className="rounded-[24px] bg-white border border-pink-100 shadow-card overflow-hidden">
                  <div className="relative aspect-[16/9] bg-lavender">
                    <img
                      src="/assets/landing/ufo-school.webp"
                      alt="Sân trường về đêm trong trò chơi UFO gắp học sinh"
                      width={720}
                      height={405}
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-6">
                    <h3 className="font-display font-black text-[20px]">UFO gắp học sinh</h3>
                    <p className="text-ink-soft text-[14.5px] leading-relaxed mt-1.5">
                      Đĩa bay hạ cánh xuống sân trường, quét tia sáng và “gắp” ngẫu nhiên một bạn lên để gọi tên.
                    </p>
                  </div>
                </article>

                <div className="rounded-[24px] bg-white border border-pink-100 p-6 shadow-card flex-1 flex flex-col justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="w-11 h-11 rounded-2xl bg-pink-100 text-pink-600 flex items-center justify-center shrink-0">
                      <Gamepad2 className="w-5 h-5" />
                    </span>
                    <p className="text-[14.5px] text-ink-soft leading-relaxed">
                      Trò chơi dùng danh sách lớp của giáo viên, vì vậy cần đăng nhập tài khoản giáo viên để bắt đầu.
                    </p>
                  </div>
                  <button type="button" className="btn-primary btn-lg w-full" onClick={() => navigate('/games')}>
                    <Play className="w-4 h-4 fill-white" /> Khám phá trò chơi
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============ 5. DÀNH CHO PHỤ HUYNH ============ */}
        <section id="phu-huynh" className="scroll-mt-20 py-16 sm:py-20 lg:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div className="order-2 lg:order-1 relative">
              <div
                className="absolute inset-x-6 top-10 bottom-0 rounded-[40px] bg-gradient-to-br from-pink-100 via-lavender/50 to-mint/60"
                aria-hidden="true"
              />
              <div className="relative py-6">
                <ParentPhoneMockup />
              </div>
            </div>

            <div className="order-1 lg:order-2 text-center lg:text-left">
              <span className="inline-block text-[12.5px] font-bold uppercase tracking-[0.14em] text-pink-500">
                Dành cho phụ huynh
              </span>
              <h2 className="font-display font-black text-[28px] sm:text-[34px] leading-tight mt-2">
                Cổng phụ huynh – đồng hành cùng con mỗi ngày
              </h2>
              <p className="text-ink-soft text-[15.5px] sm:text-base mt-3 leading-relaxed">
                Phụ huynh đăng nhập bằng tài khoản riêng và liên kết với con qua mã mời do giáo viên cấp. Mọi thông tin
                chỉ hiển thị cho đúng phụ huynh của học sinh đó.
              </p>
              <ul className="mt-7 space-y-4 text-left max-w-md mx-auto lg:mx-0">
                {[
                  { icon: MessageSquareHeart, tone: 'bg-pink-100 text-pink-600', t: 'Nhận xét của cô', d: 'Đọc nhận xét về học tập và rèn luyện của con.' },
                  { icon: CalendarCheck, tone: 'bg-mint text-mint-dark', t: 'Tình hình điểm danh', d: 'Nắm được ngày con đi học, đi muộn hay vắng có phép.' },
                  { icon: Star, tone: 'bg-cream text-cream-dark', t: 'Điểm thưởng, nề nếp', d: 'Cùng khen ngợi những cố gắng nhỏ của con ở lớp.' },
                ].map((b) => (
                  <li key={b.t} className="flex gap-3.5">
                    <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${b.tone}`}>
                      <b.icon className="w-5 h-5" />
                    </span>
                    <div>
                      <p className="font-display font-extrabold text-[16px]">{b.t}</p>
                      <p className="text-ink-soft text-[14.5px]">{b.d}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex justify-center lg:justify-start">
                <button type="button" className="btn-secondary btn-lg" onClick={() => navigate('/parent/portal')}>
                  Vào Cổng phụ huynh <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ============ 6. HƯỚNG DẪN BẮT ĐẦU ============ */}
        <section id="gioi-thieu" className="scroll-mt-20 py-16 sm:py-20 lg:py-24 bg-gradient-to-b from-white to-pink-50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <SectionHeading
              eyebrow="Bắt đầu với TienClass"
              title="Chỉ 3 bước để bắt đầu"
              desc="TienClass – Lớp học Cô Tiên được xây dựng để việc quản lý lớp nhẹ nhàng hơn và mỗi ngày đến trường của con thêm vui."
            />
            <div className="relative mt-12">
            <div
              className="hidden md:block absolute top-[50px] left-[16%] right-[16%] border-t-2 border-dashed border-pink-200"
              aria-hidden="true"
            />
            <ol className="relative grid md:grid-cols-3 gap-5 md:gap-6">
              {STEPS.map((s, i) => (
                <li
                  key={s.title}
                  className="relative rounded-card bg-white border border-pink-100 p-6 shadow-card text-center"
                >
                  <span className="relative mx-auto w-[52px] h-[52px] rounded-2xl bg-pink-500 text-white flex items-center justify-center shadow-soft">
                    <s.icon className="w-6 h-6" />
                    <span className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white border-2 border-pink-200 text-pink-600 text-[12px] font-black flex items-center justify-center">
                      {i + 1}
                    </span>
                  </span>
                  <h3 className="font-display font-extrabold text-[18px] mt-4">{s.title}</h3>
                  <p className="text-ink-soft text-[14.5px] leading-relaxed mt-1.5">{s.desc}</p>
                </li>
              ))}
            </ol>
            </div>
            <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
              <button type="button" className="btn-primary btn-lg" onClick={goLogin}>
                <LogIn className="w-4 h-4" /> Đăng nhập giáo viên
              </button>
              <button type="button" className="btn-outline btn-lg" onClick={() => navigate('/parent/portal')}>
                Đăng nhập phụ huynh
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* ============ 7. FOOTER ============ */}
      <footer className="bg-white border-t border-pink-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <LogoMark size={40} />
              <span className="leading-tight">
                <span className="block font-display font-black text-[19px]">
                  Tien<span className="text-pink-500">Class</span>
                </span>
                <span className="block text-[11.5px] text-ink-soft font-medium">Lớp học Cô Tiên</span>
              </span>
            </div>
            <p className="text-ink-soft text-[14.5px] leading-relaxed mt-4 max-w-sm">
              Không gian học tập số giúp giáo viên, học sinh và phụ huynh cùng kết nối, theo dõi và lưu giữ hành trình
              trưởng thành của các con.
            </p>
            <p className="font-display font-extrabold text-pink-600 mt-4">Kết nối yêu thương – Đồng hành trưởng thành</p>
          </div>

          <div>
            <p className="font-display font-extrabold text-[15px]">Khám phá</p>
            <ul className="mt-3 space-y-2 text-[14.5px] text-ink-soft">
              {NAV_ITEMS.slice(1).map((n) => (
                <li key={n.id}>
                  <a href={`#${n.id}`} onClick={(e) => handleNav(e, n.id)} className="hover:text-pink-600">
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="font-display font-extrabold text-[15px]">Hỗ trợ</p>
            <ul className="mt-3 space-y-2 text-[14.5px] text-ink-soft">
              <li>
                <button type="button" onClick={goLogin} className="hover:text-pink-600">
                  Đăng nhập giáo viên
                </button>
              </li>
              <li>
                <button type="button" onClick={() => navigate('/parent/portal')} className="hover:text-pink-600">
                  Cổng phụ huynh
                </button>
              </li>
              <li className="leading-relaxed">
                Cần tài khoản hoặc mã liên kết? Vui lòng liên hệ giáo viên chủ nhiệm của lớp.
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-pink-100">
          <p className="max-w-6xl mx-auto px-4 sm:px-6 py-5 text-[13px] text-ink-soft text-center md:text-left">
            © {new Date().getFullYear()} TienClass – Lớp học Cô Tiên. Bảo lưu mọi quyền.
          </p>
        </div>
      </footer>
    </div>
  );
}
