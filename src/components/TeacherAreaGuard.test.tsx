import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  },
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

import { TeacherAreaGuard } from './TeacherAreaGuard';
import type { AuthState } from '../state/AuthContext';
import * as AuthContextModule from '../state/AuthContext';

describe('Giai đoạn 1: TeacherAreaGuard & Data Isolation Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const createMockAuthState = (overrides: Partial<AuthState> = {}): AuthState => ({
    configured: true,
    loading: false,
    syncing: false,
    user: { id: 'teacher-1', email: 'teacher@pink.edu.vn' } as any,
    profile: {
      id: 'teacher-1',
      email: 'teacher@pink.edu.vn',
      fullName: 'Cô Tiên',
      role: 'teacher',
    },
    isCloudTeacher: true,
    lastSyncedAt: 123456789,
    authError: null,
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    syncNow: vi.fn().mockResolvedValue({ synced: true, classesCount: 1, criteriaCount: 1, studentsCount: 1 }),
    ...overrides,
  });

  const renderGuardWithState = (authState: AuthState, childSpy?: () => void) => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(authState);

    const ChildComponent = () => {
      childSpy?.();
      return <div data-testid="protected-management-data">Protected Management Content</div>;
    };

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <TeacherAreaGuard>
          <ChildComponent />
        </TeacherAreaGuard>
      </MemoryRouter>,
    );

    return html;
  };

  it('1. Đang tải phiên: Chỉ hiển thị trạng thái chờ; KHÔNG mount dữ liệu quản lý', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      loading: true,
      user: null,
      profile: null,
      isCloudTeacher: false,
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Đang kiểm tra quyền truy cập giáo viên...');
  });

  it('2. Supabase chưa cấu hình: Chặn truy cập; KHÔNG đọc dữ liệu quản lý', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: false,
      loading: false,
      user: null,
      profile: null,
      isCloudTeacher: false,
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Chưa cấu hình Supabase Cloud');
  });

  it('3. Chưa đăng nhập: AppProvider không được mount; không truy vấn dữ liệu quản lý', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: null,
      profile: null,
      isCloudTeacher: false,
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Khu vực Giáo viên được bảo vệ');
    expect(html).toContain('Toàn bộ dữ liệu quản lý học sinh được bảo vệ');
  });

  it('4. Profile không tồn tại: Chặn truy cập; không fallback sang offline', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: { id: 'orphan-user', email: 'orphan@pink.edu.vn' } as any,
      profile: null,
      isCloudTeacher: false,
      authError: 'Không tìm thấy hồ sơ người dùng trong hệ thống (public.profiles).',
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Không thể xác định hồ sơ người dùng');
    expect(html).toContain('public.profiles');
  });

  it('5. Lỗi khi tải profile: Chặn truy cập; không fallback sang offline', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: { id: 'error-user', email: 'error@pink.edu.vn' } as any,
      profile: null,
      isCloudTeacher: false,
      authError: 'Lỗi khi tải hồ sơ người dùng từ máy chủ Supabase.',
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Không thể xác định hồ sơ người dùng');
    expect(html).toContain('Lỗi khi tải hồ sơ người dùng từ máy chủ Supabase.');
  });

  it('6. Role "parent": Không cho phép khởi tạo vùng quản lý', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: { id: 'parent-1', email: 'parent@family.com' } as any,
      profile: {
        id: 'parent-1',
        email: 'parent@family.com',
        fullName: 'Phụ huynh bé Na',
        role: 'parent',
      },
      isCloudTeacher: false,
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Quyền truy cập bị từ chối');
    expect(html).toContain('Phụ huynh');
  });

  it('7. Phiên hợp lệ, role "teacher": Cho phép khởi tạo vùng quản lý', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: { id: 'teacher-1', email: 'teacher@pink.edu.vn' } as any,
      profile: {
        id: 'teacher-1',
        email: 'teacher@pink.edu.vn',
        fullName: 'Cô Tiên',
        role: 'teacher',
      },
      isCloudTeacher: true,
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(html).toContain('Protected Management Content');
  });

  it('8. Phiên hợp lệ, role "admin": Cho phép khởi tạo vùng quản lý', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: { id: 'admin-1', email: 'admin@pink.edu.vn' } as any,
      profile: {
        id: 'admin-1',
        email: 'admin@pink.edu.vn',
        fullName: 'Quản trị viên',
        role: 'admin',
      },
      isCloudTeacher: true,
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(html).toContain('Protected Management Content');
  });

  it('9. Lỗi mạng hoặc phiên hết hạn: Không mở vùng quản lý khi chưa xác minh lại', () => {
    const childSpy = vi.fn();
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: null, // Phiên hết hạn -> getSession() trả về null user
      profile: null,
      isCloudTeacher: false,
      authError: 'Session expired or network failed',
    });

    const html = renderGuardWithState(state, childSpy);

    expect(childSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Protected Management Content');
    expect(html).toContain('Khu vực Giáo viên được bảo vệ');
    expect(html).toContain('Session expired or network failed');
  });

  it('10. Route /parent/portal: Không bị guard giáo viên chặn nhầm và không kích hoạt vùng quản lý', () => {
    const teacherChildSpy = vi.fn();
    const parentPortalSpy = vi.fn();

    // Giả sử trạng thái hiện tại là chưa đăng nhập (hoặc đăng nhập với vai trò parent)
    const state = createMockAuthState({
      configured: true,
      loading: false,
      user: null,
      profile: null,
      isCloudTeacher: false,
    });

    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(state);

    const ParentPortalMock = () => {
      parentPortalSpy();
      return <div data-testid="parent-portal-content">Trang Cổng Phụ Huynh</div>;
    };

    const TeacherAreaMock = () => {
      teacherChildSpy();
      return <div data-testid="teacher-management">Dữ liệu giáo viên</div>;
    };

    // Mô phỏng cây router chuẩn của Pink Classroom sau khi sửa
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/parent/portal']}>
        <Routes>
          <Route path="/parent/portal" element={<ParentPortalMock />} />
          <Route
            element={
              <TeacherAreaGuard>
                <TeacherAreaMock />
              </TeacherAreaGuard>
            }
          >
            <Route path="/" element={<div>Dashboard</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // Cổng phụ huynh phải render thành công
    expect(parentPortalSpy).toHaveBeenCalledTimes(1);
    expect(html).toContain('Trang Cổng Phụ Huynh');

    // Vùng giáo viên TUYỆT ĐỐI không được gọi
    expect(teacherChildSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('Dữ liệu giáo viên');
    expect(html).not.toContain('Khu vực Giáo viên được bảo vệ');
  });
});
