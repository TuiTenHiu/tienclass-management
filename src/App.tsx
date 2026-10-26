import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppContext';
import { ToastProvider } from './components/ToastNotification';
import { AppLayout } from './components/AppLayout';
import { EmptyState, LoadingState } from './components/States';
import { PinGate } from './components/PinGate';
import Dashboard from './pages/Dashboard';
import ClassesPage from './pages/Classes';
import StudentsPage from './pages/Students';
import AttendancePage from './pages/Attendance';
import PointsPage from './pages/Points';
import CommentsPage from './pages/Comments';
import GamesPage from './pages/Games';
import SettingsPage from './pages/Settings';

const ReportsPage = lazy(() => import('./pages/Reports'));
const DogGamePage = lazy(() => import('./pages/DogGame'));

/** Các trang cần có lớp đang chọn */
export function RequireClass({ children }: { children: ReactNode }) {
  const { ready, currentClass } = useApp();
  const navigate = useNavigate();
  if (!ready) return <LoadingState />;
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

export default function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <PinGate>
          <BrowserRouter>
            <Suspense fallback={<LoadingState />}>
              <Routes>
                <Route
                  path="/games/dog"
                  element={
                    <RequireClass>
                      <DogGamePage />
                    </RequireClass>
                  }
                />
                <Route element={<AppLayout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="classes" element={<ClassesPage />} />
                  <Route path="students" element={<RequireClass><StudentsPage /></RequireClass>} />
                  <Route path="attendance" element={<RequireClass><AttendancePage /></RequireClass>} />
                  <Route path="points" element={<RequireClass><PointsPage /></RequireClass>} />
                  <Route path="comments" element={<RequireClass><CommentsPage /></RequireClass>} />
                  <Route path="games" element={<RequireClass><GamesPage /></RequireClass>} />
                  <Route path="reports" element={<RequireClass><ReportsPage /></RequireClass>} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </Suspense>
          </BrowserRouter>
        </PinGate>
      </AppProvider>
    </ToastProvider>
  );
}
