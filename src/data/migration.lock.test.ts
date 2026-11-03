import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

import { db as legacyDb, ALL_TABLES } from './db';
import {
  restoreIndexedDbFromBackup,
  executeMigration,
  createMigrationBackup,
  isLegacyMigrationLocked,
  withLegacyMigrationAuthorization,
  setLegacyMigrationAccessForTesting,
  saveIdMappings,
  getIdMappings,
  LEGACY_MIGRATION_TEST_TOKEN,
  MigrationBackup,
  LegacyMigrationAuthTicket,
  MigrationIdMappingRecord,
} from './migration';

describe('TIENCLASS — BƯỚC 2.3B-6: Khóa bảo vệ Migration / Restore ở tầng mã nguồn (SEC-05)', () => {
  let sampleBackup: MigrationBackup;

  beforeEach(async () => {
    // Đảm bảo trạng thái mặc định: KHÓA BẢO VỆ ĐANG BẬT
    setLegacyMigrationAccessForTesting(LEGACY_MIGRATION_TEST_TOKEN, false);

    // Xóa sạch dữ liệu legacy trước khi nạp dữ liệu mồi
    for (const t of ALL_TABLES) {
      await legacyDb.table(t).clear();
    }

    // Nạp dữ liệu mồi vào legacyDb
    await legacyDb.classes.put({
      id: 'class-legacy-original',
      name: 'Lớp 1A Gốc',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Gốc',
      color: '#F7A8C4',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await legacyDb.students.put({
      id: 'student-legacy-original',
      classId: 'class-legacy-original',
      code: 'HS001',
      fullName: 'Học Sinh Legacy Gốc',
      gender: 'female',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await legacyDb.transactions.put({
      id: 'tx-legacy-original',
      classId: 'class-legacy-original',
      studentId: 'student-legacy-original',
      criterionId: null,
      criterionName: 'Phát biểu',
      delta: 5,
      batchId: 'batch-legacy-1',
      actor: 'Cô Giáo Gốc',
      createdAt: 1000,
    });

    // Tạo một bản sao lưu hợp lệ từ dữ liệu mồi
    sampleBackup = await createMigrationBackup();
  });

  afterEach(() => {
    // Luôn thu hồi quyền truy cập sau mỗi bài test
    try {
      setLegacyMigrationAccessForTesting(LEGACY_MIGRATION_TEST_TOKEN, false);
    } catch {
      // ignore
    }
  });

  it('1. Trạng thái mặc định: Khóa bảo vệ SEC-05 đang BẬT', () => {
    expect(isLegacyMigrationLocked()).toBe(true);
  });

  it('2. Gọi trực tiếp restoreIndexedDbFromBackup bị TỪ CHỐI theo mặc định', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    // Tạo payload backup khác nhằm cố gắng xóa/ghi đè legacy database
    const maliciousBackup: MigrationBackup = {
      ...sampleBackup,
      data: {
        ...sampleBackup.data,
        classes: [], // Cố gắng xóa trắng lớp học
      },
    };

    await expect(restoreIndexedDbFromBackup(maliciousBackup)).rejects.toThrow(
      /Cảnh báo an toàn \(SEC-05\): Thao tác "restoreIndexedDbFromBackup" trên database legacy "pink-classroom" đã bị khóa ở tầng mã nguồn/,
    );
  });

  it('3. Gọi trực tiếp executeMigration bị TỪ CHỐI theo mặc định', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    await expect(executeMigration(sampleBackup)).rejects.toThrow(
      /Cảnh báo an toàn \(SEC-05\): Thao tác "executeMigration" trên database legacy "pink-classroom" đã bị khóa ở tầng mã nguồn/,
    );
  });

  it('4. Khi bị từ chối, KHÔNG có bảng nào trong database legacy bị xóa, ghi đè hoặc thay đổi', async () => {
    // Đọc trạng thái ban đầu
    const classCountBefore = await legacyDb.classes.count();
    const studentCountBefore = await legacyDb.students.count();
    const txCountBefore = await legacyDb.transactions.count();

    expect(classCountBefore).toBe(1);
    expect(studentCountBefore).toBe(1);
    expect(txCountBefore).toBe(1);

    // Cố gắng thực thi cả restore và executeMigration
    try {
      await restoreIndexedDbFromBackup({
        ...sampleBackup,
        data: { classes: [], students: [], transactions: [] } as any,
      });
    } catch {
      // Expected rejection
    }

    try {
      await executeMigration(sampleBackup);
    } catch {
      // Expected rejection
    }

    // Xác minh dữ liệu trong legacy database hoàn toàn nguyên vẹn 100%
    const classCountAfter = await legacyDb.classes.count();
    const studentCountAfter = await legacyDb.students.count();
    const txCountAfter = await legacyDb.transactions.count();

    expect(classCountAfter).toBe(classCountBefore);
    expect(studentCountAfter).toBe(studentCountBefore);
    expect(txCountAfter).toBe(txCountBefore);

    const originalStudent = await legacyDb.students.get('student-legacy-original');
    expect(originalStudent).toBeDefined();
    expect(originalStudent!.fullName).toBe('Học Sinh Legacy Gốc');
  });

  it('5. Cố gắng mở khóa với token không hợp lệ bị từ chối tuyệt đối', async () => {
    expect(() => {
      setLegacyMigrationAccessForTesting('INVALID_TOKEN_123', true);
    }).toThrow(/Từ chối quyền truy cập: Mã ủy quyền di trú legacy không hợp lệ/);

    await expect(
      withLegacyMigrationAuthorization('INVALID_TOKEN_123', async () => {
        return true;
      }),
    ).rejects.toThrow(/Từ chối quyền truy cập: Mã ủy quyền di trú legacy không hợp lệ/);

    expect(isLegacyMigrationLocked()).toBe(true);
  });

  it('6. Mở khóa trong môi trường không phải kiểm thử (production simulation) bị từ chối tuyệt đối', async () => {
    const proc = (globalThis as any).process;
    const originalEnv = proc?.env?.NODE_ENV;
    try {
      // Giả lập môi trường production / trình duyệt
      if (proc?.env) proc.env.NODE_ENV = 'production';

      expect(() => {
        setLegacyMigrationAccessForTesting(LEGACY_MIGRATION_TEST_TOKEN, true);
      }).toThrow(/Cảnh báo an toàn: Cơ chế này chỉ được phép kích hoạt trong môi trường kiểm thử/);

      await expect(
        withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async () => {
          return true;
        }),
      ).rejects.toThrow(
        /Cảnh báo an toàn: Cơ chế mở khóa di trú legacy chỉ được phép thực thi trong môi trường kiểm thử có kiểm soát/,
      );
    } finally {
      if (proc?.env) proc.env.NODE_ENV = originalEnv;
    }
  });

  it('7. Mở khóa có kiểm soát qua withLegacyMigrationAuthorization tự động đóng khóa sau khi hoàn tất', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    let insideLockState = false;
    const result = await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async () => {
      insideLockState = isLegacyMigrationLocked();
      return 'execution_success';
    });

    expect(result).toBe('execution_success');
    expect(insideLockState).toBe(false); // Trong scope được mở khóa

    // Sau khi scope hoàn tất, khóa bảo vệ tự động tái kích hoạt ngay lập tức
    expect(isLegacyMigrationLocked()).toBe(true);

    // Gọi lại khi ra ngoài scope phải bị từ chối ngay lập tức
    await expect(restoreIndexedDbFromBackup(sampleBackup)).rejects.toThrow(/SEC-05/);
  });

  it('8. Mở khóa có kiểm soát tự động đóng khóa ngay cả khi tác vụ bên trong ném ngoại lệ', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    await expect(
      withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async () => {
        throw new Error('Simulated task error');
      }),
    ).rejects.toThrow('Simulated task error');

    // Sau khi exception xảy ra, khóa vẫn được tái kích hoạt trong finally
    expect(isLegacyMigrationLocked()).toBe(true);
  });

  it('9. SEC-05.1: Gọi trực tiếp saveIdMappings bị TỪ CHỐI theo mặc định khi chưa ủy quyền', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    const testMappings: MigrationIdMappingRecord = {
      classes: { 'cls-local-1': 'cls-cloud-1' },
      criteria: {},
      students: {},
      attendance: {},
      transactions: {},
      batches: {},
      comments: {},
    };

    // Gọi trực tiếp khi chưa ủy quyền phải ném lỗi SEC-05 ngay lập tức
    await expect(saveIdMappings(testMappings)).rejects.toThrow(
      /Cảnh báo an toàn \(SEC-05\): Thao tác "saveIdMappings" trên database legacy "pink-classroom" đã bị khóa ở tầng mã nguồn/,
    );

    // Xác nhận không có bản ghi nào bị ghi vào kv table của legacy database
    const currentMappings = await getIdMappings();
    expect(currentMappings.classes['cls-local-1']).toBeUndefined();
  });

  it('10. SEC-05.1: Gọi saveIdMappings trong phạm vi withLegacyMigrationAuthorization thành công', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    const testMappings: MigrationIdMappingRecord = {
      classes: { 'cls-local-auth': 'cls-cloud-auth' },
      criteria: {},
      students: {},
      attendance: {},
      transactions: {},
      batches: {},
      comments: {},
    };

    await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async () => {
      await saveIdMappings(testMappings);
    });

    // Xác minh dữ liệu đã được ghi hợp lệ
    const saved = await getIdMappings();
    expect(saved.classes['cls-local-auth']).toBe('cls-cloud-auth');

    // Sau khi scope kết thúc, gọi lại ngoài scope phải bị từ chối ngay lập tức
    await expect(saveIdMappings(testMappings)).rejects.toThrow(/SEC-05/);
  });

  it('11. SEC-05.2: Concurrency Isolation — Tác vụ B không thể lợi dụng ủy quyền của Tác vụ A khi Tác vụ A đang await', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    let taskAExecuting = false;
    let taskAFinished = false;
    let taskBAttemptedDuringTaskA = false;

    // Tác vụ A: Tác vụ hợp lệ có ủy quyền, thực thi bất đồng bộ có khoảng thời gian await (ví dụ gọi API hoặc chờ I/O)
    const taskAPromise = withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async (ticket) => {
      taskAExecuting = true;
      expect(ticket).toBeDefined();
      expect(isLegacyMigrationLocked()).toBe(false);

      // Giả lập thời gian chờ I/O mạng bất đồng bộ
      await new Promise((resolve) => setTimeout(resolve, 80));

      taskAFinished = true;
      return 'task_a_result';
    });

    // Chờ một khoảng nhỏ để Tác vụ A chắc chắn đã bước vào vùng thực thi và đang await
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(taskAExecuting).toBe(true);
    expect(taskAFinished).toBe(false);

    // Tác vụ B: Chạy đồng thời trong lúc Tác vụ A đang await, KHÔNG được cấp quyền ủy quyền
    // Với cơ chế cũ (dùng biến cờ boolean toàn cục), Tác vụ B sẽ lọt qua vì cờ đang là true!
    // Với cơ chế AsyncLocalStorage (SEC-05.2), Tác vụ B PHẢI BỊ CHẶN TUYỆT ĐỐI!
    taskBAttemptedDuringTaskA = true;
    expect(isLegacyMigrationLocked()).toBe(true); // Tác vụ B kiểm tra thấy khóa vẫn đóng

    // Cố gắng gọi restoreIndexedDbFromBackup từ Tác vụ B
    await expect(
      restoreIndexedDbFromBackup({
        ...sampleBackup,
        data: { classes: [], students: [], transactions: [] } as any,
      }),
    ).rejects.toThrow(/Cảnh báo an toàn \(SEC-05\): Thao tác "restoreIndexedDbFromBackup"/);

    // Cố gắng gọi saveIdMappings từ Tác vụ B
    await expect(
      saveIdMappings({
        classes: { 'malicious-cls': 'malicious-cloud' },
        criteria: {},
        students: {},
        attendance: {},
        transactions: {},
        batches: {},
        comments: {},
      }),
    ).rejects.toThrow(/Cảnh báo an toàn \(SEC-05\): Thao tác "saveIdMappings"/);

    // Cố gắng gọi executeMigration từ Tác vụ B
    await expect(executeMigration(sampleBackup)).rejects.toThrow(
      /Cảnh báo an toàn \(SEC-05\): Thao tác "executeMigration"/,
    );

    // Chờ Tác vụ A hoàn thành bình thường
    const resA = await taskAPromise;
    expect(resA).toBe('task_a_result');
    expect(taskBAttemptedDuringTaskA).toBe(true);
    expect(taskAFinished).toBe(true);

    // Sau khi Tác vụ A kết thúc, trạng thái vẫn tiếp tục bị khóa
    expect(isLegacyMigrationLocked()).toBe(true);
  });

  it('12. SEC-05.2: Nested Authorization — Gọi lồng nhau duy trì quyền chính xác và thu hồi hoàn toàn khi thoát ra ngoài', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async (ticketOuter) => {
      expect(isLegacyMigrationLocked()).toBe(false);
      expect(ticketOuter.id).toBeTruthy();

      // Gọi lồng nhau scope bên trong
      await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async (ticketInner) => {
        expect(isLegacyMigrationLocked()).toBe(false);
        expect(ticketInner.id).toBeTruthy();
        expect(ticketInner.id).not.toBe(ticketOuter.id); // Mỗi scope có ticket riêng
      });

      // Sau khi scope con hoàn thành, scope cha vẫn giữ nguyên quyền
      expect(isLegacyMigrationLocked()).toBe(false);
    });

    // Ra khỏi toàn bộ scope: quyền bị thu hồi hoàn toàn
    expect(isLegacyMigrationLocked()).toBe(true);
    await expect(restoreIndexedDbFromBackup(sampleBackup)).rejects.toThrow(/SEC-05/);
  });

  it('13. SEC-05.2: Truyền ticket không hợp lệ hoặc rỗng bị từ chối truy cập', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    const emptyTicket = { id: '', authorizedAt: Date.now() } as any;
    const invalidTicket = { somethingElse: true } as any;

    expect(isLegacyMigrationLocked(emptyTicket)).toBe(true);
    expect(isLegacyMigrationLocked(invalidTicket)).toBe(true);

    await expect(restoreIndexedDbFromBackup(sampleBackup, emptyTicket)).rejects.toThrow(/SEC-05/);
    await expect(restoreIndexedDbFromBackup(sampleBackup, invalidTicket)).rejects.toThrow(/SEC-05/);
  });

  it('14. SEC-05.3: Ticket giả mạo (có id nhưng không do hệ thống cấp/không có nonce) bị TỪ CHỐI TUYỆT ĐỐI', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    // Kẻ tấn công hoặc caller tự bịa ra một ticket có id chuỗi hợp lệ
    const forgedTicket = {
      id: 'ticket_forged_fake_12345',
      authorizedAt: Date.now(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      scope: 'testing' as const,
    } as any;

    expect(isLegacyMigrationLocked(forgedTicket)).toBe(true);

    // Thao tác restore hoặc saveIdMappings bằng ticket giả mạo phải bị ném lỗi SEC-05.3 ngay lập tức
    await expect(restoreIndexedDbFromBackup(sampleBackup, forgedTicket)).rejects.toThrow(
      /Cảnh báo an toàn \(SEC-05\.3\): Thao tác "restoreIndexedDbFromBackup" bị từ chối do ticket không hợp lệ \(Ticket giả mạo: Thiếu nonce bảo mật của hệ thống\.\)/,
    );
  });

  it('15. SEC-05.3: Ticket đã hết hạn (expired) bị TỪ CHỐI TRUY CẬP', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    // Cấp ticket với thời hạn cực ngắn: 10ms
    let expiredTicket!: LegacyMigrationAuthTicket;
    await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async (ticket) => {
        expiredTicket = ticket;
        // Đợi 25ms để ticket chắc chắn hết hạn
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(isLegacyMigrationLocked(expiredTicket)).toBe(true);
      },
      { lifetimeMs: 10 },
    );

    // Sau khi hết hạn, gọi thao tác với ticket này phải bị ném lỗi
    await expect(restoreIndexedDbFromBackup(sampleBackup, expiredTicket)).rejects.toThrow(
      /SEC-05\.3/,
    );
  });

  it('16. SEC-05.3: Ticket đã bị thu hồi trong finally, tái sử dụng ngoài scope bị TỪ CHỐI', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    let capturedTicket!: LegacyMigrationAuthTicket;

    // Trong scope: ticket hợp lệ
    await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async (ticket) => {
      capturedTicket = ticket;
      expect(isLegacyMigrationLocked(ticket)).toBe(false);
    });

    // Ra ngoài scope: ticket đã bị revokeMigrationTicket() xóa khỏi ActiveTicketRegistry
    expect(isLegacyMigrationLocked(capturedTicket)).toBe(true);

    await expect(restoreIndexedDbFromBackup(sampleBackup, capturedTicket)).rejects.toThrow(
      /Ticket không tồn tại trong hệ thống đăng ký hoặc đã bị thu hồi/,
    );
  });

  it('17. SEC-05.3: Ticket sai phạm vi (Wrong Scope) bị TỪ CHỐI', async () => {
    expect(isLegacyMigrationLocked()).toBe(true);

    // Tạo ticket với scope 'dry-run'
    await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async (ticket) => {
        expect(ticket.scope).toBe('dry-run');

        // Thao tác yêu cầu scope 'dry-run' hợp lệ:
        expect(isLegacyMigrationLocked(ticket, 'dry-run')).toBe(false);

        // Nhưng thao tác yêu cầu scope 'migration' bị từ chối!
        expect(isLegacyMigrationLocked(ticket, 'migration')).toBe(true);
      },
      { scope: 'dry-run' },
    );
  });

  it('18. SEC-05.4: registerMigrationTicket không bị export ra ngoài; caller bên ngoài không thể tự đăng ký ticket', async () => {
    // 1. Kiểm tra export của module migration: registerMigrationTicket và revokeMigrationTicket không tồn tại
    const migrationModule = await import('./migration');
    expect((migrationModule as any).registerMigrationTicket).toBeUndefined();
    expect((migrationModule as any).revokeMigrationTicket).toBeUndefined();

    // 2. Caller bên ngoài tự tạo object giả lập ticket với nonce symbol riêng
    const unauthorizedFakeTicket: LegacyMigrationAuthTicket = {
      id: 'unauthorized_ticket_attempt',
      nonce: Symbol('FakeNonceFromTest'),
      issuedAt: Date.now(),
      authorizedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      scope: 'testing',
    };

    // Bị từ chối vì không nằm trong ActiveTicketRegistry nội bộ
    expect(isLegacyMigrationLocked(unauthorizedFakeTicket)).toBe(true);
    await expect(restoreIndexedDbFromBackup(sampleBackup, unauthorizedFakeTicket)).rejects.toThrow(
      /Ticket không tồn tại trong hệ thống đăng ký hoặc đã bị thu hồi/,
    );

    // 3. Luồng cấp quyền chính thức qua withLegacyMigrationAuthorization với đúng token vẫn hoạt động hoàn hảo
    const validResult = await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async (ticket) => {
      expect(ticket.id).toMatch(/^ticket_/);
      expect(typeof ticket.nonce).toBe('symbol');
      expect(isLegacyMigrationLocked(ticket)).toBe(false);
      return 'authorized_success';
    });
    expect(validResult).toBe('authorized_success');
  });
});
