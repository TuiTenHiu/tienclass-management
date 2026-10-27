import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  ArrowLeft,
  Lock,
  LogOut,
  KeyRound,
  UserPlus,
  LogIn,
  CalendarCheck,
  Sparkles,
  MessageSquareHeart,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  PlusCircle,
} from 'lucide-react';
import { LogoMark } from '../components/illustrations';
import { StudentAvatar } from '../components/StudentAvatar';
import { useAuth } from '../state/AuthContext';
import { useToast } from '../components/ToastNotification';
import {
  claimParentInvitationToken,
  fetchParentPortalData,
} from '../data/repo';
import { formatDateVN, formatDateTimeVN } from '../lib/utils';
import type { AttendanceStatus, ParentPortalStudentData } from '../types';

const ATTENDANCE_LABELS: Record<
  AttendanceStatus,
  { label: string; badgeClass: string }
> = {
  present: { label: 'Có mặt', badgeClass: 'bg-mint text-mint-dark' },
  late: { label: 'Đi muộn', badgeClass: 'bg-cream text-cream-dark' },
  excused: { label: 'Vắng có phép', badgeClass: 'bg-sky text-sky-dark' },
  unexcused: { label: 'Vắng không phép', badgeClass: 'bg-red-100 text-danger' },
};

export default function ParentPortalPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { configured, loading: authLoading, user, profile, signIn, signUp, signOut } = useAuth();

  // Xóa ngay mọi tham số nhạy cảm nếu vô tình xuất hiện trên URL (không bao giờ lưu/đọc raw_token từ URL)
  useEffect(() => {
    if (searchParams.has('token')) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Trạng thái form Đăng nhập / Đăng ký Phụ huynh
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Trạng thái dữ liệu Cổng Phụ Huynh
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [studentsData, setStudentsData] = useState<ParentPortalStudentData[]>([]);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'comments' | 'points' | 'attendance'>('comments');

  // Trạng thái nhập mã mời liên kết học sinh
  const [rawTokenInput, setRawTokenInput] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [showAddChildForm, setShowAddChildForm] = useState(false);

  const isParentRole = profile?.role === 'parent';

  const loadPortalData = useCallback(async () => {
    if (!user || !isParentRole) {
      setStudentsData([]);
      return;
    }
    setPortalLoading(true);
    setPortalError(null);
    try {
      const list = await fetchParentPortalData();
      setStudentsData(list);
      setSelectedStudentId((prev) => {
        if (prev && list.some((item) => item.student.id === prev)) return prev;
        return list[0]?.student.id ?? null;
      });
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : 'Không thể tải dữ liệu Cổng Phụ Huynh.');
    } finally {
      setPortalLoading(false);
    }
  }, [user, isParentRole]);

  useEffect(() => {
    if (user && isParentRole) {
      void loadPortalData();
    } else {
      setStudentsData([]);
      setSelectedStudentId(null);
    }
  }, [user, isParentRole, loadPortalData]);

  const handleAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!email.trim() || !password) {
      setAuthError('Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }
    if (authMode === 'signup' && password.length < 6) {
      setAuthError('Mật khẩu cần có ít nhất 6 ký tự.');
      return;
    }

    setAuthSubmitting(true);
    try {
      if (authMode === 'signin') {
        const res = await signIn(email, password);
        if (!res.ok) {
          setAuthError(res.message || 'Đăng nhập thất bại.');
          return;
        }
        toast.success('Đăng nhập Cổng Phụ Huynh thành công!');
      } else {
        const res = await signUp(email, password, fullName || 'Phụ huynh học sinh');
        if (!res.ok) {
          setAuthError(res.message || 'Đăng ký tài khoản thất bại.');
          return;
        }
        toast.success('Đăng ký tài khoản Phụ huynh thành công!');
      }
      setPassword('');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleClaimToken = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = rawTokenInput.trim();
    if (!cleaned) {
      toast.error('Vui lòng nhập mã mời liên kết do giáo viên cung cấp.');
      return;
    }
    setClaiming(true);
    try {
      const res = await claimParentInvitationToken(cleaned);
      setRawTokenInput('');
      setShowAddChildForm(false);
      toast.success(res.message || 'Liên kết học sinh thành công!');
      await loadPortalData();
      if (res.studentId) {
        setSelectedStudentId(res.studentId);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không thể kích hoạt mã mời.');
    } finally {
      setClaiming(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setStudentsData([]);
    setSelectedStudentId(null);
    setRawTokenInput('');
    toast.info('Đã đăng xuất tài khoản.');
  };

  const currentStudentData = useMemo(() => {
    if (!studentsData.length) return null;
    return studentsData.find((s) => s.student.id === selectedStudentId) ?? studentsData[0];
  }, [studentsData, selectedStudentId]);

  const studentStats = useMemo(() => {
    if (!currentStudentData) {
      return { totalPoints: 0, rewardPoints: 0, penaltyPoints: 0, presentCount: 0, absentCount: 0, lateCount: 0 };
    }
    let totalPoints = 0;
    let rewardPoints = 0;
    let penaltyPoints = 0;
    for (const p of currentStudentData.points) {
      if (p.undone) continue;
      totalPoints += p.delta;
      if (p.delta > 0) rewardPoints += p.delta;
      else penaltyPoints += p.delta;
    }
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    for (const a of currentStudentData.attendance) {
      if (a.status === 'present') presentCount++;
      else if (a.status === 'late') lateCount++;
      else if (a.status === 'excused' || a.status === 'unexcused') absentCount++;
    }
    return { totalPoints, rewardPoints, penaltyPoints, presentCount, absentCount, lateCount };
  }, [currentStudentData]);

  return (
    <div className="min-h-screen bg-pink-50 flex flex-col justify-between p-4 md:p-6 text-ink">
      <div className="max-w-3xl mx-auto w-full pt-4 pb-12 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <LogoMark size={44} />
            <div>
              <h1 className="font-display font-black text-xl text-ink">
                Pink <span className="text-pink-500">Classroom</span>
              </h1>
              <p className="text-xs text-ink-soft">Cổng thông tin Phụ huynh Học sinh</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {user && (
              <button className="btn-outline btn-sm text-xs" onClick={handleSignOut}>
                <LogOut className="w-3.5 h-3.5" /> Đăng xuất
              </button>
            )}
            <button className="btn-ghost btn-sm text-xs" onClick={() => navigate('/')}>
              <ArrowLeft className="w-4 h-4" /> Về trang chủ
            </button>
          </div>
        </div>

        {/* Trạng thái chưa cấu hình Supabase */}
        {!configured ? (
          <div className="card p-6 border-2 border-pink-200 space-y-3">
            <div className="flex items-center gap-2 text-danger font-bold">
              <AlertCircle className="w-5 h-5" />
              Chưa cấu hình kết nối máy chủ Supabase
            </div>
            <p className="text-sm text-ink-soft">
              Cổng phụ huynh yêu cầu kết nối Supabase để xác thực tài khoản và kiểm tra quyền truy cập RLS.
            </p>
          </div>
        ) : authLoading ? (
          <div className="card p-8 text-center text-sm text-ink-soft">
            Đang kiểm tra phiên đăng nhập...
          </div>
        ) : !user || !profile ? (
          /* Khung Đăng nhập / Đăng ký tài khoản Phụ huynh */
          <div className="card p-6 md:p-8 space-y-6 shadow-soft border-2 border-pink-200">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-pink-100 text-pink-600 flex items-center justify-center shrink-0">
                <Lock className="w-6 h-6" />
              </div>
              <div>
                <span className="chip bg-pink-100 text-pink-600 text-xs font-bold mb-1">
                  Bảo mật dữ liệu học sinh (Supabase RLS)
                </span>
                <h2 className="font-display font-extrabold text-2xl text-ink">
                  Đăng nhập Cổng Phụ Huynh
                </h2>
                <p className="text-sm text-ink-soft mt-1">
                  Vui lòng đăng nhập hoặc đăng ký tài khoản Phụ huynh, sau đó nhập <b>Mã mời liên kết</b> do giáo viên chủ nhiệm cung cấp để xem kết quả học tập của con.
                </p>
              </div>
            </div>

            <div className="flex gap-2 border-b border-pink-100 pb-3">
              <button
                type="button"
                className={authMode === 'signin' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                onClick={() => {
                  setAuthMode('signin');
                  setAuthError(null);
                }}
              >
                <LogIn className="w-4 h-4" /> Đăng nhập
              </button>
              <button
                type="button"
                className={authMode === 'signup' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                onClick={() => {
                  setAuthMode('signup');
                  setAuthError(null);
                }}
              >
                <UserPlus className="w-4 h-4" /> Đăng ký tài khoản Phụ huynh
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-4 max-w-md">
              {authMode === 'signup' && (
                <div>
                  <label className="label">Họ và tên Phụ huynh</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ví dụ: Nguyễn Thị Mai (Mẹ bé An)"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                  />
                </div>
              )}

              <div>
                <label className="label">Địa chỉ Email</label>
                <input
                  type="email"
                  className="input"
                  placeholder="phuhuynh@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="label">Mật khẩu</label>
                <input
                  type="password"
                  className="input"
                  placeholder="Nhập mật khẩu..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {authError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-danger font-medium">
                  {authError}
                </div>
              )}

              <button type="submit" className="btn-primary w-full" disabled={authSubmitting}>
                {authSubmitting
                  ? 'Đang xử lý...'
                  : authMode === 'signin'
                  ? 'Đăng nhập Cổng Phụ Huynh'
                  : 'Đăng ký & Tiếp tục'}
              </button>
            </form>
          </div>
        ) : !isParentRole ? (
          /* Trường hợp đang đăng nhập bằng tài khoản Giáo viên hoặc Admin */
          <div className="card p-6 md:p-8 space-y-4 border-2 border-pink-200">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-6 h-6 text-pink-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h2 className="font-display font-bold text-lg text-ink">
                  Bạn đang đăng nhập với vai trò {profile.role === 'admin' ? 'Quản trị viên' : 'Giáo viên'} ({profile.fullName})
                </h2>
                <p className="text-sm text-ink-soft">
                  Theo quy tắc phân quyền bảo mật (<code>public.profiles.role</code>), chức năng kích hoạt mã mời và xem Cổng Phụ Huynh chỉ dành riêng cho tài khoản có vai trò <b>Phụ huynh (parent)</b>.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <button className="btn-primary btn-sm" onClick={() => navigate('/parent-links')}>
                Quản lý Mã mời Phụ huynh (Giáo viên)
              </button>
              <button className="btn-outline btn-sm" onClick={handleSignOut}>
                <LogOut className="w-4 h-4" /> Đăng xuất để chuyển sang tài khoản Phụ huynh
              </button>
            </div>
          </div>
        ) : (
          /* Giao diện chính của Phụ huynh đã đăng nhập (role === 'parent') */
          <div className="space-y-6">
            {/* Thanh thông tin tài khoản Phụ huynh */}
            <div className="card p-4 bg-gradient-to-r from-pink-50 via-lavender/30 to-mint/30 border border-pink-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-pink-500 text-white font-display font-bold flex items-center justify-center">
                  {profile.fullName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-display font-bold text-ink">{profile.fullName}</span>
                    <span className="chip bg-mint text-mint-dark text-[11px] font-semibold">
                      <CheckCircle2 className="w-3 h-3" /> Tài khoản Phụ huynh
                    </span>
                  </div>
                  <p className="text-xs text-ink-soft">{profile.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {studentsData.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm text-xs"
                    onClick={() => setShowAddChildForm((v) => !v)}
                  >
                    <PlusCircle className="w-3.5 h-3.5" /> Liên kết thêm con
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost btn-sm text-xs"
                  onClick={() => void loadPortalData()}
                  disabled={portalLoading}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${portalLoading ? 'animate-spin' : ''}`} /> Làm mới
                </button>
              </div>
            </div>

            {portalError && (
              <div className="card p-4 border border-red-200 bg-red-50 text-xs text-danger font-medium">
                {portalError}
              </div>
            )}

            {/* Form nhập Mã mời liên kết học sinh (hiển thị khi chưa có học sinh nào hoặc khi bấm "Liên kết thêm con") */}
            {(studentsData.length === 0 || showAddChildForm) && (
              <div className="card p-6 border-2 border-pink-200 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center shrink-0">
                    <KeyRound className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-display font-bold text-lg text-ink">
                      Liên kết hồ sơ học sinh bằng Mã mời bảo mật
                    </h3>
                    <p className="text-xs text-ink-soft">
                      Nhập mã mời một lần (32 ký tự) do giáo viên chủ nhiệm gửi qua Zalo để xác minh quyền phụ huynh của con.
                    </p>
                  </div>
                </div>

                <form onSubmit={handleClaimToken} className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    className="input font-mono text-sm flex-1"
                    placeholder="Dán mã mời liên kết từ giáo viên vào đây..."
                    value={rawTokenInput}
                    onChange={(e) => setRawTokenInput(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="submit" className="btn-primary shrink-0" disabled={claiming}>
                    <ShieldCheck className="w-4 h-4" />
                    {claiming ? 'Đang xác minh...' : 'Xác minh & Liên kết'}
                  </button>
                </form>
              </div>
            )}

            {/* Chọn học sinh nếu phụ huynh có nhiều con đã xác minh */}
            {studentsData.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-ink-soft mr-1">Học sinh đã liên kết:</span>
                {studentsData.map((item) => {
                  const active = item.student.id === currentStudentData?.student.id;
                  return (
                    <button
                      key={item.student.id}
                      type="button"
                      onClick={() => setSelectedStudentId(item.student.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                        active
                          ? 'bg-pink-500 text-white shadow-soft'
                          : 'bg-white text-ink hover:bg-pink-100 border border-pink-200'
                      }`}
                    >
                      <span>{item.student.fullName}</span>
                      {item.classInfo && (
                        <span className={active ? 'text-pink-100' : 'text-ink-soft'}>
                          ({item.classInfo.name})
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Hiển thị dữ liệu của học sinh đang chọn */}
            {portalLoading && !currentStudentData ? (
              <div className="card p-8 text-center text-sm text-ink-soft">
                Đang tải dữ liệu học tập của học sinh...
              </div>
            ) : currentStudentData ? (
              <div className="space-y-6">
                {/* Thẻ thông tin tổng quan học sinh */}
                <div className="card p-6 border-2 border-pink-200 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5">
                      <StudentAvatar
                        student={currentStudentData.student}
                        size={56}
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-display font-extrabold text-xl text-ink">
                            {currentStudentData.student.fullName}
                          </h2>
                          <span className="font-mono text-xs bg-pink-100 text-pink-700 px-2 py-0.5 rounded-md">
                            {currentStudentData.student.code}
                          </span>
                        </div>
                        <p className="text-xs text-ink-soft mt-0.5">
                          {currentStudentData.classInfo
                            ? `Lớp ${currentStudentData.classInfo.name} · Năm học ${currentStudentData.classInfo.schoolYear}`
                            : 'Đã xác minh liên kết phụ huynh'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="px-3.5 py-2 rounded-2xl bg-pink-50 border border-pink-200 text-center">
                        <div className="text-[11px] text-ink-soft">Tổng điểm thi đua</div>
                        <div className="font-display font-black text-lg text-pink-600">
                          {studentStats.totalPoints > 0 ? `+${studentStats.totalPoints}` : studentStats.totalPoints}
                        </div>
                      </div>
                      <div className="px-3.5 py-2 rounded-2xl bg-mint/40 border border-mint text-center">
                        <div className="text-[11px] text-ink-soft">Buổi có mặt</div>
                        <div className="font-display font-black text-lg text-mint-dark">
                          {studentStats.presentCount}
                        </div>
                      </div>
                      <div className="px-3.5 py-2 rounded-2xl bg-lavender/40 border border-lavender text-center">
                        <div className="text-[11px] text-ink-soft">Nhận xét từ GV</div>
                        <div className="font-display font-black text-lg text-ink">
                          {currentStudentData.sentComments.length}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Thanh chuyển tab */}
                  <div className="flex flex-wrap gap-2 border-t border-pink-100 pt-4">
                    <button
                      type="button"
                      className={activeTab === 'comments' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                      onClick={() => setActiveTab('comments')}
                    >
                      <MessageSquareHeart className="w-4 h-4" /> Nhận xét của Giáo viên ({currentStudentData.sentComments.length})
                    </button>
                    <button
                      type="button"
                      className={activeTab === 'points' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                      onClick={() => setActiveTab('points')}
                    >
                      <Sparkles className="w-4 h-4" /> Điểm thi đua ({currentStudentData.points.length})
                    </button>
                    <button
                      type="button"
                      className={activeTab === 'attendance' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                      onClick={() => setActiveTab('attendance')}
                    >
                      <CalendarCheck className="w-4 h-4" /> Điểm danh ({currentStudentData.attendance.length})
                    </button>
                  </div>
                </div>

                {/* Nội dung chi tiết theo tab */}
                {activeTab === 'comments' && (
                  <div className="card p-5 space-y-3">
                    <h3 className="font-display font-bold text-base text-ink">
                      Nhận xét tuần đã gửi từ Giáo viên
                    </h3>
                    {currentStudentData.sentComments.length === 0 ? (
                      <p className="text-sm text-ink-soft py-4 text-center">
                        Chưa có nhận xét nào được giáo viên phát hành cho học sinh này.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {currentStudentData.sentComments.map((cmt) => (
                          <div
                            key={cmt.id}
                            className="p-4 rounded-2xl bg-pink-50/60 border border-pink-200 space-y-2"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-bold text-pink-700">
                                Ngày {formatDateVN(cmt.date, true)}
                              </span>
                              {cmt.sentAt && (
                                <span className="text-[11px] text-ink-soft">
                                  Đã gửi: {formatDateTimeVN(cmt.sentAt)}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-ink whitespace-pre-line">{cmt.content}</p>
                            {cmt.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {cmt.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="chip bg-white border border-pink-200 text-pink-600 text-[11px]"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'points' && (
                  <div className="card p-5 space-y-3">
                    <h3 className="font-display font-bold text-base text-ink">
                      Lịch sử Điểm thi đua (Khen thưởng & Nhắc nhở)
                    </h3>
                    {currentStudentData.points.length === 0 ? (
                      <p className="text-sm text-ink-soft py-4 text-center">
                        Chưa có ghi nhận điểm thi đua nào.
                      </p>
                    ) : (
                      <div className="space-y-2.5">
                        {currentStudentData.points.map((pt) => (
                          <div
                            key={pt.id}
                            className="p-3.5 rounded-2xl bg-surface border border-pink-100 flex items-center justify-between gap-3"
                          >
                            <div>
                              <div className="font-semibold text-sm text-ink">{pt.criterionName}</div>
                              {pt.note && <div className="text-xs text-ink-soft">{pt.note}</div>}
                              <div className="text-[11px] text-ink-soft mt-0.5">
                                {formatDateTimeVN(pt.createdAt)}
                              </div>
                            </div>
                            <span
                              className={`chip font-bold text-sm ${
                                pt.delta > 0 ? 'bg-mint text-mint-dark' : 'bg-red-100 text-danger'
                              }`}
                            >
                              {pt.delta > 0 ? `+${pt.delta}` : pt.delta} điểm
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'attendance' && (
                  <div className="card p-5 space-y-3">
                    <h3 className="font-display font-bold text-base text-ink">
                      Nhật ký Điểm danh Chuyên cần
                    </h3>
                    {currentStudentData.attendance.length === 0 ? (
                      <p className="text-sm text-ink-soft py-4 text-center">
                        Chưa có bản ghi điểm danh nào.
                      </p>
                    ) : (
                      <div className="space-y-2.5">
                        {currentStudentData.attendance.map((att) => {
                          const meta = ATTENDANCE_LABELS[att.status] ?? ATTENDANCE_LABELS.present;
                          return (
                            <div
                              key={att.id}
                              className="p-3.5 rounded-2xl bg-surface border border-pink-100 flex items-center justify-between gap-3"
                            >
                              <div>
                                <div className="font-semibold text-sm text-ink">
                                  {formatDateVN(att.date, true)} · Buổi {att.session === 'afternoon' ? 'Chiều' : 'Sáng'}
                                </div>
                                {att.note && <div className="text-xs text-ink-soft mt-0.5">Ghi chú: {att.note}</div>}
                              </div>
                              <span className={`chip text-xs font-semibold ${meta.badgeClass}`}>
                                {meta.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="text-center text-xs text-ink-soft pb-2">
        Pink Classroom – Lớp học hạnh phúc · Mỗi ngày một niềm vui
      </div>
    </div>
  );
}
