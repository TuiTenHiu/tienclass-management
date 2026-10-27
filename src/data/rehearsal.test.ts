import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ALL_TABLES } from './db';
import {
  buildMigrationPreview,
  createMigrationBackup,
  executeMigration,
  restoreIndexedDbFromBackup,
  verifyBackupRoundTrip,
} from './migration';
import { buildSyntheticRehearsalFixture } from './rehearsalFixture';

/* ============================================================================
 * Mock Supabase In-Memory phục vụ diễn tập di trú có kiểm soát (Bước 3.7)
 * ============================================================================ */

interface MockClassRow {
  id: string;
  name: string;
  school_year: string;
  teacher_id: string;
  subject?: string | null;
  note?: string | null;
  color?: string;
}

interface MockCriterionRow {
  id: string;
  class_id: string;
  name: string;
  points: number;
  type: 'reward' | 'penalty';
  icon: string;
  display_order: number;
  archived: boolean;
}

interface MockStudentRow {
  id: string;
  code: string;
  full_name: string;
  birth_date: string | null;
  gender: string | null;
  avatar: string;
  note: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  status: 'active' | 'archived';
}

interface MockMembershipRow {
  id: string;
  class_id: string;
  student_id: string;
  is_active: boolean;
}

interface MockAttendanceRow {
  id: string;
  class_id: string;
  student_id: string;
  date: string;
  session: 'morning' | 'afternoon';
  status: string;
  note?: string | null;
  recorded_by: string;
}

interface MockPointRow {
  id: string;
  class_id: string;
  student_id: string;
  criterion_id: string | null;
  criterion_name: string;
  delta: number;
  note?: string | null;
  actor_id: string;
  batch_id: string;
  undone: boolean;
  created_at: string;
  source_id?: string | null;
}

interface MockCommentRow {
  id: string;
  class_id: string;
  student_id: string;
  week_number?: number | null;
  school_year: string;
  date: string;
  content: string;
  status: 'draft' | 'sent';
  sent_at?: string | null;
  teacher_id?: string | null;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

const mockCloudDb = {
  classes: [] as MockClassRow[],
  criteria: [] as MockCriterionRow[],
  students: [] as MockStudentRow[],
  class_memberships: [] as MockMembershipRow[],
  attendance: [] as MockAttendanceRow[],
  student_points: [] as MockPointRow[],
  weekly_comments: [] as MockCommentRow[],
};

const currentAuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'gv_rehearsal@tienclass.local',
  role: 'teacher' as const,
  fullName: 'Cô Giáo Diễn Tập',
};

