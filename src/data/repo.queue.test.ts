import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Khởi tạo mock cho Supabase client để kiểm soát chính xác phản hồi API và session
const mockSupabaseState = {
  currentSessionUser: null as { id: string; email: string } | null,
  upsertHandler: vi.fn(),
  deleteHandler: vi.fn(),
  selectHandler: vi.fn(),
};

vi.mock('../lib/supabaseClient', () => {
  return {
    isSupabaseConfigured: true,
    checkSupabaseConnection: vi.fn().mockResolvedValue({ ok: true }),
    supabase: {
      auth: {
        getSession: vi.fn(async () => {
          if (!mockSupabaseState.currentSessionUser) {
            return { data: { session: null }, error: null };
          }
          return {
            data: {
              session: {
                user: mockSupabaseState.currentSessionUser,
                access_token: `token-${mockSupabaseState.currentSessionUser.id}`,
              },
            },
            error: null,
          };
        }),
      },
      from: (table: string) => {
        const builder: any = {
          select: vi.fn((_cols?: string) => builder),
          eq: vi.fn((_col: string, _val: any) => builder),
          in: vi.fn((_col: string, _vals: any[]) => builder),
          or: vi.fn((_condition: string) => builder),
          maybeSingle: vi.fn(async () => {
            return mockSupabaseState.selectHandler(table, 'maybeSingle');
          }),
          upsert: vi.fn((payload: any, options?: any) => {
            const executeUpsert = async () => mockSupabaseState.upsertHandler(table, payload, options);
            return {
              select: vi.fn((_cols?: string) => executeUpsert()),
              then: (resolve: any, reject: any) => executeUpsert().then(resolve, reject),
            };
          }),
          delete: vi.fn(() => {
            const executeDelete = async () => mockSupabaseState.deleteHandler(table);
            const deleteChain: any = {
              eq: vi.fn((_col: string, _val: any) => deleteChain),
              then: (resolve: any, reject: any) => executeDelete().then(resolve, reject),
            };
            return deleteChain;
          }),
        };
        return builder;
      },
    },
  };
});

import {
  getDatabaseForUser,
  closeDatabaseForUser,
  db as legacyDb,
  PinkDB,
} from './db';
import {
  setActiveDatabase,
  getPendingSyncQueue,
  savePendingSyncQueue,
  flushPendingSyncQueue,
  PendingSyncItem,
} from './repo';

