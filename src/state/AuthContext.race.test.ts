import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { User } from '@supabase/supabase-js';

vi.mock('../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

import {
  processAuthTransition,
  type AuthTransitionDependencies,
} from './AuthContext';
import type { UserProfile } from '../types';

describe('Giai đoạn 1.1: AuthContext Race Condition & Cache Invalidation Tests', () => {
  let seqCounter = 0;
  let lastKnownUserId: string | null = null;
  let currentUserState: User | null = null;
  let currentProfileState: UserProfile | null = null;
  let currentAuthErrorState: string | null = null;

  let mockClearSyncedCloudCache: ReturnType<typeof vi.fn>;
  let mockSyncNow: ReturnType<typeof vi.fn>;
  let mockGetCurrentUserProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    seqCounter = 0;
    lastKnownUserId = null;
    currentUserState = null;
    currentProfileState = null;
    currentAuthErrorState = null;

    mockClearSyncedCloudCache = vi.fn().mockResolvedValue(undefined);
    mockSyncNow = vi.fn().mockResolvedValue({ synced: true, classesCount: 1, criteriaCount: 1, studentsCount: 1 });
    mockGetCurrentUserProfile = vi.fn().mockResolvedValue({
      id: 'teacher-1',
      email: 'teacher1@pink.edu.vn',
      fullName: 'Cô Tiên',
      role: 'teacher',
    });
  });

  const createDeps = (): AuthTransitionDependencies => ({
    getCurrentSeq: () => seqCounter,
    getLastKnownUserId: () => lastKnownUserId,
    setLastKnownUserId: (id) => {
      lastKnownUserId = id;
    },
    setUser: (u) => {
      currentUserState = u;
    },
    setProfile: (p) => {
      currentProfileState = p;
    },
    setAuthError: (err) => {
      currentAuthErrorState = err;
    },
    getCurrentUserProfile: mockGetCurrentUserProfile,
    syncNow: mockSyncNow,
    clearSyncedCloudCacheFromLocal: mockClearSyncedCloudCache,
  });

  it('1. Khởi động không có session: KHÔNG gọi hàm dọn cache chỉ vì user === null', async () => {
    const deps = createDeps();
    seqCounter = 1;

    // Lúc vừa mở web, sessionUser = null và lastKnownUserId = null
    const res = await processAuthTransition(null, 1, deps);

    expect(res.applied).toBe(true);
    expect(res.profile).toBeNull();
    expect(currentUserState).toBeNull();
    expect(currentProfileState).toBeNull();

    // Khẳng định dọn cache IndexedDB KHÔNG được gọi khi khởi động ban đầu
    expect(mockClearSyncedCloudCache).not.toHaveBeenCalled();
  });

  it('2. Yêu cầu tải profile A bị chậm, sau đó đăng xuất: kết quả A KHÔNG được cập nhật state', async () => {
    const deps = createDeps();

    // Bắt đầu request 1 cho User A
    seqCounter = 1;
    const userA = { id: 'teacher-a', email: 'a@pink.edu.vn' } as User;

    let resolveProfileA: (val: UserProfile) => void = () => {};
    mockGetCurrentUserProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProfileA = resolve;
        }),
    );

    // Kích hoạt request 1 (chưa await để nó pending qua mạng)
    const promiseA = processAuthTransition(userA, 1, deps);

    // Trong lúc request 1 đang pending, user bấm đăng xuất -> seqCounter tăng lên 2
    seqCounter = 2;
    lastKnownUserId = null;
    currentUserState = null;
    currentProfileState = null;

    // Lúc này request 1 mới nhận được profile từ Supabase
    resolveProfileA({
      id: 'teacher-a',
      email: 'a@pink.edu.vn',
      fullName: 'Giáo viên A',
      role: 'teacher',
    });

    const resultA = await promiseA;

    // Request 1 phải bị vô hiệu hóa, không được cập nhật state
    expect(resultA.applied).toBe(false);
    expect(currentUserState).toBeNull();
    expect(currentProfileState).toBeNull();
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('3. Tải profile A bị chậm, sau đó đăng nhập B: kết quả A KHÔNG được ghi đè state B', async () => {
    const deps = createDeps();

    // Bắt đầu nạp User A với seq = 1
    seqCounter = 1;
    const userA = { id: 'teacher-a', email: 'a@pink.edu.vn' } as User;

    let resolveProfileA: (val: UserProfile) => void = () => {};
    mockGetCurrentUserProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfileA = resolve;
        }),
    );

    const promiseA = processAuthTransition(userA, 1, deps);

    // Người dùng chuyển sang đăng nhập User B ngay sau đó -> seq = 2
    seqCounter = 2;
    const userB = { id: 'teacher-b', email: 'b@pink.edu.vn' } as User;
    const profileB: UserProfile = {
      id: 'teacher-b',
      email: 'b@pink.edu.vn',
      fullName: 'Giáo viên B',
      role: 'teacher',
    };
    mockGetCurrentUserProfile.mockResolvedValueOnce(profileB);

    const resultB = await processAuthTransition(userB, 2, deps);

    expect(resultB.applied).toBe(true);
    expect(currentUserState?.id).toBe('teacher-b');
    expect(currentProfileState?.id).toBe('teacher-b');

    // Sau đó request A mới hoàn thành
    resolveProfileA({
      id: 'teacher-a',
      email: 'a@pink.edu.vn',
      fullName: 'Giáo viên A',
      role: 'teacher',
    });

    const resultA = await promiseA;

    // Request A bị hủy và không ghi đè state của User B
    expect(resultA.applied).toBe(false);
    expect(currentUserState?.id).toBe('teacher-b');
    expect(currentProfileState?.id).toBe('teacher-b');
  });

  it('4. Profile tải lỗi: đóng quyền ngay lập tức, KHÔNG giữ quyền truy cập cũ', async () => {
    const deps = createDeps();

    // Giả sử trước đó đang có quyền teacher
    currentProfileState = {
      id: 'teacher-old',
      email: 'old@pink.edu.vn',
      fullName: 'Giáo viên cũ',
      role: 'teacher',
    };

    seqCounter = 1;
    const user = { id: 'teacher-new', email: 'new@pink.edu.vn' } as User;
    mockGetCurrentUserProfile.mockRejectedValueOnce(new Error('Network connection timeout'));

    const res = await processAuthTransition(user, 1, deps);

    expect(res.applied).toBe(true);
    expect(res.profile).toBeNull();
    // Profile phải bị reset về null ngay, không giữ quyền cũ
    expect(currentProfileState).toBeNull();
    expect(currentAuthErrorState).toBe('Network connection timeout');
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('5. Yêu cầu đã lỗi thời: KHÔNG kích hoạt syncNow()', async () => {
    const deps = createDeps();

    seqCounter = 1;
    const userA = { id: 'teacher-a', email: 'a@pink.edu.vn' } as User;

    let resolveProfile: (val: UserProfile) => void = () => {};
    mockGetCurrentUserProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProfile = resolve;
        }),
    );

    const promise = processAuthTransition(userA, 1, deps);

    // Trước khi profile A trả về, sequence đã tăng do có thao tác mới
    seqCounter = 2;

    resolveProfile({
      id: 'teacher-a',
      email: 'a@pink.edu.vn',
      fullName: 'Giáo viên A',
      role: 'teacher',
    });

    await promise;

    // syncNow tuyệt đối không được gọi vì request seq = 1 đã lỗi thời
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('6. Sự kiện auth liên tiếp: state cuối cùng phản ánh đúng phiên mới nhất', async () => {
    const deps = createDeps();

    const user1 = { id: 'u1', email: 'u1@pink.edu.vn' } as User;
    const user2 = { id: 'u2', email: 'u2@pink.edu.vn' } as User;
    const user3 = { id: 'u3', email: 'u3@pink.edu.vn' } as User;

    // Giả lập network delay: u1 mất 40ms, u2 mất 25ms, u3 mất 10ms
    mockGetCurrentUserProfile.mockImplementation(async () => {
      const id = currentUserState?.id;
      if (id === 'u1') {
        await new Promise((r) => setTimeout(r, 40));
        return { id: 'u1', email: 'u1@pink.edu.vn', fullName: 'User 1', role: 'teacher' };
      }
      if (id === 'u2') {
        await new Promise((r) => setTimeout(r, 25));
        return { id: 'u2', email: 'u2@pink.edu.vn', fullName: 'User 2', role: 'teacher' };
      }
      if (id === 'u3') {
        await new Promise((r) => setTimeout(r, 10));
        return { id: 'u3', email: 'u3@pink.edu.vn', fullName: 'User 3', role: 'teacher' };
      }
      return null;
    });

    seqCounter = 1;
    const p1 = processAuthTransition(user1, 1, deps);

    // Sự kiện 2 phát sinh sau 5ms
    await new Promise((r) => setTimeout(r, 5));
    seqCounter = 2;
    const p2 = processAuthTransition(user2, 2, deps);

    // Sự kiện 3 phát sinh sau 5ms tiếp theo
    await new Promise((r) => setTimeout(r, 5));
    seqCounter = 3;
    const p3 = processAuthTransition(user3, 3, deps);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1.applied).toBe(false);
    expect(r2.applied).toBe(false);
    expect(r3.applied).toBe(true);

    expect(currentUserState?.id).toBe('u3');
    expect(currentProfileState?.id).toBe('u3');
    // Chỉ có user 3 được kích hoạt syncNow
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });
});