vi.mock('../lib/supabaseClient', () => {
  return {
    isSupabaseConfigured: true,
    supabase: {
      auth: {
        getSession: async () => {
          return {
            data: {
              session: {
                user: { id: currentAuthUser.id, email: currentAuthUser.email },
              },
            },
            error: null,
          };
        },
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'create_student_in_class') {
          const classId = args.p_class_id as string;
          const code = (args.p_code as string).toUpperCase();
          const fullName = args.p_full_name as string;
          const targetId = (args.p_id as string) || `student-${code.toLowerCase()}`;
          const isActive = args.p_is_active !== undefined ? Boolean(args.p_is_active) : true;
          const status = (args.p_status as string) || 'active';

          const existingStu = mockCloudDb.students.find((s) => s.code.toUpperCase() === code);
          if (existingStu) {
            if (args.p_id && existingStu.id !== args.p_id) {
              return { data: null, error: { message: `Mã học sinh ${code} đã thuộc về học sinh khác có ID khác.` } };
            }
            const existingMem = mockCloudDb.class_memberships.find(
              (m) => m.student_id === existingStu.id && m.class_id === classId,
            );
            if (existingMem) {
              existingMem.is_active = isActive;
              return { data: { ok: true, student_id: existingStu.id, already_exists: true }, error: null };
            }
            mockCloudDb.class_memberships.push({
              id: `mem-${existingStu.id}`,
              class_id: classId,
              student_id: existingStu.id,
              is_active: isActive,
            });
            return { data: { ok: true, student_id: existingStu.id, linked_existing: true }, error: null };
          }

          const newStu: MockStudentRow = {
            id: targetId,
            code,
            full_name: fullName,
            gender: (args.p_gender as string) || null,
            birth_date: (args.p_birth_date as string) || null,
            avatar: (args.p_avatar as string) || 'cat-pink',
            note: (args.p_note as string) || null,
            parent_name: (args.p_parent_name as string) || null,
            parent_phone: (args.p_parent_phone as string) || null,
            status: status as any,
          };
          mockCloudDb.students.push(newStu);
          mockCloudDb.class_memberships.push({
            id: `mem-${targetId}`,
            class_id: classId,
            student_id: targetId,
            is_active: isActive,
          });
          return { data: { ok: true, student_id: targetId, created_new: true }, error: null };
        }
        return { data: null, error: { message: `RPC ${name} not supported` } };
      },
      from: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        let orderField: string | null = null;
        let orderAsc = true;

        const builder: any = {
          select: () => builder,
          eq: (field: string, val: any) => {
            filters.push((r: any) => r[field] === val);
            return builder;
          },
          or: (clause: string) => {
            const parts = clause.split(',');
            const matchers = parts.map((p) => {
              const segs = p.trim().split('.');
              return (r: any) => segs[1] === 'eq' && String(r[segs[0]] || '') === String(segs[2] || '');
            });
            filters.push((r: any) => matchers.some((fn) => fn(r)));
            return builder;
          },
          in: (field: string, vals: any[]) => {
            const set = new Set(vals);
            filters.push((r: any) => set.has(r[field]));
            return builder;
          },
          order: (field: string, opts?: { ascending?: boolean }) => {
            orderField = field;
            orderAsc = opts?.ascending ?? true;
            return builder;
          },
          maybeSingle: async () => {
            const list = (mockCloudDb as any)[table] || [];
            const filtered = list.filter((r: any) => filters.every((fn) => fn(r)));
            return { data: filtered[0] || null, error: null };
          },
          then: (resolve: any) => {
            const list = (mockCloudDb as any)[table] || [];
            let filtered = list.filter((r: any) => filters.every((fn) => fn(r)));
            if (orderField) {
              filtered = [...filtered].sort((a: any, b: any) => {
                const av = a[orderField!];
                const bv = b[orderField!];
                return orderAsc ? (av > bv ? 1 : -1) : av < bv ? 1 : -1;
              });
            }
            resolve({ data: filtered, error: null });
          },
          insert: async (rows: any) => {
            const arr = Array.isArray(rows) ? rows : [rows];
            const list = (mockCloudDb as any)[table];
            if (!list) return { data: null, error: { message: `Table ${table} not found` } };

            if (table === 'student_points') {
              for (const r of arr) {
                if (list.some((x: any) => x.id === r.id)) {
                  return { data: null, error: { code: '23505', message: 'duplicate point id' } };
                }
                if (r.source_id && list.some((x: any) => x.source_id === r.source_id)) {
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint unique_student_points_source_id' } };
                }
              }
            }
            if (table === 'attendance') {
              for (const r of arr) {
                if (list.some((x: any) => x.class_id === r.class_id && x.student_id === r.student_id && x.date === r.date && x.session === r.session)) {
                  return { data: null, error: { code: '23505', message: 'duplicate attendance slot' } };
                }
              }
            }

            list.push(...arr);
            return { data: arr, error: null };
          },
        };

        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: currentAuthUser.id,
                    email: currentAuthUser.email,
                    full_name: currentAuthUser.fullName,
                    role: currentAuthUser.role,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }

        return builder;
      },
    },
  };
});

function resetCloudDb() {
  mockCloudDb.classes.length = 0;
  mockCloudDb.criteria.length = 0;
  mockCloudDb.students.length = 0;
  mockCloudDb.class_memberships.length = 0;
  mockCloudDb.attendance.length = 0;
  mockCloudDb.student_points.length = 0;
  mockCloudDb.weekly_comments.length = 0;
}

