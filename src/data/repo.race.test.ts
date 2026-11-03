import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setActiveDatabase,
  getOperationScope,
  awardPoints,
  bulkAddStudents,
  saveAttendance,
} from './repo';
import {
  getDatabaseForUser,
  closeDatabaseForUser,
  db as legacyDb,
  PinkDB,
} from './db';

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

// Barrier điều khiển các cuộc gọi Supabase
let supabaseCallBarrier: ReturnType<typeof createDeferred<void>> | null = null;
let currentMockUser: { id: string; email: string; role: string; fullName: string } | null = null;

vi.mock('../lib/supabaseClient', () => {
  return {
    isSupabaseConfigured: true,
    supabase: {
      auth: {
        getSession: vi.fn(async () => {
          if (!currentMockUser) return { data: { session: null }, error: null };
          return {
            data: {
              session: {
                user: { id: currentMockUser.id, email: currentMockUser.email },
              },
            },
            error: null,
          };
        }),
      },
      from: vi.fn((table: string) => {
        const queryObj: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => {
            if (table === 'profiles') {
              if (!currentMockUser) return { data: null, error: null };
              return {
                data: {
                  id: currentMockUser.id,
                  email: currentMockUser.email,
                  full_name: currentMockUser.fullName,
                  role: currentMockUser.role,
                  phone: null,
                  avatar_url: null,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          }),
          insert: vi.fn((payload: any) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            const executeInsert = async () => {
              if (supabaseCallBarrier) {
                await supabaseCallBarrier.promise;
              }
              return { data: rows, error: null };
            };
            return {
              select: vi.fn(() => executeInsert()),
              then: (resolve: any, reject: any) => executeInsert().then(resolve, reject),
            };
          }),
          upsert: vi.fn((payload: any) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            const executeUpsert = async () => {
              if (supabaseCallBarrier) {
                await supabaseCallBarrier.promise;
              }
              return { data: rows, error: null };
            };
            return {
              select: vi.fn(() => executeUpsert()),
              then: (resolve: any, reject: any) => executeUpsert().then(resolve, reject),
            };
          }),
          update: vi.fn((payload: any) => {
            const executeUpdate = async () => {
              if (supabaseCallBarrier) {
                await supabaseCallBarrier.promise;
              }
              return { data: [payload], error: null };
            };
            return {
              eq: vi.fn().mockReturnThis(),
              select: vi.fn(() => executeUpdate()),
              then: (resolve: any, reject: any) => executeUpdate().then(resolve, reject),
            };
          }),
          delete: vi.fn().mockReturnThis(),
        };
        // Mock chain for delete().eq()... which awaits
        queryObj.then = async (resolve: any) => {
          if (supabaseCallBarrier) {
            await supabaseCallBarrier.promise;
          }
          resolve({ data: [{ id: 'deleted' }], error: null });
        };
        return queryObj;
      }),
      rpc: vi.fn(async (procName: string, _args: any) => {
        if (supabaseCallBarrier) {
          await supabaseCallBarrier.promise;
        }
        if (procName === 'create_student_in_class') {
          return { data: { ok: true, student_id: '99999999-9999-4999-8999-000000000099' }, error: null };
        }
        return { data: { ok: true }, error: null };
      }),
    },
  };
});

