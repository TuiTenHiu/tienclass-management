import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';

// Mock Supabase client
const mockClassesTable: Array<{
  id: string;
  name: string;
  school_year: string;
  teacher_id: string;
  subject?: string | null;
  note?: string | null;
  color?: string;
  created_at: string;
  updated_at: string;
}> = [];

const TEACHER_ID = '11111111-1111-4111-8111-111111111111';

let currentSessionUserId = TEACHER_ID;

vi.mock('../lib/supabaseClient', () => {
  return {
    isSupabaseConfigured: true,
    checkSupabaseConnection: vi.fn(),
    supabase: {
      auth: {
        getSession: vi.fn(async () => {
          if (!currentSessionUserId) return { data: { session: null }, error: null };
          return {
            data: {
              session: {
                user: {
                  id: currentSessionUserId,
                  email: `${currentSessionUserId}@test.com`,
                },
              },
            },
            error: null,
          };
        }),
        signOut: vi.fn(async () => {
          currentSessionUserId = '';
          return { error: null };
        }),
      },
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((_col: string, val: string) => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: val,
                    email: `${val}@test.com`,
                    full_name: `Giáo viên ${val}`,
                    role: 'teacher',
                  },
                  error: null,
                })),
              })),
            })),
          };
        }
        if (table === 'classes') {
          return {
            insert: vi.fn(async (payload: any) => {
              mockClassesTable.push(payload);
              return { error: null };
            }),
            select: vi.fn(() => ({
              order: vi.fn(() => ({
                eq: vi.fn((col: string, val: string) => {
                  const filtered = mockClassesTable.filter((c) => (c as any)[col] === val);
                  return Promise.resolve({ data: filtered, error: null });
                }),
                then: (resolve: any) => Promise.resolve({ data: mockClassesTable, error: null }).then(resolve),
              })),
            })),
          };
        }
        // Default chainable mock for all other tables
        const chain: any = {
          select: vi.fn(() => chain),
          in: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          order: vi.fn(() => chain),
          insert: vi.fn(async () => ({ error: null })),
          then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return chain;
      }),
    },
  };
});

import { getDatabaseForUser } from '../data/db';
import {
  setActiveDatabase,
  createClass,
  syncClassesAndStudentsFromSupabase,
  clearSyncedCloudCacheFromLocal,
  invalidateAuthenticatedContextCache,
} from '../data/repo';
import { processAuthTransition, type AuthTransitionDependencies } from '../state/AuthContext';

