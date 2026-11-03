import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

import { db as legacyDb, ALL_TABLES } from './db';
import {
  validateLegacyFixtureSchema,
  executeDryRunSimulation,
  withLegacyMigrationAuthorization,
  LEGACY_MIGRATION_TEST_TOKEN,
  MigrationBackup,
  MIGRATION_BACKUP_FORMAT,
  MIGRATION_BACKUP_SCHEMA_VERSION,
} from './migration';
import { buildSyntheticRehearsalFixture } from './rehearsalFixture';

describe('TIENCLASS — GIAI ĐOẠN 2.1: Bộ khung Dry-Run An toàn & Kiểm tra Dữ liệu Giả lập', () => {
  let sampleFixtureBackup: MigrationBackup;

  beforeEach(async () => {
    // Đảm bảo database legacy hoàn toàn sạch
    for (const t of ALL_TABLES) {
      await legacyDb.table(t).clear();
    }

    const syntheticData = buildSyntheticRehearsalFixture();
    // Bổ sung 1 học sinh mồ côi có classId không tồn tại để kiểm tra khả năng phát hiện
    syntheticData.students.push({
      id: 's_reh_orphan_1',
      classId: 'c_non_existent_class',
      code: 'HS-REH-ORPHAN',
      fullName: 'Học Sinh Mồ Côi Lớp',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Bổ sung 1 nhận xét mồ côi
    syntheticData.comments.push({
      id: 'cmt_reh_orphan_1',
      classId: 'c_non_existent_class',
      studentId: 's_reh_active_1',
      date: '2026-10-26',
      session: 'morning',
      content: 'Nhận xét mồ côi',
      tags: [],
      createdAt: 1000,
      updatedAt: 1000,
    });

    sampleFixtureBackup = {
      format: MIGRATION_BACKUP_FORMAT,
      schemaVersion: MIGRATION_BACKUP_SCHEMA_VERSION,
      dexieVersion: 2,
      exportedAt: new Date().toISOString(),
      tables: ALL_TABLES.map((t) => t),
      counts: {
        classes: syntheticData.classes.length,
        students: syntheticData.students.length,
        criteria: syntheticData.criteria.length,
        attendance: syntheticData.attendance.length,
        transactions: syntheticData.transactions.length,
        comments: syntheticData.comments.length,
        parentLinks: syntheticData.parentLinks.length,
      },
      checksum: 'dry-run-fixture-checksum-sha256',
      redactions: [],
      data: syntheticData as unknown as Record<string, unknown[]>,
    };
  });

  it('1. Kiểm tra cấu trúc schema và phát hiện chính xác các bản ghi mồ côi (Orphaned Records)', () => {
    const report = validateLegacyFixtureSchema(sampleFixtureBackup.data);

    // Dữ liệu fixture diễn tập có cố tình chứa các bản ghi mồ côi và dị thường
    expect(report.orphanedRecords.totalOrphans).toBeGreaterThan(0);

    // Phát hiện học sinh mồ côi (tham chiếu class không tồn tại)
    expect(report.orphanedRecords.students.length).toBeGreaterThan(0);
    expect(report.orphanedRecords.students[0].reason).toContain('Học sinh tham chiếu tới lớp không tồn tại');

    // Phát hiện tiêu chí mồ côi
    expect(report.orphanedRecords.criteria.length).toBeGreaterThan(0);

    // Phát hiện giao dịch điểm mồ côi
    expect(report.orphanedRecords.transactions.length).toBeGreaterThan(0);

    // Phát hiện nhận xét mồ côi
    expect(report.orphanedRecords.comments.length).toBeGreaterThan(0);
  });

  it('2. Phát hiện chính xác trùng lặp tên lớp và trùng mã học sinh (Collisions)', () => {
    const report = validateLegacyFixtureSchema(sampleFixtureBackup.data);

    // Fixture có chứa lớp trùng tên: 'Lớp 3A - Diễn Tập' và 'Lớp 3a - Diễn Tập'
    expect(report.collisions.duplicateClasses.length).toBeGreaterThanOrEqual(1);
    expect(report.collisions.duplicateClasses[0].name.toLowerCase()).toBe('lớp 3a - diễn tập');

    // Fixture có chứa học sinh trùng mã: 'HS-REH-DUP' và 'hs-reh-dup'
    expect(report.collisions.duplicateStudentCodes.length).toBeGreaterThanOrEqual(1);
    expect(report.collisions.duplicateStudentCodes[0].code).toBe('HS-REH-DUP');
    expect(report.collisions.duplicateStudentCodes[0].ids.length).toBe(2);
  });

  it('3. Thực thi Dry-Run hoàn toàn trong bộ nhớ: Phân loại created, skipped, conflicts, orphans', async () => {
    // Trạng thái Cloud hiện có (giả lập)
    const existingCloudState = {
      classes: [
        { id: 'cloud-c-1', name: 'Lớp 1A - Diễn Tập', school_year: '2026-2027' },
      ],
      students: [
        { id: 'cloud-s-1', code: 'HS-REH-01', full_name: 'Nguyễn Hoàng An (Diễn Tập)' },
        // Học sinh trùng mã nhưng khác tên trên Cloud -> xung đột!
        { id: 'cloud-s-conflict', code: 'HS-REH-02', full_name: 'Trần Thị Bích Ngọc' },
      ],
      studentPoints: [
        // Giao dịch đã tồn tại trước với source_id trùng khớp
        { id: 'cloud-pt-1', source_id: 'tx_reh_01', delta: 2 },
        // Một giao dịch khác của giáo viên khác đã có sẵn trên Cloud (delta 10)
        { id: 'cloud-pt-other', source_id: 'tx_other_teacher_99', delta: 10 },
      ],
    };

    const dryRunResult = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async (ticket) => {
        return await executeDryRunSimulation(sampleFixtureBackup, {
          authorizationTicket: ticket,
          existingCloudState,
        });
      },
      { scope: 'dry-run' },
    );

    expect(dryRunResult.scope).toBe('dry-run');
    expect(dryRunResult.dryRunId).toMatch(/^dryrun_/);

    // Phân loại dự phóng Lớp học:
    // 'Lớp 1A' đã có -> skipped = 1
    expect(dryRunResult.projections.classes.skipped).toBe(1);
    expect(dryRunResult.projections.classes.created).toBeGreaterThanOrEqual(1);
    expect(dryRunResult.projections.classes.conflicts).toBeGreaterThanOrEqual(1); // Lớp không có tên

    // Phân loại dự phóng Học sinh:
    // HS-REH-01 trùng tên -> skipped >= 1
    expect(dryRunResult.projections.students.skipped).toBeGreaterThanOrEqual(1);
    // HS-REH-02 trùng mã nhưng khác tên -> conflict >= 1
    expect(dryRunResult.projections.students.conflicts).toBeGreaterThanOrEqual(1);

    // Phân loại giao dịch điểm:
    // 'tx_reh_1' đã có trên Cloud -> skipped >= 1
    expect(dryRunResult.projections.transactions.skipped).toBeGreaterThanOrEqual(1);
    expect(dryRunResult.projections.transactions.created).toBeGreaterThanOrEqual(1);

    // Tính toàn vẹn ghi nhận bản ghi mồ côi
    expect(dryRunResult.integrity.orphanedRecords.totalOrphans).toBeGreaterThan(0);
  });

  it('4. Đối soát điểm theo source_id: Không tự giả định tổng điểm Cloud bằng tổng điểm legacy', async () => {
    const existingCloudState = {
      classes: [],
      students: [],
      studentPoints: [
        // Cloud đã có sẵn 50 điểm từ các lớp/giáo viên khác
        { id: 'other-1', source_id: 'other-source-1', delta: 30 },
        { id: 'other-2', source_id: 'other-source-2', delta: 20 },
      ],
    };

    const dryRunResult = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async () => {
        return await executeDryRunSimulation(sampleFixtureBackup, { existingCloudState });
      },
    );

    const recon = dryRunResult.pointsReconciliation;

    // Tổng điểm của fixture legacy
    expect(recon.fixtureLegacyTotalPoints).toBeGreaterThan(0);

    // Tổng điểm Cloud hiện có độc lập (50 điểm)
    expect(recon.cloudExistingPoints).toBe(50);

    // Điểm đối soát khớp qua source_id = 0 (vì chưa có tx nào của fixture được đẩy)
    expect(recon.matchedBySourceIdPoints).toBe(0);

    // Dự phóng điểm mới bằng tổng fixture
    expect(recon.projectedNewPoints).toBe(recon.fixtureLegacyTotalPoints);

    // Điểm cuối cùng trên Cloud = 50 + tổng fixture
    expect(recon.projectedFinalCloudPoints).toBe(50 + recon.fixtureLegacyTotalPoints);

    // Ghi chú giải trình rõ ràng không có sự nhầm lẫn giữa hai tập dữ liệu
    expect(recon.discrepancyNote).toContain('độc lập với nhau');
    expect(recon.discrepancyNote).toContain('source_id');
  });

  it('5. Kiểm tra chạy lại sau gián đoạn và chống nhập trùng (Idempotent Resumption)', async () => {
    const dryRunResult = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async () => {
        return await executeDryRunSimulation(sampleFixtureBackup);
      },
    );

    // Tính lũy đẳng được kiểm chứng
    expect(dryRunResult.idempotentResumptionVerified).toBe(true);
  });

  it('6. Tuyệt đối KHÔNG thay đổi dữ liệu IndexedDB hay gọi lệnh ghi trong suốt quá trình Dry-Run', async () => {
    // Đếm số lượng bản ghi trong database legacy trước khi chạy
    const countsBefore: Record<string, number> = {};
    for (const t of ALL_TABLES) {
      countsBefore[t] = await legacyDb.table(t).count();
    }

    // Chạy Dry-Run
    await withLegacyMigrationAuthorization(LEGACY_MIGRATION_TEST_TOKEN, async () => {
      return await executeDryRunSimulation(sampleFixtureBackup);
    });

    // Đếm số lượng bản ghi sau khi chạy Dry-Run
    for (const t of ALL_TABLES) {
      const countAfter = await legacyDb.table(t).count();
      expect(countAfter).toBe(countsBefore[t]);
      expect(countAfter).toBe(0); // Vẫn hoàn toàn sạch 100%
    }
  });

  it('7. SEC-05.5: Phát hiện trùng mã học sinh nội bộ fixture và phân loại xung đột chính xác', async () => {
    // Kịch bản A & B: Hai học sinh có cùng mã (hoặc khác chữ hoa/thường, khoảng trắng) chưa có trên Cloud
    const fixtureWithInternalDuplicates: MigrationBackup = {
      ...sampleFixtureBackup,
      data: {
        classes: [
          { id: 'c_test_1', name: 'Lớp 1A', schoolYear: '2026-2027' },
        ],
        students: [
          // Bản ghi 1: mã mới
          { id: 's1', classId: 'c_test_1', code: '  hs-sec-01  ', fullName: 'Nguyễn Văn A' },
          // Bản ghi 2: trùng mã với bản ghi 1 sau khi trim và uppercase -> PHẢI LÀ CONFLICT
          { id: 's2', classId: 'c_test_1', code: 'HS-SEC-01', fullName: 'Trần Văn B' },
          // Bản ghi 3: một mã khác hoàn toàn mới
          { id: 's3', classId: 'c_test_1', code: 'HS-SEC-02', fullName: 'Lê Thị C' },
          // Bản ghi 4: trùng mã với bản ghi 3 -> PHẢI LÀ CONFLICT
          { id: 's4', classId: 'c_test_1', code: 'hs-sec-02', fullName: 'Lê Thị C' },
        ],
        criteria: [],
        attendance: [],
        transactions: [],
        comments: [],
        parentLinks: [],
      },
    };

    const resInternalDup = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async (ticket) => {
        return await executeDryRunSimulation(fixtureWithInternalDuplicates, {
          authorizationTicket: ticket,
        });
      },
      { scope: 'dry-run' },
    );

    // Có 4 học sinh:
    // - Bản ghi 1: created
    // - Bản ghi 2: trùng mã nội bộ -> conflict
    // - Bản ghi 3: created
    // - Bản ghi 4: trùng mã nội bộ -> conflict
    // Tổng created = 2, conflicts = 2, skipped = 0
    expect(resInternalDup.projections.students.created).toBe(2);
    expect(resInternalDup.projections.students.conflicts).toBe(2);
    expect(resInternalDup.projections.students.skipped).toBe(0);

    // Kịch bản C: Mã đã tồn tại trên Cloud (trùng tên -> skipped, khác tên -> conflict)
    const fixtureWithCloudMatch: MigrationBackup = {
      ...sampleFixtureBackup,
      data: {
        classes: [{ id: 'c_test_1', name: 'Lớp 1A', schoolYear: '2026-2027' }],
        students: [
          // Mã đã có trên Cloud, trùng họ tên -> skipped
          { id: 's_cloud_match', classId: 'c_test_1', code: 'HS-EXIST-01', fullName: 'Học Sinh Đã Có' },
          // Mã đã có trên Cloud, nhưng khác họ tên -> conflict
          { id: 's_cloud_conflict', classId: 'c_test_1', code: 'HS-EXIST-02', fullName: 'Tên Khác Hoàn Toàn' },
        ],
        criteria: [],
        attendance: [],
        transactions: [],
        comments: [],
        parentLinks: [],
      },
    };

    const existingCloudState = {
      classes: [],
      students: [
        { id: 'cloud-1', code: 'HS-EXIST-01', full_name: 'Học Sinh Đã Có' },
        { id: 'cloud-2', code: 'HS-EXIST-02', full_name: 'Tên Ban Đầu Trên Cloud' },
      ],
      studentPoints: [],
    };

    const resCloudMatch = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async () => {
        return await executeDryRunSimulation(fixtureWithCloudMatch, { existingCloudState });
      },
    );

    expect(resCloudMatch.projections.students.created).toBe(0);
    expect(resCloudMatch.projections.students.skipped).toBe(1);
    expect(resCloudMatch.projections.students.conflicts).toBe(1);

    // Kịch bản D: Fixture sạch, không có mã trùng
    const cleanFixture: MigrationBackup = {
      ...sampleFixtureBackup,
      data: {
        classes: [{ id: 'c_test_1', name: 'Lớp 1A', schoolYear: '2026-2027' }],
        students: [
          { id: 's1', classId: 'c_test_1', code: 'HS-CLEAN-01', fullName: 'Học Sinh 1' },
          { id: 's2', classId: 'c_test_1', code: 'HS-CLEAN-02', fullName: 'Học Sinh 2' },
          { id: 's3', classId: 'c_test_1', code: 'HS-CLEAN-03', fullName: 'Học Sinh 3' },
        ],
        criteria: [],
        attendance: [],
        transactions: [],
        comments: [],
        parentLinks: [],
      },
    };

    const resClean = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async () => {
        return await executeDryRunSimulation(cleanFixture);
      },
    );

    expect(resClean.projections.students.created).toBe(3);
    expect(resClean.projections.students.conflicts).toBe(0);
    expect(resClean.projections.students.skipped).toBe(0);

    // Kịch bản E: Chạy lại Dry-Run cho kết quả nhất quán tuyệt đối (idempotent)
    const resClean2 = await withLegacyMigrationAuthorization(
      LEGACY_MIGRATION_TEST_TOKEN,
      async () => {
        return await executeDryRunSimulation(cleanFixture);
      },
    );
    expect(resClean2.projections.students.created).toBe(resClean.projections.students.created);
    expect(resClean2.projections.students.conflicts).toBe(resClean.projections.students.conflicts);
    expect(resClean2.idempotentResumptionVerified).toBe(true);
  });
});
