import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { AppProvider, useApp } from './state/AppContext';
import { AuthProvider, useAuth } from './state/AuthContext';
import { ToastProvider } from './components/ToastNotification';
import { AppLayout } from './components/AppLayout';
import { EmptyState, PageSkeleton } from './components/States';
import { PinGate } from './components/PinGate';
import { TeacherAreaGuard } from './components/TeacherAreaGuard';

const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ClassesPage = lazy(() => import('./pages/Classes'));
const StudentsPage = lazy(() => import('./pages/Students'));
const AttendancePage = lazy(() => import('./pages/Attendance'));
const PointsPage = lazy(() => import('./pages/Points'));
const CommentsPage = lazy(() => import('./pages/Comments'));
const ParentLinksPage = lazy(() => import('./pages/ParentLinks'));
const GamesPage = lazy(() => import('./pages/Games'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const MigrationPage = lazy(() => import('./pages/Migration'));
const DogGamePage = lazy(() => import('./pages/DogGame'));
const UfoGamePage = lazy(() => import('./pages/UfoGame'));
const ParentPortalPage = lazy(() => import('./pages/ParentPortal'));
const LandingPage = lazy(() => import('./pages/Landing'));

/** Các trang cần có lớp đang chọn */
export function RequireClass({ children }: { children: ReactNode }) {
  const { ready, currentClass } = useApp();
  const navigate = useNavigate();
  if (!ready) return <PageSkeleton label="Đang nạp dữ liệu lớp học..." />;
  if (!currentClass)
    return (
      <div className="card mt-4">
        <EmptyState
          illustration="rainbow"
          title="Chưa có lớp học nào"
          description="Hãy tạo lớp học đầu tiên để bắt đầu quản lý học sinh, điểm danh và thi đua nhé!"
          action={
            <button className="btn-primary" onClick={() => navigate('/classes?new=1')}>
              Tạo lớp học đầu tiên
            </button>
          }
        />
      </div>
    );
  return <>{children}</>;
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="card mt-4">
      <EmptyState
        illustration="sleepy-cat"
        title="Không tìm thấy trang"
        description="Trang này không tồn tại hoặc đã được di chuyển."
        action={
          <button className="btn-primary" onClick={() => navigate('/')}>
            Về trang tổng quan
          </button>
        }
      />
    </div>
  );
}

/**
 * Vùng quản lý lớp học (Giáo viên / Quản trị viên):
 * Chỉ khởi tạo AppProvider, PinGate và nạp dữ liệu IndexedDB khi phiên Supabase
 * đã được xác minh đầy đủ với vai trò 'teacher' hoặc 'admin'.
 *
 * Riêng đường dẫn gốc "/": khách chưa đăng nhập sẽ thấy trang giới thiệu công khai
 * (không mount AppProvider, không đọc dữ liệu); phụ huynh đã đăng nhập được chuyển
 * sang Cổng phụ huynh; giáo viên đã đăng nhập vào thẳng dashboard như trước.
 */
function TeacherManagementZone() {
  const { user, loading, profile } = useAuth();
  const { pathname } = useLocation();

  if (pathname === '/' && !loading) {
    if (!user) return <LandingPage />;
    if (profile?.role === 'parent') return <Navigate to="/parent/portal" replace />;
  }

  return (
    <TeacherAreaGuard>
      <AppProvider key={user?.id}>
        <PinGate>
          <Outlet />
        </PinGate>
      </AppProvider>
    </TeacherAreaGuard>
  );
}

/**
 * Trang đăng nhập giáo viên: tái sử dụng nguyên vẹn luồng đăng nhập của TeacherAreaGuard.
 * Khi phiên hợp lệ, chuyển về dashboard ("/"); phụ huynh được chuyển sang Cổng phụ huynh.
 */
function LoginRoute() {
  const { user, loading, profile } = useAuth();
  const navigate = useNavigate();

  if (!loading && user && profile?.role === 'parent') return <Navigate to="/parent/portal" replace />;

  return (
    <>
      {!loading && !user && (
        <button
          type="button"
          className="btn-ghost btn-sm fixed top-3 left-3 z-50 bg-white/80 backdrop-blur"
          onClick={() => navigate('/')}
        >
          <ArrowLeft className="w-4 h-4" /> Trang chủ
        </button>
      )}
      <TeacherAreaGuard>
        <Navigate to="/" replace />
      </TeacherAreaGuard>
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<PageSkeleton label="Đang tải trang..." />}>
            <Routes>
              {/* Cổng phụ huynh: hoạt động độc lập, không kích hoạt AppProvider hay IndexedDB giáo viên */}
              <Route path="/parent/portal" element={<ParentPortalPage />} />

              {/* Đăng nhập giáo viên (trang công khai, dùng luồng xác thực hiện có) */}
              <Route path="/login" element={<LoginRoute />} />

              {/* Vùng quản lý giáo viên: được bảo vệ nghiêm ngặt bởi TeacherAreaGuard */}
              <Route element={<TeacherManagementZone />}>
                <Route
                  path="/games/dog"
                  element={
                    <RequireClass>
                      <DogGamePage />
                    </RequireClass>
                  }
                />
                <Route
                  path="/games/ufo"
                  element={
                    <RequireClass>
                      <UfoGamePage />
                    </RequireClass>
                  }
                />
                <Route element={<AppLayout />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="classes" element={<ClassesPage />} />
                  <Route path="students" element={<RequireClass><StudentsPage /></RequireClass>} />
                  <Route path="attendance" element={<RequireClass><AttendancePage /></RequireClass>} />
                  <Route path="points" element={<RequireClass><PointsPage /></RequireClass>} />
                  <Route path="comments" element={<RequireClass><CommentsPage /></RequireClass>} />
                  <Route path="parent-links" element={<RequireClass><ParentLinksPage /></RequireClass>} />
                  <Route path="games" element={<RequireClass><GamesPage /></RequireClass>} />
                  <Route path="reports" element={<RequireClass><ReportsPage /></RequireClass>} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="migration" element={<MigrationPage />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
