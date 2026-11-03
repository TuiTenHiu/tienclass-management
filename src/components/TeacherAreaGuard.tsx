import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, Lock, ArrowRight, RefreshCw, LogOut, LogIn } from 'lucide-react';
import { useAuth } from '../state/AuthContext';
import { LoadingState } from './States';
import { LogoMark, Illustration } from './illustrations';

/**
 * TeacherAreaGuard (Bảo vệ vùng quản lý giáo viên):
 * Chặn toàn bộ việc mount AppProvider và các component quản lý học sinh
 * trước khi người dùng có phiên Supabase hợp lệ với vai trò 'teacher' hoặc 'admin'.
 *
 * Nếu chưa đăng nhập, đang tải, lỗi hồ sơ hoặc vai trò là phụ huynh,
 * guard này chỉ hiển thị màn hình thông báo / chờ theo phong cách pastel hồng
 * và TUYỆT ĐỐI KHÔNG mount AppProvider hay thực thi truy vấn IndexedDB.
 */
export function TeacherAreaGuard({ children }: { children: ReactNode }) {
  const { configured, loading, user, profile, isCloudTeacher, authError, refreshAuth, signIn, signOut } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const handleTeacherLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!email.trim() || !password) {
      setLoginError('Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await signIn(email, password);
      if (!res.ok) {
        setLoginError(res.message || 'Đăng nhập không thành công.');
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Lỗi khi kết nối xác thực.');
    } finally {
      setSubmitting(false);
    }
  };

  // 1. Đang kiểm tra phiên hoặc tải hồ sơ từ Supabase
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-pink-50" role="status">
        <LoadingState label="Đang kiểm tra quyền truy cập giáo viên..." />
      </div>
    );
  }

  // 2. Supabase chưa được cấu hình
  if (!configured) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-pink-50">
        <div className="card card-pad w-full max-w-md text-center animate-pop shadow-card border border-pink-100">
          <div className="flex justify-center">
            <Illustration name="sleepy-cat" size={130} />
          </div>
          <h2 className="font-display font-black text-xl text-ink mt-3">Chưa cấu hình Supabase Cloud</h2>
          <p className="text-ink-soft text-sm mt-2 leading-relaxed">
            Hệ thống yêu cầu kết nối Supabase Cloud hợp lệ để xác thực giáo viên và bảo vệ dữ liệu học sinh trước khi truy cập khu vực quản lý.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <button className="btn-outline w-full justify-center" onClick={() => navigate('/parent/portal')}>
              Đến Cổng Phụ Huynh <ArrowRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Chưa đăng nhập
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-pink-50">
        <div className="card card-pad w-full max-w-md text-center animate-pop shadow-card border border-pink-100">
          <div className="flex justify-center">
            <LogoMark size={64} />
          </div>
          <h2 className="font-display font-black text-2xl text-ink mt-3">Pink Classroom</h2>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-pink-100 text-pink-700 text-xs font-bold mt-2 mx-auto">
            <Lock className="w-3.5 h-3.5" />
            Khu vực Giáo viên được bảo vệ
          </div>
          <p className="text-ink-soft text-sm mt-3 leading-relaxed">
            Toàn bộ dữ liệu quản lý học sinh được bảo vệ. Vui lòng xác thực tài khoản giáo viên đã được cấp phép để mở khu vực làm việc.
          </p>

          {(loginError || authError) && (
            <div className="p-3 mt-3 rounded-xl bg-danger-soft/40 border border-danger/20 text-xs text-danger text-left">
              {loginError || authError}
            </div>
          )}

          <form onSubmit={handleTeacherLogin} className="mt-4 text-left space-y-3">
            <div>
              <label className="block text-xs font-bold text-ink-soft mb-1">Email giáo viên</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teacher@pink.edu.vn"
                className="input w-full text-sm"
                required
                disabled={submitting}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-ink-soft mb-1">Mật khẩu</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="input w-full text-sm"
                required
                disabled={submitting}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary w-full justify-center text-sm font-bold py-2.5 mt-2"
            >
              {submitting ? (
                <span>Đang xác thực...</span>
              ) : (
                <>
                  <LogIn className="w-4 h-4 mr-1.5" /> Đăng nhập Giáo viên
                </>
              )}
            </button>
          </form>

          <div className="mt-4 pt-4 border-t border-pink-100/80 flex flex-col gap-2">
            <button className="btn-outline w-full justify-center text-xs py-2" onClick={() => void refreshAuth()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Kiểm tra lại phiên đăng nhập
            </button>
            <button className="btn-ghost w-full justify-center text-xs py-1.5" onClick={() => navigate('/parent/portal')}>
              Chuyển đến Cổng Phụ Huynh
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 4. Đã đăng nhập nhưng không tìm thấy hoặc lỗi tải hồ sơ từ public.profiles
  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-pink-50">
        <div className="card card-pad w-full max-w-md text-center animate-pop shadow-card border border-pink-100">
          <div className="flex justify-center">
            <Illustration name="sleepy-cat" size={130} />
          </div>
          <h2 className="font-display font-black text-xl text-ink mt-3">Không thể xác định hồ sơ người dùng</h2>
          <p className="text-ink-soft text-sm mt-2 leading-relaxed">
            Phiên đăng nhập đã được ghi nhận ({user.email}) nhưng không tải được hồ sơ hợp lệ trong <code className="text-pink-600 bg-pink-50 px-1 py-0.5 rounded font-mono text-xs">public.profiles</code>. Vì lý do an toàn dữ liệu, khu vực quản lý tạm thời không mở.
          </p>
          {authError && (
            <div className="p-3 mt-3 rounded-xl bg-danger-soft/40 border border-danger/20 text-xs text-danger text-left">
              {authError}
            </div>
          )}
          <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
            <button className="btn-outline justify-center" onClick={() => void refreshAuth()}>
              <RefreshCw className="w-4 h-4 mr-1" /> Thử lại
            </button>
            <button className="btn-danger justify-center" onClick={() => void signOut()}>
              <LogOut className="w-4 h-4 mr-1" /> Đăng xuất
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 5. Vai trò không phải teacher hoặc admin (ví dụ: role === 'parent')
  if (!isCloudTeacher) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-pink-50">
        <div className="card card-pad w-full max-w-md text-center animate-pop shadow-card border border-pink-100">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-cream text-cream-dark flex items-center justify-center">
              <ShieldAlert className="w-8 h-8 text-amber-500" />
            </div>
          </div>
          <h2 className="font-display font-black text-xl text-ink mt-3">Quyền truy cập bị từ chối</h2>
          <p className="text-ink-soft text-sm mt-2 leading-relaxed">
            Tài khoản của bạn ({user.email}) hiện có vai trò <span className="font-bold text-ink">Phụ huynh</span> ({profile.role}). Khu vực này chỉ dành riêng cho Giáo viên và Quản trị viên để quản lý lớp học.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <button className="btn-primary w-full justify-center" onClick={() => navigate('/parent/portal')}>
              Chuyển đến Cổng Phụ Huynh <ArrowRight className="w-4 h-4 ml-1" />
            </button>
            <button className="btn-outline w-full justify-center" onClick={() => void signOut()}>
              <LogOut className="w-4 h-4 mr-1" /> Đăng xuất để đổi tài khoản
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 6. Phiên đăng nhập hợp lệ và vai trò đáng tin cậy: khởi tạo vùng quản lý
  return <>{children}</>;
}