async function loadRehearsalFixtureIntoDexie() {
  for (const t of ALL_TABLES) await db.table(t).clear();

  const fixture = buildSyntheticRehearsalFixture();
  await db.classes.bulkPut(fixture.classes);
  await db.criteria.bulkPut(fixture.criteria);
  await db.students.bulkPut(fixture.students);
  await db.attendance.bulkPut(fixture.attendance);
  await db.transactions.bulkPut(fixture.transactions);
  await db.comments.bulkPut(fixture.comments);
  await db.parentLinks.bulkPut(fixture.parentLinks);
  await db.tasks.bulkPut(fixture.tasks);
  await db.activities.bulkPut(fixture.activities);
  await db.gamePicks.bulkPut(fixture.gamePicks);

  await db.kv.put({
    key: 'settings',
    value: { teacherName: 'Cô Giáo Diễn Tập', pinHash: 'HASH_TEST', pinSalt: 'SALT_TEST' },
  });
}

describe('TIENCLASS — BƯỚC 3.7: DIỄN TẬP DI TRÚ CÓ KIỂM SOÁT (REHEARSAL SUITE)', () => {
  beforeEach(async () => {
    resetCloudDb();
    await loadRehearsalFixtureIntoDexie();
  });

  it('Giai đoạn 1 & 2: Rà soát & Khởi tạo Fixture diễn tập cô lập không chứa dữ liệu thật', async () => {
    const classCount = await db.classes.count();
    const studentCount = await db.students.count();
    const criteriaCount = await db.criteria.count();
    const attendanceCount = await db.attendance.count();
    const txCount = await db.transactions.count();
    const cmtCount = await db.comments.count();

    expect(classCount).toBe(5);
    expect(studentCount).toBe(8); // 4 active, 2 archived, 2 duplicate
    expect(criteriaCount).toBe(6);
    expect(attendanceCount).toBe(6);
    expect(txCount).toBe(6);
    expect(cmtCount).toBe(4);

    // Xác nhận toàn bộ học sinh đều mang nhãn diễn tập, không có học sinh thật
    const students = await db.students.toArray();
    for (const s of students) {
      expect(s.code.toUpperCase().startsWith('HS-REH-')).toBe(true);
      expect(s.fullName.includes('Diễn Tập') || s.fullName.includes('Lưu Trữ') || s.fullName.includes('Trùng Mã')).toBe(true);
    }
  });

  it('Giai đoạn 3 — Bước 1: Sao lưu đầy đủ, tuần tự hóa và xác minh round-trip an toàn', async () => {
    const backup = await createMigrationBackup();
    expect(backup.format).toBe('pink-classroom-migration-backup');
    expect(backup.schemaVersion).toBe(1);
    expect(backup.counts.classes).toBe(5);
    expect(backup.counts.students).toBe(8);

    // Không chứa thông tin PIN hoặc token thô
    const backupStr = JSON.stringify(backup);
    expect(backupStr).not.toContain('HASH_TEST');
    expect(backupStr).not.toContain('SALT_TEST');
    expect(backupStr).not.toContain('SYNTHETIC_MOCK_TOKEN_ABC123456789');

    // Kiểm tra tính toàn vẹn round-trip
    const roundTrip = await verifyBackupRoundTrip(backup);
    expect(roundTrip.ok).toBe(true);
    expect(roundTrip.errors.length).toBe(0);
  });

  it('Giai đoạn 3 — Bước 2: Xem trước (Preview) phát hiện đúng các bản ghi hợp lệ và các xung đột cố tình tạo', async () => {
    const preview = await buildMigrationPreview();

    // Lớp: 2 hợp lệ, 2 trùng tên (Lớp 3A / 3a: needsUser), 1 không hợp lệ (c_reh_invalid: ineligible)
    expect(preview.groups.classes.create).toBe(2);
    expect(preview.groups.classes.needsUser + preview.groups.classes.ineligible).toBe(3);

    // Tiêu chí: 4 hợp lệ, 1 sai dấu điểm (ineligible), 1 mồ côi (ineligible)
    expect(preview.groups.criteria.create).toBe(4);
    expect(preview.groups.criteria.needsUser + preview.groups.criteria.ineligible).toBe(2);

    // Học sinh: 4 hợp lệ đang học + 2 hợp lệ lưu trữ = 6 hợp lệ; 2 trùng mã = 2 needsUser
    expect(preview.groups.students.create).toBe(6);
    expect(preview.groups.students.needsUser + preview.groups.students.ineligible).toBe(2);

    // Không di trú các bảng phụ trợ (tasks, activities, gamePicks, kv)
    expect(preview.localOnlyTables.some((t) => t.table === 'tasks')).toBe(true);
    expect(preview.localOnlyTables.some((t) => t.table === 'activities')).toBe(true);
  });

  it('Giai đoạn 3 — Bước 3 & 4: Thực thi diễn tập di trú & Đối soát độc lập (Giai đoạn D)', async () => {
    const backup = await createMigrationBackup();
    const report = await executeMigration(backup);

    // 1. Kiểm tra kết quả tạo bản ghi trên Cloud
    expect(report.groups.classes.created).toBe(2);
    expect(report.groups.criteria.created).toBe(4);
    expect(report.groups.students.created).toBe(6);
    expect(report.groups.memberships.created).toBe(6);

    // 2. Học sinh lưu trữ (archived) bảo toàn is_active = false trong class_memberships
    const archStuCodes = ['HS-REH-ARCH-01', 'HS-REH-ARCH-02'];
    for (const code of archStuCodes) {
      const cloudStu = mockCloudDb.students.find((s) => s.code === code);
      expect(cloudStu).toBeDefined();
      const cloudMem = mockCloudDb.class_memberships.find((m) => m.student_id === cloudStu!.id);
      expect(cloudMem).toBeDefined();
      expect(cloudMem!.is_active).toBe(false);
    }

    // 3. Học sinh đang học (active) có is_active = true
    const activeStu = mockCloudDb.students.find((s) => s.code === 'HS-REH-01');
    expect(activeStu).toBeDefined();
    const activeMem = mockCloudDb.class_memberships.find((m) => m.student_id === activeStu!.id);
    expect(activeMem).toBeDefined();
    expect(activeMem!.is_active).toBe(true);

    // 4. Nhận xét tuần: 2 sent được tạo thành công
    const sentComments = mockCloudDb.weekly_comments.filter((c) => c.status === 'sent');
    expect(sentComments.length).toBe(2);

    // 5. Đối soát khóa ngoại: toàn bộ bản ghi di trú hợp lệ không có bản ghi mồ côi
    expect(report.fkIntegrity.ok).toBe(true);
    expect(report.fkIntegrity.criteriaOrphans).toBe(0);
    expect(report.fkIntegrity.membershipsOrphans).toBe(0);
    expect(report.fkIntegrity.attendanceOrphans).toBe(0);
    expect(report.fkIntegrity.pointsOrphans).toBe(0);
    expect(report.fkIntegrity.commentsOrphans).toBe(0);

    // 6. Đối soát tổng điểm thi đua: tổng điểm nguồn của các giao dịch hợp lệ khớp tuyệt đối với Cloud
    expect(report.pointsReconciliation.matched).toBe(true);
    expect(report.pointsReconciliation.difference).toBe(0);
    // 4 giao dịch hợp lệ: +2 +5 -2 -5 = 0 delta
    expect(report.pointsReconciliation.cloudSumDelta).toBe(report.pointsReconciliation.localSumDelta);

    // 7. Bảo toàn dữ liệu IndexedDB gốc: băm SHA-256 nguyên vẹn
    expect(report.localPreservation.ok).toBe(true);
    expect(report.localPreservation.intact).toBe(true);

    // Do có các bản ghi cố tình tạo xung đột để test, hệ thống ghi nhận đúng danh sách xung đột mà không ghi đè
    expect(report.conflicts.length).toBeGreaterThan(0);
    expect(report.conflicts.some((c) => c.code === 'DUPLICATE_CODE_IN_SOURCE')).toBe(true);
    expect(report.conflicts.some((c) => c.code === 'DUPLICATE_CLASS_IN_SOURCE')).toBe(true);
  });

  it('Giai đoạn 3 — Bước 5: Thử dừng và chạy lại (Idempotent Resumption) bảo đảm không trùng bản ghi', async () => {
    const backup = await createMigrationBackup();

    // Chạy lần 1 hoàn tất
    const rep1 = await executeMigration(backup);
    expect(rep1.groups.classes.created).toBeGreaterThanOrEqual(2);
    const classesCount1 = mockCloudDb.classes.length;
    const studentsCount1 = mockCloudDb.students.length;
    const pointsCount1 = mockCloudDb.student_points.length;

    // Chạy lần 2 (khởi động lại quy trình di trú từ cùng bản sao lưu)
    const rep2 = await executeMigration(backup);

    // Toàn bộ các bản ghi đã di trú ở lần 1 được bỏ qua (skipped), không tạo thêm bản ghi trùng
    expect(mockCloudDb.classes.length).toBe(classesCount1);
    expect(mockCloudDb.students.length).toBe(studentsCount1);
    expect(mockCloudDb.student_points.length).toBe(pointsCount1);

    expect(rep2.groups.classes.skipped).toBeGreaterThanOrEqual(2);
    expect(rep2.groups.students.skipped).toBeGreaterThanOrEqual(6);
    expect(rep2.groups.transactions.skipped).toBeGreaterThanOrEqual(4);
  });

  it('Giai đoạn 3 — Bước 6: Kế hoạch khôi phục khi có sự cố (Plan B / Disaster Recovery)', async () => {
    // 1. Tạo bản sao lưu ban đầu của fixture
    const initialBackup = await createMigrationBackup();

    // 2. Cố tình làm xáo trộn / xóa một số bản ghi trong IndexedDB để mô phỏng sự cố ngoài ý muốn
    await db.students.delete('s_reh_active_1');
    await db.classes.delete('c_reh_1');
    await db.transactions.clear();

    expect(await db.students.count()).toBe(7);
    expect(await db.classes.count()).toBe(4);
    expect(await db.transactions.count()).toBe(0);

    // 3. Thực thi quy trình khôi phục: restoreIndexedDbFromBackup
    const restoreResult = await restoreIndexedDbFromBackup(initialBackup);
    expect(restoreResult.ok).toBe(true);

    // 4. Xác minh toàn bộ dữ liệu đã được phục hồi nguyên vẹn 100%
    expect(await db.students.count()).toBe(8);
    expect(await db.classes.count()).toBe(5);
    expect(await db.transactions.count()).toBe(6);

    const restoredStudent = await db.students.get('s_reh_active_1');
    expect(restoredStudent).toBeDefined();
    expect(restoredStudent!.fullName).toBe('Nguyễn Hoàng An (Diễn Tập)');

    const restoredClass = await db.classes.get('c_reh_1');
    expect(restoredClass).toBeDefined();
    expect(restoredClass!.name).toBe('Lớp 1A - Diễn Tập');

    // 5. Kiểm tra tính an toàn: Phục hồi từ bản sao lưu bị hỏng checksum hoặc thiếu bảng phải bị từ chối
    const tamperedBackup = { ...initialBackup, checksum: 'bad_checksum_hash' };
    const failTampered = await restoreIndexedDbFromBackup(tamperedBackup as any);
    expect(failTampered.ok).toBe(false);
    expect(failTampered.message).toContain('Checksum không khớp');

    const corruptData = { ...initialBackup.data };
    delete (corruptData as any).students;
    const missingTableBackup = { ...initialBackup, data: corruptData };
    const failMissing = await restoreIndexedDbFromBackup(missingTableBackup as any);
    expect(failMissing.ok).toBe(false);
    expect(failMissing.message).toContain('bị thiếu');
  });
});