// Helper tạo deferred Promise để kiểm soát chính xác thứ tự bất đồng bộ
function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TIENCLASS — BƯỚC 2.3B-4: Kiểm toán & Cô lập Hàng đợi Đồng bộ (Queue Isolation & Multi-tab)', () => {
  const userA = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'teacher.a@test.com',
  };
  const userB = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'teacher.b@test.com',
  };

  let dbA: PinkDB;
  let dbB: PinkDB;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).process.env.STRICT_USER_DB = '1';

    dbA = getDatabaseForUser(userA.id);
    dbB = getDatabaseForUser(userB.id);

    await dbA.classes.clear();
    await dbA.students.clear();
    await dbA.transactions.clear();
    await dbA.attendance.clear();
    await dbA.comments.clear();
    await dbA.kv.clear();

    await dbB.classes.clear();
    await dbB.students.clear();
    await dbB.transactions.clear();
    await dbB.attendance.clear();
    await dbB.comments.clear();
    await dbB.kv.clear();

    await legacyDb.classes.clear();
    await legacyDb.students.clear();
    await legacyDb.transactions.clear();
    await legacyDb.kv.clear();

    // Mặc định mock Supabase trả về thành công
    mockSupabaseState.upsertHandler.mockImplementation(async (_table, payload) => {
      if (Array.isArray(payload)) {
        return { data: payload.map((p, idx) => ({ id: p.id || `gen-${idx}` })), error: null };
      }
      return { data: [{ id: payload.id || 'gen-1' }], error: null };
    });

    mockSupabaseState.deleteHandler.mockResolvedValue({ data: null, error: null });
    mockSupabaseState.selectHandler.mockImplementation(async (table) => {
      if (table === 'profiles') {
        const u = mockSupabaseState.currentSessionUser;
        if (!u) return { data: null, error: null };
        return {
          data: {
            id: u.id,
            email: u.email,
            full_name: u.id === userA.id ? 'Giáo viên A' : 'Giáo viên B',
            role: 'teacher',
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
  });

  afterEach(() => {
    delete (globalThis as any).process.env.STRICT_USER_DB;
    closeDatabaseForUser(userA.id);
    closeDatabaseForUser(userB.id);
    setActiveDatabase(null, null);
    mockSupabaseState.currentSessionUser = null;
  });

  it('1. Mục hàng đợi của A chỉ được xử lý trong đúng ngữ cảnh của tài khoản A', async () => {
    // Thiết lập phiên hoạt động là User A
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    const txId = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    const classId = 'cccccccc-1111-4ccc-8ccc-cccccccccccc';
    const studentId = '11111111-1111-4111-8111-111111111111';
    const batchId = 'bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb';

    await dbA.transactions.put({
      id: txId,
      classId,
      studentId,
      criterionId: null,
      delta: 5,
      criterionName: 'Phát biểu',
      batchId,
      actor: 'Cô A',
      createdAt: Date.now(),
    });

    // Thêm mục vào queue của A với userId ràng buộc là userA.id
    const itemA: PendingSyncItem = {
      key: `pts:${txId}`,
      kind: 'points_upsert',
      txId,
      createdAt: Date.now(),
      userId: userA.id,
      retryCount: 0,
      status: 'pending',
    };
    await savePendingSyncQueue([itemA], dbA);

    // Thực thi flush trong ngữ cảnh A
    const res = await flushPendingSyncQueue(dbA);
    expect(res.flushedCount).toBe(1);
    expect(res.remainingCount).toBe(0);

    const remainingA = await getPendingSyncQueue(dbA);
    expect(remainingA).toHaveLength(0);

    // Xác nhận payload gửi lên mang actor_id của A
    expect(mockSupabaseState.upsertHandler).toHaveBeenCalledWith(
      'student_points',
      expect.objectContaining({
        id: txId,
        actor_id: userA.id,
      }),
      expect.anything(),
    );

    // Thử chuyển sang phiên User B và gọi flush trên dbA -> Phải bị từ chối, không xử lý
    mockSupabaseState.currentSessionUser = userB;
    setActiveDatabase(dbB, userB.id);

    await savePendingSyncQueue([itemA], dbA);
    const rejectedRes = await flushPendingSyncQueue(dbA);
    expect(rejectedRes.flushedCount).toBe(0);
    // Mục trong DB A vẫn còn nguyên vẹn, không bị B xóa hay flush
    const stillInA = await getPendingSyncQueue(dbA);
    expect(stillInA).toHaveLength(1);
  });

  it('2. Đổi sang B trong lúc request của A đang chờ không làm dữ liệu A bị ghi nhận dưới B', async () => {
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    const txId = 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa';
    await dbA.transactions.put({
      id: txId,
      classId: 'cccccccc-2222-4ccc-8ccc-cccccccccccc',
      studentId: '22222222-2222-4222-8222-222222222222',
      criterionId: null,
      delta: 10,
      criterionName: 'Làm bài tập tốt',
      batchId: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb',
      actor: 'Cô A',
      createdAt: Date.now(),
    });

    const itemA: PendingSyncItem = {
      key: `pts:${txId}`,
      kind: 'points_upsert',
      txId,
      createdAt: Date.now(),
      userId: userA.id,
    };
    await savePendingSyncQueue([itemA], dbA);

    // Làm trễ request Supabase upsert
    const deferred = createDeferred<any>();
    const inFlightDeferred = createDeferred<void>();
    mockSupabaseState.upsertHandler.mockImplementation(async () => {
      inFlightDeferred.resolve();
      return deferred.promise;
    });

    // Kích hoạt flush
    const flushPromise = flushPendingSyncQueue(dbA);

    // Chờ cho đến khi request mạng thực sự đang bay
    await inFlightDeferred.promise;

    // Trong lúc request của A đang bay, chuyển phiên sang User B
    mockSupabaseState.currentSessionUser = userB;
    setActiveDatabase(dbB, userB.id);

    // Giải phóng request Supabase phản hồi
    deferred.resolve({ data: [{ id: txId }], error: null });

    const res = await flushPromise;
    // Vì phiên đã chuyển sang B khi kiểm tra hậu kỳ sau await, A không được tính thành công
    expect(res.flushedCount).toBe(0);

    // Kiểm tra hàng đợi của A: mục vẫn được bảo toàn nguyên vẹn
    const queueA = await getPendingSyncQueue(dbA);
    expect(queueA).toHaveLength(1);
    expect('txId' in queueA[0] && queueA[0].txId).toBe(txId);

    // Kiểm tra DB B: không có bất kỳ dữ liệu nào của A bị ghi nhận sang B
    const kvB = await dbB.kv.get('cloud_synced_ids');
    expect(kvB).toBeUndefined();
  });

  it('3. Mục không rõ chủ sở hữu hoặc sai userId được giữ lại an toàn (Quarantined)', async () => {
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    // 1 mục legacy không có userId, và 1 mục có userId của người khác (User B)
    const orphanItem: PendingSyncItem = {
      key: 'pts:orphan-1',
      kind: 'points_upsert',
      txId: 'aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: Date.now(),
      // Không có userId
    };

    const wrongOwnerItem: PendingSyncItem = {
      key: 'pts:wrong-owner',
      kind: 'points_upsert',
      txId: 'aaaaaaaa-4444-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: Date.now(),
      userId: userB.id, // Thuộc về B chứ không phải A
    };

    await savePendingSyncQueue([orphanItem, wrongOwnerItem], dbA);

    const res = await flushPendingSyncQueue(dbA);
    // Cả 2 mục đều không được gửi
    expect(res.flushedCount).toBe(0);
    expect(res.remainingCount).toBe(2);

    // Không có cuộc gọi Supabase nào được thực hiện
    expect(mockSupabaseState.upsertHandler).not.toHaveBeenCalled();

    // Cả 2 mục được giữ nguyên trong queue với trạng thái cách ly (quarantined)
    const queue = await getPendingSyncQueue(dbA);
    expect(queue).toHaveLength(2);
    expect(queue[0].status).toBe('quarantined');
    expect(queue[1].status).toBe('quarantined');
    expect(queue[0].lastError).toContain('chưa xác định chủ sở hữu');
    expect(queue[1].lastError).toContain('không khớp với tài khoản hiện hành');
  });

  it('4. Lỗi xác thực (401/403/RLS) không làm mất mục và không retry vô hạn', async () => {
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    const txId = 'aaaaaaaa-5555-4aaa-8aaa-aaaaaaaaaaaa';
    await dbA.transactions.put({
      id: txId,
      classId: 'cccccccc-5555-4ccc-8ccc-cccccccccccc',
      studentId: '55555555-5555-4555-8555-555555555555',
      criterionId: null,
      delta: 2,
      criterionName: 'Phát biểu',
      batchId: 'bbbbbbbb-5555-4bbb-8bbb-bbbbbbbbbbbb',
      actor: 'Cô A',
      createdAt: Date.now(),
    });

    const itemA: PendingSyncItem = {
      key: `pts:${txId}`,
      kind: 'points_upsert',
      txId,
      createdAt: Date.now(),
      userId: userA.id,
    };
    await savePendingSyncQueue([itemA], dbA);

    // Giả lập Supabase trả về lỗi RLS 403
    mockSupabaseState.upsertHandler.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy for table student_points' },
    });

    const res1 = await flushPendingSyncQueue(dbA);
    expect(res1.flushedCount).toBe(0);
    expect(res1.remainingCount).toBe(1);

    const queueAfterErr = await getPendingSyncQueue(dbA);
    expect(queueAfterErr).toHaveLength(1);
    expect(queueAfterErr[0].status).toBe('failed_auth');
    expect(queueAfterErr[0].retryCount).toBe(1);
    expect(queueAfterErr[0].lastError).toContain('row-level security');

    // Lần gọi tiếp theo: mục bị failed_auth không tự động retry để tránh spam và nghẽn mạng
    mockSupabaseState.upsertHandler.mockClear();
    const res2 = await flushPendingSyncQueue(dbA);
    expect(res2.flushedCount).toBe(0);
    expect(mockSupabaseState.upsertHandler).not.toHaveBeenCalled();
    // Mục vẫn được bảo toàn trong hàng đợi
    const queuePreserved = await getPendingSyncQueue(dbA);
    expect(queuePreserved).toHaveLength(1);
    expect(queuePreserved[0].status).toBe('failed_auth');
  });

  it('5. Mục thất bại có thể thử lại an toàn (Idempotent) qua mã 23505 mà không tạo bản ghi trùng', async () => {
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    const txId = 'aaaaaaaa-6666-4aaa-8aaa-aaaaaaaaaaaa';
    await dbA.transactions.put({
      id: txId,
      classId: 'cccccccc-6666-4ccc-8ccc-cccccccccccc',
      studentId: '66666666-6666-4666-8666-666666666666',
      criterionId: null,
      delta: 3,
      criterionName: 'Giúp đỡ bạn',
      batchId: 'bbbbbbbb-6666-4bbb-8bbb-bbbbbbbbbbbb',
      actor: 'Cô A',
      createdAt: Date.now(),
    });

    const itemA: PendingSyncItem = {
      key: `pts:${txId}`,
      kind: 'points_upsert',
      txId,
      createdAt: Date.now(),
      userId: userA.id,
    };
    await savePendingSyncQueue([itemA], dbA);

    // Giả lập lỗi xung đột khóa 23505 (đã được ghi trên server trước đó)
    mockSupabaseState.upsertHandler.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    // Khi kiểm tra lại trên server, server xác nhận bản ghi đã tồn tại
    mockSupabaseState.selectHandler.mockImplementation(async (table) => {
      if (table === 'student_points') {
        return { data: { id: txId }, error: null };
      }
      if (table === 'profiles') {
        return { data: { id: userA.id, role: 'teacher' }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await flushPendingSyncQueue(dbA);
    // Nhờ cơ chế idempotent 23505, mục được xác nhận thành công và loại khỏi queue
    expect(res.flushedCount).toBe(1);
    expect(res.remainingCount).toBe(0);

    const queue = await getPendingSyncQueue(dbA);
    expect(queue).toHaveLength(0);
  });

  it('6. Dữ liệu hàng đợi legacy không bị tự động xử lý trong ngữ cảnh tài khoản mới', async () => {
    // Nạp một mục vào database legacy pink-classroom
    await legacyDb.kv.put({
      key: 'cloud_pending_sync_queue',
      value: [
        {
          key: 'pts:legacy-1',
          kind: 'points_upsert',
          txId: 'aaaaaaaa-7777-4aaa-8aaa-aaaaaaaaaaaa',
          createdAt: Date.now(),
        },
      ],
    });

    // Đăng nhập tài khoản mới (User A)
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    // Chạy flush trên tài khoản mới
    const res = await flushPendingSyncQueue(dbA);
    expect(res.flushedCount).toBe(0);
    expect(res.remainingCount).toBe(0);

    // Kiểm tra database legacy: mục legacy vẫn nằm nguyên trong pink-classroom, không bị xóa hay đụng tới
    const legacyRow = await legacyDb.kv.get('cloud_pending_sync_queue');
    expect(legacyRow?.value).toHaveLength(1);
  });

  it('7. Mô phỏng Đa Tab: Phát hiện token Supabase bị hoán đổi bởi tab khác giữa các lệnh await', async () => {
    mockSupabaseState.currentSessionUser = userA;
    setActiveDatabase(dbA, userA.id);

    const txId1 = 'aaaaaaaa-8888-4aaa-8aaa-aaaaaaaaaaaa';
    const txId2 = 'aaaaaaaa-9999-4aaa-8aaa-aaaaaaaaaaaa';

    await dbA.transactions.put({
      id: txId1,
      classId: 'cccccccc-8888-4ccc-8ccc-cccccccccccc',
      studentId: '88888888-8888-4888-8888-888888888888',
      criterionId: null,
      delta: 1,
      criterionName: 'Đúng giờ',
      batchId: 'bbbbbbbb-8888-4bbb-8bbb-bbbbbbbbbbbb',
      actor: 'Cô A',
      createdAt: Date.now(),
    });

    await dbA.transactions.put({
      id: txId2,
      classId: 'cccccccc-9999-4ccc-8ccc-cccccccccccc',
      studentId: '99999999-9999-4999-8999-999999999999',
      criterionId: null,
      delta: 1,
      criterionName: 'Trực nhật',
      batchId: 'bbbbbbbb-9999-4bbb-8bbb-bbbbbbbbbbbb',
      actor: 'Cô A',
      createdAt: Date.now(),
    });

    const item1: PendingSyncItem = {
      key: `pts:${txId1}`,
      kind: 'points_upsert',
      txId: txId1,
      createdAt: Date.now(),
      userId: userA.id,
    };
    const item2: PendingSyncItem = {
      key: `pts:${txId2}`,
      kind: 'points_upsert',
      txId: txId2,
      createdAt: Date.now(),
      userId: userA.id,
    };

    await savePendingSyncQueue([item1, item2], dbA);

    // Khi xử lý item 1 thành công: Tab 2 bí mật đăng nhập User B (ghi đè Supabase token trong localStorage)
    mockSupabaseState.upsertHandler.mockImplementation(async (_table, payload) => {
      if (payload.id === txId1) {
        // Tab 2 đổi sang User B
        mockSupabaseState.currentSessionUser = userB;
        return { data: [{ id: txId1 }], error: null };
      }
      return { data: [{ id: payload.id }], error: null };
    });

    const res = await flushPendingSyncQueue(dbA);
    // Item 1 bị phát hiện phiên đổi ngay sau lệnh await, nên cả item 1 và item 2 đều không được tính thành công
    expect(res.flushedCount).toBe(0);

    // Cả 2 item được giữ lại nguyên vẹn trong queue của A
    const queueA = await getPendingSyncQueue(dbA);
    expect(queueA).toHaveLength(2);
    expect(queueA.map((i) => ('txId' in i ? i.txId : null))).toEqual([txId1, txId2]);
  });
});