describe('SEC-02: Ngăn Race Condition & Cố định Ngữ cảnh Database trong Repository', () => {
  const userA = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'teacher.a@test.com',
    fullName: 'Cô Giáo Viên A',
    role: 'teacher',
  };

  const userB = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'teacher.b@test.com',
    fullName: 'Thầy Giáo Viên B',
    role: 'teacher',
  };

  let dbA: PinkDB;
  let dbB: PinkDB;

  beforeEach(async () => {
    supabaseCallBarrier = null;
    currentMockUser = null;
    setActiveDatabase(null, null);

    dbA = getDatabaseForUser(userA.id);
    dbB = getDatabaseForUser(userB.id);

    await dbA.classes.clear();
    await dbA.students.clear();
    await dbA.transactions.clear();
    await dbA.attendance.clear();
    await dbA.activities.clear();

    await dbB.classes.clear();
    await dbB.students.clear();
    await dbB.transactions.clear();
    await dbB.attendance.clear();
    await dbB.activities.clear();

    await legacyDb.classes.clear();
    await legacyDb.students.clear();
    await legacyDb.transactions.clear();
    await legacyDb.attendance.clear();
  });

  afterEach(() => {
    closeDatabaseForUser(userA.id);
    closeDatabaseForUser(userB.id);
    setActiveDatabase(null, null);
  });

  it('1. awardPoints: Đang chờ Supabase thì chuyển từ A sang B -> Thao tác A bị hủy, B & Legacy không bị ghi', async () => {
    // Thiết lập phiên ban đầu của A
    currentMockUser = userA;
    setActiveDatabase(dbA, userA.id);

    const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await dbA.classes.put({
      id: classId,
      name: 'Lớp 1A',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Viên A',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await dbA.students.put({
      id: studentId,
      classId,
      code: 'HS0001',
      fullName: 'Học sinh A1',
      gender: 'female',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Tạo barrier chặn tại Supabase call
    supabaseCallBarrier = createDeferred();

    // Bắt đầu thao tác chấm điểm của A
    const awardPromise = awardPoints({
      classId,
      studentIds: [studentId],
      customName: 'Phát biểu tốt',
      delta: 2,
    });

    // Trong khi A đang chờ kết quả Supabase, người dùng chuyển sang tài khoản B!
    currentMockUser = userB;
    setActiveDatabase(dbB, userB.id);

    // Mở barrier cho Supabase của A trả về
    supabaseCallBarrier.resolve();

    // Thao tác A phải ném lỗi do assertActive() phát hiện phiên làm việc đã đổi
    await expect(awardPromise).rejects.toThrow(/Phiên làm việc đã thay đổi/);

    // XÁC MINH CÔ LẬP TUYỆT ĐỐI:
    // Database B không chứa bất kỳ điểm nào của A
    const bTxCount = await dbB.transactions.count();
    expect(bTxCount).toBe(0);

    // Database A không bị ghi sai trạng thái
    const aTxCount = await dbA.transactions.count();
    expect(aTxCount).toBe(0);

    // Database legacy tuyệt đối không bị ghi
    const legacyTxCount = await legacyDb.transactions.count();
    expect(legacyTxCount).toBe(0);
  });

  it('2. bulkAddStudents: Đang chờ Supabase RPC thì chuyển tài khoản -> Học sinh không bị ghi vào DB của B', async () => {
    currentMockUser = userA;
    setActiveDatabase(dbA, userA.id);

    const classId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    await dbA.classes.put({
      id: classId,
      name: 'Lớp 1A',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Viên A',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    supabaseCallBarrier = createDeferred();

    const bulkPromise = bulkAddStudents(classId, [
      {
        code: 'HS9999',
        fullName: 'Nguyễn Văn Race',
        gender: 'male',
        avatar: 'cat-pink',
      },
    ]);

    // Chuyển sang tài khoản B trong lúc RPC đang bay
    currentMockUser = userB;
    setActiveDatabase(dbB, userB.id);

    supabaseCallBarrier.resolve();

    await expect(bulkPromise).rejects.toThrow(/Phiên làm việc đã thay đổi/);

    // Database B tuyệt đối không nhận học sinh của A
    const bStudents = await dbB.students.toArray();
    expect(bStudents.length).toBe(0);

    // Legacy không bị ghi
    const legacyStudents = await legacyDb.students.toArray();
    expect(legacyStudents.length).toBe(0);
  });

  it('3. saveAttendance: Đang chờ Supabase thì người dùng đăng xuất (null) -> Không ghi vào DB và legacy', async () => {
    currentMockUser = userA;
    setActiveDatabase(dbA, userA.id);

    const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await dbA.classes.put({
      id: classId,
      name: 'Lớp 1A',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Viên A',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await dbA.students.put({
      id: studentId,
      classId,
      code: 'HS0001',
      fullName: 'Học sinh A1',
      gender: 'female',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    supabaseCallBarrier = createDeferred();

    const attPromise = saveAttendance(classId, '2026-10-27', 'morning', [
      { studentId, status: 'present' },
    ]);

    // Người dùng bấm đăng xuất
    currentMockUser = null;
    setActiveDatabase(null, null);

    supabaseCallBarrier.resolve();

    await expect(attPromise).rejects.toThrow(/Phiên làm việc đã thay đổi hoặc đã đăng xuất/);

    // Cả DB A, DB B và legacy đều an toàn
    expect(await dbA.attendance.count()).toBe(0);
    expect(await dbB.attendance.count()).toBe(0);
    expect(await legacyDb.attendance.count()).toBe(0);
  });

  it('4. Legacy DB Protection: Ngăn cấm đặt activeDatabase là database legacy "pink-classroom"', () => {
    setActiveDatabase(legacyDb, userA.id);
    expect(() => {
      getOperationScope();
    }).toThrow('Cảnh báo an toàn: Thao tác không được phép thực thi trên database legacy "pink-classroom".');
  });

  it('5. Luồng bình thường khi phiên ổn định: Dữ liệu ghi vào đúng DB của A, không rò rỉ sang B hay legacy', async () => {
    currentMockUser = userA;
    setActiveDatabase(dbA, userA.id);

    const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await dbA.classes.put({
      id: classId,
      name: 'Lớp 1A',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Viên A',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await dbA.students.put({
      id: studentId,
      classId,
      code: 'HS0001',
      fullName: 'Học sinh A1',
      gender: 'female',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Không chuyển session, thao tác hoàn thành bình thường
    const res = await awardPoints({
      classId,
      studentIds: [studentId],
      customName: 'Phát biểu tốt',
      delta: 2,
    });

    expect(res.count).toBe(1);

    // Ghi đúng vào DB A
    const aTx = await dbA.transactions.toArray();
    expect(aTx.length).toBe(1);
    expect(aTx[0].criterionName).toBe('Phát biểu tốt');

    // DB B và Legacy hoàn toàn trống
    expect(await dbB.transactions.count()).toBe(0);
    expect(await legacyDb.transactions.count()).toBe(0);
  });

  it('6. Chặn thao tác khi chưa đăng nhập / chưa có database người dùng hợp lệ trong chế độ nghiêm ngặt', () => {
    setActiveDatabase(null, null);
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process;
    const originalEnv = proc?.env?.STRICT_USER_DB;
    try {
      if (proc?.env) proc.env.STRICT_USER_DB = 'true';
      expect(() => {
        getOperationScope();
      }).toThrow('Chưa thiết lập database người dùng hoặc phiên đăng nhập chưa hợp lệ.');
    } finally {
      if (proc?.env) {
        if (originalEnv !== undefined) {
          proc.env.STRICT_USER_DB = originalEnv;
        } else {
          delete proc.env.STRICT_USER_DB;
        }
      }
    }
  });
});