describe('REPRODUCE & VERIFY: Lớp học sau khi Đăng nhập -> Tạo lớp -> Đăng xuất -> Đăng nhập lại', () => {
  beforeEach(async () => {
    mockClassesTable.length = 0;
    invalidateAuthenticatedContextCache();
    setActiveDatabase(null, null);
    const db = getDatabaseForUser(TEACHER_ID);
    await db.classes.clear();
    await db.criteria.clear();
    await db.students.clear();
    await db.kv.clear();
  });

  it('Kiểm tra kịch bản: Login -> Create Class -> Logout -> Login lại -> Xác nhận class vẫn hiển thị', async () => {
    const teacherUser: User = {
      id: TEACHER_ID,
      email: 'teacher@test.com',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    };

    let currentUser: any = null;
    let currentProfile: any = null;
    let lastKnownUserId: string | null = null;
    let seq = 0;

    const teacherDb = getDatabaseForUser(TEACHER_ID);

    const deps: AuthTransitionDependencies = {
      getCurrentSeq: () => seq,
      getLastKnownUserId: () => lastKnownUserId,
      setLastKnownUserId: (id) => {
        lastKnownUserId = id;
      },
      setUser: (u) => {
        currentUser = u;
      },
      setProfile: (p) => {
        currentProfile = p;
      },
      setAuthError: () => {},
      getCurrentUserProfile: async () => ({
        id: TEACHER_ID,
        email: 'teacher@test.com',
        fullName: 'Cô Giáo Viên',
        role: 'teacher',
      }),
      syncNow: async () => {
        return syncClassesAndStudentsFromSupabase();
      },
      clearSyncedCloudCacheFromLocal: (targetDb) => clearSyncedCloudCacheFromLocal(targetDb),
    };

    // 1. ĐĂNG NHẬP LẦN ĐẦU
    seq++;
    const res1 = await processAuthTransition(teacherUser, seq, deps);
    expect(res1.applied).toBe(true);
    expect(currentUser?.id).toBe(TEACHER_ID);
    expect(currentProfile?.role).toBe('teacher');

    // Giả lập AppProvider mount và set active database
    setActiveDatabase(teacherDb, TEACHER_ID);

    // 2. TẠO LỚP HỌC TRÊN SUPABASE & DEXIE
    const created = await createClass({
      name: 'Lớp 5A Test',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Viên',
    }, teacherDb);

    expect(created.id).toBeDefined();
    expect(mockClassesTable.length).toBe(1);
    expect(mockClassesTable[0].name).toBe('Lớp 5A Test');
    expect(mockClassesTable[0].teacher_id).toBe(TEACHER_ID);

    // Kiểm tra Dexie có lớp
    const classesBeforeLogout = await teacherDb.classes.toArray();
    expect(classesBeforeLogout.length).toBe(1);
    expect(classesBeforeLogout[0].name).toBe('Lớp 5A Test');

    // 3. ĐĂNG XUẤT
    seq++;
    const resLogout = await processAuthTransition(null, seq, deps);
    expect(resLogout.applied).toBe(true);
    expect(currentUser).toBeNull();

    // 4. ĐĂNG NHẬP LẠI VỚI CÙNG TÀI KHOẢN GIÁO VIÊN
    seq++;
    const resReLogin = await processAuthTransition(teacherUser, seq, deps);
    expect(resReLogin.applied).toBe(true);
    expect(currentUser?.id).toBe(TEACHER_ID);

    // Lấy instance mới từ database factory sau khi login lại
    const reloadedTeacherDb = getDatabaseForUser(TEACHER_ID);
    setActiveDatabase(reloadedTeacherDb, TEACHER_ID);

    // Thực hiện đồng bộ (nếu processAuthTransition chạy async syncNow, ta đợi sync hoàn thành)
    const syncRes = await syncClassesAndStudentsFromSupabase(undefined, reloadedTeacherDb);
    expect(syncRes.synced).toBe(true);
    expect(syncRes.classesCount).toBe(1);

    // 5. XÁC NHẬN LỚP HỌC VẪN CÒN TRONG DEXIE VÀ HIỂN THỊ ĐÚNG DỮ LIỆU TỪ SUPABASE
    const classesAfterReLogin = await reloadedTeacherDb.classes.toArray();
    expect(classesAfterReLogin.length).toBe(1);
    expect(classesAfterReLogin[0].id).toBe(mockClassesTable[0].id);
    expect(classesAfterReLogin[0].name).toBe('Lớp 5A Test');
    expect(classesAfterReLogin[0].schoolYear).toBe('2026-2027');

    // 6. KIỂM TRA TẢI LẠI TRANG (RELOAD / F5): session vẫn giữ nguyên
    seq++;
    const resReload = await processAuthTransition(teacherUser, seq, deps);
    expect(resReload.applied).toBe(true);

    const classesAfterReload = await reloadedTeacherDb.classes.toArray();
    expect(classesAfterReload.length).toBe(1);
    expect(classesAfterReload[0].name).toBe('Lớp 5A Test');
  });

  it('Kiểm tra chuyển đổi tài khoản: Lớp của A không hiện cho B, đăng nhập lại A vẫn khôi phục đủ', async () => {
    const TEACHER_B_ID = '22222222-2222-4222-8222-222222222222';
    const teacherUserA: User = {
      id: TEACHER_ID,
      email: 'teacher.a@test.com',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    };
    const teacherUserB: User = {
      id: TEACHER_B_ID,
      email: 'teacher.b@test.com',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    };

    let currentUser: any = null;
    let currentProfile: any = null;
    let lastKnownUserId: string | null = null;
    let seq = 0;

    const deps: AuthTransitionDependencies = {
      getCurrentSeq: () => seq,
      getLastKnownUserId: () => lastKnownUserId,
      setLastKnownUserId: (id) => {
        lastKnownUserId = id;
      },
      setUser: (u) => {
        currentUser = u;
      },
      setProfile: (p) => {
        currentProfile = p;
      },
      setAuthError: () => {},
      getCurrentUserProfile: async () => ({
        id: currentUser?.id ?? TEACHER_ID,
        email: currentUser?.email ?? 'teacher@test.com',
        fullName: 'Giáo viên',
        role: 'teacher',
      }),
      syncNow: async (targetDb) => {
        return syncClassesAndStudentsFromSupabase(undefined, targetDb);
      },
      clearSyncedCloudCacheFromLocal: (targetDb) => clearSyncedCloudCacheFromLocal(targetDb),
    };

    // A đăng nhập & tạo lớp
    seq++;
    currentSessionUserId = TEACHER_ID;
    invalidateAuthenticatedContextCache();
    await processAuthTransition(teacherUserA, seq, deps);
    expect(currentProfile?.role).toBe('teacher');
    const dbA = getDatabaseForUser(TEACHER_ID);
    setActiveDatabase(dbA, TEACHER_ID);

    await createClass({
      name: 'Lớp 1A của Cô A',
      schoolYear: '2026-2027',
      teacherName: 'Cô A',
    }, dbA);

    expect(await dbA.classes.count()).toBe(1);

    // Chuyển sang B đăng nhập
    seq++;
    currentSessionUserId = TEACHER_B_ID;
    invalidateAuthenticatedContextCache();
    await processAuthTransition(teacherUserB, seq, deps);
    const dbB = getDatabaseForUser(TEACHER_B_ID);
    setActiveDatabase(dbB, TEACHER_B_ID);

    // DB của B không được có lớp của A
    expect(await dbB.classes.count()).toBe(0);

    // B đăng xuất
    seq++;
    currentSessionUserId = '';
    invalidateAuthenticatedContextCache();
    await processAuthTransition(null, seq, deps);

    // A đăng nhập lại
    seq++;
    currentSessionUserId = TEACHER_ID;
    invalidateAuthenticatedContextCache();
    await processAuthTransition(teacherUserA, seq, deps);
    const reloadedDbA = getDatabaseForUser(TEACHER_ID);
    setActiveDatabase(reloadedDbA, TEACHER_ID);

    // Đồng bộ lại dữ liệu cho A
    await syncClassesAndStudentsFromSupabase(undefined, reloadedDbA);

    // Lớp của A phải được phục hồi
    const classesA = await reloadedDbA.classes.toArray();
    expect(classesA.length).toBe(1);
    expect(classesA[0].name).toBe('Lớp 1A của Cô A');
  });
});
