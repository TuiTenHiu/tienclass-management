import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

import type { User } from '@supabase/supabase-js';
import {
  processAuthTransition,
  safelyCleanupAndClosePreviousUser,
  type AuthTransitionDependencies,
} from './AuthContext';
import {
  getDatabaseForUser,
  closeDatabaseForUser,
  db as legacyDb,
  PinkDB,
} from '../data/db';
import {
  setActiveDatabase,
  getActiveDatabase,
  clearSyncedCloudCacheFromLocal,
  CLOUD_SYNC_KV_KEY,
  PENDING_SYNC_QUEUE_KEY,
  PendingSyncItem,
} from '../data/repo';

// Helper tạo deferred Promise để kiểm soát chính xác thứ tự bất đồng bộ (không dùng setTimeout)
function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SEC-03: Vòng đời dọn Cache & Bảo toàn dữ liệu khi Đăng xuất / Chuyển tài khoản', () => {
  const userA = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'teacher.a@test.com',
  } as User;

  const userB = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'teacher.b@test.com',
  } as User;

  let dbA: PinkDB;
  let dbB: PinkDB;
  let seqCounter = 0;
  let lastKnownUserId: string | null = null;
  let currentUserState: User | null = null;

  beforeEach(async () => {
    seqCounter = 0;
    lastKnownUserId = null;
    currentUserState = null;
    setActiveDatabase(null, null);

    dbA = getDatabaseForUser(userA.id);
    dbB = getDatabaseForUser(userB.id);

    await dbA.classes.clear();
    await dbA.students.clear();
    await dbA.transactions.clear();
    await dbA.attendance.clear();
    await dbA.comments.clear();
    await dbA.criteria.clear();
    await dbA.kv.clear();

    await dbB.classes.clear();
    await dbB.students.clear();
    await dbB.transactions.clear();
    await dbB.attendance.clear();
    await dbB.comments.clear();
    await dbB.criteria.clear();
    await dbB.kv.clear();

    await legacyDb.classes.clear();
    await legacyDb.students.clear();
    await legacyDb.transactions.clear();
  });

  afterEach(() => {
    closeDatabaseForUser(userA.id);
    closeDatabaseForUser(userB.id);
    setActiveDatabase(null, null);
  });

  const createDeps = (overrides?: Partial<AuthTransitionDependencies>): AuthTransitionDependencies => ({
    getCurrentSeq: () => seqCounter,
    getLastKnownUserId: () => lastKnownUserId,
    setLastKnownUserId: (id) => {
      lastKnownUserId = id;
    },
    setUser: (u) => {
      currentUserState = u;
    },
    setProfile: () => {},
    setAuthError: () => {},
    getCurrentUserProfile: vi.fn(async () => {
      const u = currentUserState;
      if (!u) return null;
      return {
        id: u.id,
        email: u.email ?? '',
        fullName: 'Giáo viên',
        role: 'teacher' as const,
      };
    }),
    syncNow: vi.fn(async () => ({ synced: true })),
    clearSyncedCloudCacheFromLocal: (targetDb) => clearSyncedCloudCacheFromLocal(targetDb),
    ...overrides,
  });

  it('1. Đăng xuất khỏi A gọi đúng quy trình dọn cache trên database A và đóng DB', async () => {
    const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    // Nạp dữ liệu cloud-synced vào DB A
    await dbA.classes.put({
      id: classId,
      name: 'Lớp 1A',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await dbA.students.put({
      id: studentId,
      classId,
      code: 'HS0001',
      fullName: 'Học sinh 1',
      gender: 'female',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await dbA.kv.put({
      key: CLOUD_SYNC_KV_KEY,
      value: {
        userId: userA.id,
        classIds: [classId],
        criterionIds: [],
        studentIds: [studentId],
        attendanceIds: [],
        transactionIds: [],
        commentIds: [],
        parentLinkIds: [],
      },
    });

    // Giả lập trạng thái trước đó: userA đang đăng nhập
    lastKnownUserId = userA.id;
    currentUserState = userA;
    setActiveDatabase(dbA, userA.id);

    const deps = createDeps();
    seqCounter = 1;

    // Người dùng đăng xuất: sessionUser = null
    const res = await processAuthTransition(null, 1, deps);

    expect(res.applied).toBe(true);
    expect(currentUserState).toBeNull();
    expect(getActiveDatabase()).toBeNull();

    // Mở lại dbA để kiểm tra kết quả dọn cache
    const reopenedDbA = getDatabaseForUser(userA.id);
    const classes = await reopenedDbA.classes.toArray();
    const students = await reopenedDbA.students.toArray();

    // Các bản ghi cache có thể tái tạo đã được dọn sạch
    expect(classes.length).toBe(0);
    expect(students.length).toBe(0);

    // Legacy không bị chạm vào
    expect(await legacyDb.classes.count()).toBe(0);
  });

  it('2. Việc dọn cache của A không chạm vào database B', async () => {
    const classIdA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const classIdB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    // Dữ liệu User A
    await dbA.classes.put({
      id: classIdA,
      name: 'Lớp của A',
      schoolYear: '2026-2027',
      teacherName: 'Giáo viên A',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await dbA.kv.put({
      key: CLOUD_SYNC_KV_KEY,
      value: {
        userId: userA.id,
        classIds: [classIdA],
        criterionIds: [],
        studentIds: [],
        attendanceIds: [],
        transactionIds: [],
        commentIds: [],
        parentLinkIds: [],
      },
    });

    // Dữ liệu User B
    await dbB.classes.put({
      id: classIdB,
      name: 'Lớp của B',
      schoolYear: '2026-2027',
      teacherName: 'Giáo viên B',
      color: '#B5EAD7',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await dbB.kv.put({
      key: CLOUD_SYNC_KV_KEY,
      value: {
        userId: userB.id,
        classIds: [classIdB],
        criterionIds: [],
        studentIds: [],
        attendanceIds: [],
        transactionIds: [],
        commentIds: [],
        parentLinkIds: [],
      },
    });

    // User A đăng xuất
    lastKnownUserId = userA.id;
    currentUserState = userA;
    setActiveDatabase(dbA, userA.id);

    const deps = createDeps();
    seqCounter = 1;

    await processAuthTransition(null, 1, deps);

    // Database B phải còn nguyên vẹn 100%
    const bClasses = await dbB.classes.toArray();
    expect(bClasses.length).toBe(1);
    expect(bClasses[0].name).toBe('Lớp của B');
  });

  it('3. Dữ liệu offline chưa đồng bộ và hàng đợi của A vẫn được bảo toàn', async () => {
    const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const pendingTxId = 'tttttttt-tttt-4ttt-8ttt-tttttttttttt';
    const offlineStudentId = 'offline-stu-123';

    // 1 bản ghi điểm đang chờ đồng bộ trong pending queue
    const pendingItem: PendingSyncItem = {
      key: `pts:${pendingTxId}`,
      kind: 'points_upsert',
      txId: pendingTxId,
      createdAt: Date.now(),
    };

    await dbA.kv.put({
      key: PENDING_SYNC_QUEUE_KEY,
      value: [pendingItem],
    });

    await dbA.transactions.put({
      id: pendingTxId,
      classId,
      studentId,
      criterionId: null,
      criterionName: 'Offline Points',
      delta: 5,
      actor: 'Cô Tiên',
      batchId: 'batch-1',
      createdAt: Date.now(),
    });

    // 1 học sinh tạo lúc offline (chưa từng sync cloud, không có trong cloud_synced_ids)
    await dbA.students.put({
      id: offlineStudentId,
      classId,
      code: 'HS_OFFLINE',
      fullName: 'Học sinh Offline',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 1 giao dịch cũ đã sync cloud và KHÔNG nằm trong hàng đợi
    const syncedTxId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';
    await dbA.transactions.put({
      id: syncedTxId,
      classId,
      studentId,
      criterionId: null,
      criterionName: 'Old Cloud Points',
      delta: 2,
      actor: 'Cô Tiên',
      batchId: 'batch-0',
      createdAt: Date.now() - 10000,
    });

    // Đánh dấu cloud synced record
    await dbA.kv.put({
      key: CLOUD_SYNC_KV_KEY,
      value: {
        userId: userA.id,
        classIds: [classId],
        criterionIds: [],
        studentIds: [studentId],
        attendanceIds: [],
        transactionIds: [syncedTxId, pendingTxId],
        commentIds: [],
        parentLinkIds: [],
      },
    });

    // Thực hiện dọn cache
    await clearSyncedCloudCacheFromLocal(dbA);

    // XÁC MINH BẢO TOÀN DỮ LIỆU:
    // 1. Giao dịch pending KHÔNG bị xóa
    const txPending = await dbA.transactions.get(pendingTxId);
    expect(txPending).toBeDefined();
    expect(txPending?.criterionName).toBe('Offline Points');

    // 2. Giao dịch đã sync (không có pending) ĐƯỢC dọn an toàn
    const txSynced = await dbA.transactions.get(syncedTxId);
    expect(txSynced).toBeUndefined();

    // 3. Học sinh tạo offline KHÔNG bị xóa
    const offlineStu = await dbA.students.get(offlineStudentId);
    expect(offlineStu).toBeDefined();
    expect(offlineStu?.fullName).toBe('Học sinh Offline');

    // 4. Hàng đợi pending_sync_queue được bảo toàn 100%
    const queueRow = await dbA.kv.get(PENDING_SYNC_QUEUE_KEY);
    expect(queueRow?.value).toEqual([pendingItem]);
  });

  it('4. Nếu dọn cache gặp lỗi, dữ liệu không bị xóa quá mức và ứng dụng xử lý an toàn', async () => {
    lastKnownUserId = userA.id;
    currentUserState = userA;
    setActiveDatabase(dbA, userA.id);

    // Mock clearSyncedCloudCacheFromLocal bị lỗi
    const errorClearCache = vi.fn().mockRejectedValue(new Error('IndexedDB QuotaExceededError'));

    const deps = createDeps({
      clearSyncedCloudCacheFromLocal: errorClearCache,
    });

    seqCounter = 1;

    // Không được throw lỗi ra ngoài làm crash app
    const res = await processAuthTransition(null, 1, deps);

    expect(res.applied).toBe(true);
    expect(currentUserState).toBeNull();
    // Hàm dọn cache vẫn được gọi đúng instance dbA
    expect(errorClearCache).toHaveBeenCalledWith(dbA);
  });

  it('5. Nếu chuyển tài khoản trong khi thao tác dọn cache đang chờ, thao tác cũ không ghi hoặc xóa dữ liệu của B', async () => {
    const classIdB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await dbB.classes.put({
      id: classIdB,
      name: 'Lớp của B',
      schoolYear: '2026-2027',
      teacherName: 'Giáo viên B',
      color: '#B5EAD7',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Tạo barrier chặn thao tác dọn cache của A
    const cleanupBarrier = createDeferred();

    const pendingCleanupPromise = safelyCleanupAndClosePreviousUser(userA.id, async (targetDb) => {
      await cleanupBarrier.promise;
      await clearSyncedCloudCacheFromLocal(targetDb);
    });

    // Trong khi A đang dọn cache, User B đăng nhập và trở thành activeDatabase
    setActiveDatabase(dbB, userB.id);

    // Giải phóng barrier
    cleanupBarrier.resolve();

    await pendingCleanupPromise;

    // Dữ liệu B tuyệt đối không bị ảnh hưởng
    const bClasses = await dbB.classes.toArray();
    expect(bClasses.length).toBe(1);
    expect(bClasses[0].name).toBe('Lớp của B');
  });

  it('6. Khởi động lần đầu khi chưa đăng nhập không vô tình xóa dữ liệu', async () => {
    lastKnownUserId = null;
    currentUserState = null;

    const mockClear = vi.fn();
    const deps = createDeps({
      clearSyncedCloudCacheFromLocal: mockClear,
    });

    seqCounter = 1;
    const res = await processAuthTransition(null, 1, deps);

    expect(res.applied).toBe(true);
    expect(mockClear).not.toHaveBeenCalled();
    expect(getActiveDatabase()).toBeNull();
    expect(await legacyDb.classes.count()).toBe(0);
  });

  it('7. Luồng chuyển tài khoản A sang B: cache A được dọn, DB B trở thành active', async () => {
    const classIdA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await dbA.classes.put({
      id: classIdA,
      name: 'Lớp của A',
      schoolYear: '2026-2027',
      teacherName: 'Giáo viên A',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await dbA.kv.put({
      key: CLOUD_SYNC_KV_KEY,
      value: {
        userId: userA.id,
        classIds: [classIdA],
        criterionIds: [],
        studentIds: [],
        attendanceIds: [],
        transactionIds: [],
        commentIds: [],
        parentLinkIds: [],
      },
    });

    // User A đang đăng nhập
    lastKnownUserId = userA.id;
    currentUserState = userA;
    setActiveDatabase(dbA, userA.id);

    const deps = createDeps();
    seqCounter = 1;

    // Chuyển sang User B
    const res = await processAuthTransition(userB, 1, deps);

    expect(res.applied).toBe(true);
    expect(currentUserState?.id).toBe(userB.id);
    expect(getActiveDatabase()?.name).toBe(dbB.name);

    // Cache của A đã được dọn
    const reopenedDbA = getDatabaseForUser(userA.id);
    expect(await reopenedDbA.classes.count()).toBe(0);
  });
});
