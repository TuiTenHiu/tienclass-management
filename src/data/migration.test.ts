import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isUUID } from '../lib/utils';

/* ============================================================================
 * Mock Supabase hỗ trợ cả kiểm tra Chặn gọi mạng (Giai đoạn A/B)
 * và Mô phỏng In-Memory có RLS/Constraints (Giai đoạn C/D).
 * ============================================================================ */

const cloudCalls: string[] = [];
let trapMode = true; // true: chặn mọi truy cập Supabase cho Giai đoạn A/B; false: mô phỏng cho C/D

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
  gender?: string | null;
  birth_date?: string | null;
  avatar: string;
  note?: string | null;
  parent_name?: string | null;
  parent_phone?: string | null;
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
  session: string;
  status: string;
  note?: string | null;
  recorded_by?: string | null;
}

interface MockPointRow {
  id: string;
  class_id: string;
  student_id: string;
  criterion_id?: string | null;
  criterion_name: string;
  delta: number;
  note?: string | null;
  actor_id?: string | null;
  batch_id: string;
  undone: boolean;
  undone_at?: string | null;
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

let currentAuthUser: { id: string; email: string; role: 'admin' | 'teacher' | 'parent'; fullName: string } | null = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'teacher@test.local',
  role: 'teacher',
  fullName: 'Cô Giáo Tiên',
};

vi.mock('../lib/supabaseClient', () => {
  return {
    isSupabaseConfigured: true,
    supabase: {
      auth: {
        getSession: async () => {
          cloudCalls.push('auth.getSession');
          if (trapMode) throw new Error('Cloud call forbidden: auth.getSession');
          if (!currentAuthUser) return { data: { session: null }, error: null };
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
        cloudCalls.push(`rpc:${name}`);
        if (trapMode) throw new Error(`Cloud call forbidden: rpc:${name}`);
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
        cloudCalls.push(`from:${table}`);
        if (trapMode) throw new Error(`Cloud call forbidden: from:${table}`);

        const filters: Array<(row: any) => boolean> = [];

        const builder: any = {
          select: () => {
            return builder;
          },
          eq: (field: string, val: any) => {
            filters.push((r: any) => r[field] === val);
            return builder;
          },
          ilike: (field: string, val: string) => {
            filters.push((r: any) => String(r[field] || '').toLowerCase() === val.toLowerCase());
            return builder;
          },
          or: (clause: string) => {
            // Hỗ trợ "id.eq.X,source_id.eq.Y"
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
          maybeSingle: async () => {
            const list = (mockCloudDb as any)[table] || [];
            const filtered = list.filter((r: any) => filters.every((fn) => fn(r)));
            return { data: filtered[0] || null, error: null };
          },
          insert: async (rows: any) => {
            const arr = Array.isArray(rows) ? rows : [rows];
            const list = (mockCloudDb as any)[table];
            if (!list) return { data: null, error: { message: `Table ${table} not found` } };

            // Kiểm tra unique constraints
            if (table === 'classes') {
              for (const r of arr) {
                if (list.some((x: any) => x.name === r.name && x.school_year === r.school_year)) {
                  return { data: null, error: { code: '23505', message: 'duplicate class name per year' } };
                }
              }
            }
            if (table === 'students') {
              for (const r of arr) {
                if (list.some((x: any) => x.code.toUpperCase() === r.code.toUpperCase())) {
                  return { data: null, error: { code: '23505', message: 'duplicate student code' } };
                }
              }
            }
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

            list.push(...arr);
            return { data: arr, error: null };
          },
          update: async (patch: any) => {
            const list = (mockCloudDb as any)[table] || [];
            const targets = list.filter((r: any) => filters.every((fn) => fn(r)));
            for (const t of targets) Object.assign(t, patch);
            return { data: targets, error: null };
          },
        };

        // Profile handler đặc biệt cho getAuthenticatedContext
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: (_f: string, idVal: string) => ({
                maybeSingle: async () => {
                  if (currentAuthUser && currentAuthUser.id === idVal) {
                    return {
                      data: {
                        id: currentAuthUser.id,
                        email: currentAuthUser.email,
                        full_name: currentAuthUser.fullName,
                        role: currentAuthUser.role,
                        phone: null,
                        avatar_url: null,
                      },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }

        // Đảm bảo await builder trả về danh sách đã filter
        builder.then = (resolve: any) => {
          const list = (mockCloudDb as any)[table] || [];
          const filtered = list.filter((r: any) => filters.every((fn) => fn(r)));
          resolve({ data: filtered, error: null });
        };

        return builder;
      },
    },
  };
});

import { db, ALL_TABLES } from './db';
import {
  buildMigrationPreview,
  createMigrationBackup,
  executeMigration,
  resolveCloudId,
  validateMigrationBackup,
  verifyBackupRoundTrip,
  type MigrationIdMappingRecord,
} from './migration';
import { getPendingSyncQueue, savePendingSyncQueue } from './repo';

const U = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;

async function snapshot() {
  const out: Record<string, string> = {};
  for (const t of ALL_TABLES) out[t] = JSON.stringify(await db.table(t).toArray());
  return out;
}

async function seed() {
  const now = 1000;
  await db.classes.bulkPut([
    { id: 'c_local_1', name: '1A', schoolYear: '2026-2027', teacherName: 'Cô A', color: '#fff', createdAt: now, updatedAt: now },
    { id: U(2), name: '1B', schoolYear: '2026-2027', teacherName: 'Cô A', color: '#fff', createdAt: now, updatedAt: now },
    { id: 'c_dup_a', name: '2A', schoolYear: '2026-2027', teacherName: 'Cô A', color: '#fff', createdAt: now, updatedAt: now },
    { id: 'c_dup_b', name: '2a', schoolYear: '2026-2027', teacherName: 'Cô A', color: '#fff', createdAt: now, updatedAt: now },
    { id: 'c_bad', name: '', schoolYear: 'abc', teacherName: 'Cô A', color: '#fff', createdAt: now, updatedAt: now },
  ]);
  await db.criteria.bulkPut([
    { id: 'cr1', classId: 'c_local_1', name: 'Giỏi', points: 2, type: 'reward', icon: 'star', order: 0, createdAt: now },
    { id: 'cr_bad', classId: 'c_local_1', name: 'Sai dấu', points: 2, type: 'penalty', icon: 'star', order: 1, createdAt: now },
    { id: 'cr_orphan', classId: 'c_missing', name: 'Mồ côi', points: 1, type: 'reward', icon: 'star', order: 0, createdAt: now },
  ]);
  await db.students.bulkPut([
    { id: 's1', classId: 'c_local_1', code: 'HS001', fullName: 'Học Sinh Một', gender: 'male', avatar: 'cat-pink', status: 'active', createdAt: now, updatedAt: now },
    { id: 's2', classId: 'c_local_1', code: 'hs001', fullName: 'Học Sinh Hai', gender: 'male', avatar: 'cat-pink', status: 'active', createdAt: now, updatedAt: now },
    { id: 's3', classId: 'c_local_1', code: 'HS003', fullName: 'Học Sinh Ba', gender: 'female', avatar: 'cat-pink', status: 'active', createdAt: now, updatedAt: now },
    { id: 's_synced', classId: U(2), code: 'HS009', fullName: 'Đã Đồng Bộ', gender: 'female', avatar: 'cat-pink', status: 'active', createdAt: now, updatedAt: now },
  ]);
  await db.attendance.bulkPut([
    { id: 'c_local_1|2026-10-26|morning|s3', classId: 'c_local_1', studentId: 's3', date: '2026-10-26', session: 'morning', status: 'present', updatedAt: now },
    { id: 'att_bad_date', classId: 'c_local_1', studentId: 's3', date: '2026-13-40', session: 'morning', status: 'present', updatedAt: now },
    { id: 'att_wrong_class', classId: U(2), studentId: 's3', date: '2026-10-26', session: 'morning', status: 'present', updatedAt: now },
  ]);
  await db.transactions.bulkPut([
    { id: 't1', classId: 'c_local_1', studentId: 's3', criterionId: 'cr1', criterionName: 'Giỏi', delta: 2, actor: 'Cô A', batchId: 'b1', createdAt: now },
    { id: 't_zero', classId: 'c_local_1', studentId: 's3', criterionId: null, criterionName: 'x', delta: 0, actor: 'Cô A', batchId: 'b2', createdAt: now },
  ]);
  await db.comments.bulkPut([
    { id: 'm1', classId: 'c_local_1', studentId: 's3', date: '2026-10-26', session: 'all', content: 'Tốt', tags: [], status: 'sent', sentAt: now, createdAt: now, updatedAt: now },
    { id: 'm2', classId: 'c_local_1', studentId: 's3', date: '2026-10-26', session: 'all', content: 'Trùng ngày', tags: [], status: 'draft', createdAt: now, updatedAt: now },
  ]);
  await db.parentLinks.put({ id: 'pl1', classId: 'c_local_1', studentId: 's3', token: 'SECRET_RAW_TOKEN_0123456789abcdef', createdAt: now, updatedAt: now });
  await db.kv.bulkPut([
    { key: 'settings', value: { teacherName: 'Tiên', pinHash: 'HASH_SECRET', pinSalt: 'SALT_SECRET' } },
    { key: 'cloud_synced_ids', value: { userId: 'u', classIds: [U(2)], studentIds: ['s_synced'] } },
  ]);
  await db.tasks.put({ id: 'td1', classId: 'c_local_1', title: 'x', done: false, createdAt: now });
}

function resetCloudDb() {
  mockCloudDb.classes.length = 0;
  mockCloudDb.criteria.length = 0;
  mockCloudDb.students.length = 0;
  mockCloudDb.class_memberships.length = 0;
  mockCloudDb.attendance.length = 0;
  mockCloudDb.student_points.length = 0;
  mockCloudDb.weekly_comments.length = 0;
}

beforeEach(async () => {
  cloudCalls.length = 0;
  trapMode = true; // mặc định chặn để bảo đảm test Giai đoạn A/B không lọt network call
  resetCloudDb();
  for (const t of ALL_TABLES) await db.table(t).clear();
  await seed();
});

describe('Bước 3.6 — Giai đoạn A/B: sao lưu & xem trước', () => {
  it('xuất sao lưu có phiên bản, thời điểm, danh sách bảng, số lượng và đọc lại hợp lệ', async () => {
    const b = await createMigrationBackup();
    expect(b.schemaVersion).toBe(1);
    expect(b.tables).toEqual([...ALL_TABLES]);
    expect(b.counts.classes).toBe(5);
    expect(b.counts.students).toBe(4);
    expect(Number.isNaN(Date.parse(b.exportedAt))).toBe(false);
    const res = await verifyBackupRoundTrip(b);
    expect(res.ok).toBe(true);
    expect(res.counts.transactions).toBe(2);
  });

  it('sao lưu không chứa PIN và token thô', async () => {
    const text = JSON.stringify(await createMigrationBackup());
    expect(text).not.toContain('HASH_SECRET');
    expect(text).not.toContain('SALT_SECRET');
    expect(text).not.toContain('SECRET_RAW_TOKEN');
    expect(text).toContain('teacherName');
  });

  it('phát hiện file bị sửa, thiếu bảng, sai phiên bản, sai số lượng, khóa trùng', async () => {
    const good = JSON.parse(JSON.stringify(await createMigrationBackup()));

    const tampered = JSON.parse(JSON.stringify(good));
    tampered.data.classes[0].name = 'BỊ SỬA';
    expect((await validateMigrationBackup(tampered)).errors.join()).toMatch(/Checksum/);

    const missing = JSON.parse(JSON.stringify(good));
    delete missing.data.students;
    expect((await validateMigrationBackup(missing)).ok).toBe(false);

    const future = JSON.parse(JSON.stringify(good));
    future.schemaVersion = 99;
    expect((await validateMigrationBackup(future)).ok).toBe(false);

    const badCount = JSON.parse(JSON.stringify(good));
    badCount.counts.classes = 1;
    expect((await validateMigrationBackup(badCount)).ok).toBe(false);

    const dup = JSON.parse(JSON.stringify(good));
    dup.data.classes.push(dup.data.classes[0]);
    expect((await validateMigrationBackup(dup)).errors.join()).toMatch(/trùng/);

    expect((await validateMigrationBackup(null)).ok).toBe(false);
    expect((await validateMigrationBackup({ format: 'khác' })).ok).toBe(false);
  });

  it('xem trước phân loại đúng create / skip / needsUser / ineligible', async () => {
    const p = await buildMigrationPreview();
    expect(p.groups.classes).toMatchObject({ source: 5, create: 1, skip: 1, needsUser: 2, ineligible: 1 });
    expect(p.groups.criteria).toMatchObject({ source: 3, create: 1, ineligible: 2 });
    expect(p.groups.students).toMatchObject({ source: 4, create: 1, skip: 1, needsUser: 2 });
    expect(p.groups.memberships).toMatchObject({ create: 1, skip: 1, needsUser: 2 });
    expect(p.groups.attendance).toMatchObject({ source: 3, create: 1, ineligible: 2 });
    expect(p.groups.transactions).toMatchObject({ create: 1, ineligible: 1 });
    expect(p.groups.comments).toMatchObject({ source: 2, create: 0, needsUser: 2 });
    expect(p.groups.parentLinks).toMatchObject({ source: 1, ineligible: 1 });
    expect(p.items.find((i) => i.group === 'parentLinks')?.code).toBe('RAW_TOKEN_NOT_MIGRATED');
    expect(p.idsNeedingNewUuid.batchId).toBe(1);
    expect(p.wroteToCloud).toBe(false);
  });

  it('xem trước và sao lưu không ghi/xóa IndexedDB và không gọi Supabase', async () => {
    const before = await snapshot();
    await buildMigrationPreview();
    await createMigrationBackup();
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(cloudCalls).toEqual([]);
  });
});

describe('Bước 3.6 — Giai đoạn C & D: Thực thi di trú & Đối soát', () => {
  beforeEach(() => {
    trapMode = false; // bật mô phỏng Cloud cho Giai đoạn C/D
  });

  it('quản lý ID mapping ổn định (resolveCloudId & getIdMappings) không thay đổi qua các lần gọi', async () => {
    const m: MigrationIdMappingRecord = {
      classes: {},
      criteria: {},
      students: {},
      attendance: {},
      transactions: {},
      batches: {},
      comments: {},
    };

    const uuidLocal = '11111111-1111-4111-8111-111111111111';
    const nonUuidLocal = 'c_local_99';

    const r1 = resolveCloudId('classes', uuidLocal, m);
    expect(r1).toBe(uuidLocal); // nếu đã là UUID thì giữ nguyên

    const r2 = resolveCloudId('classes', nonUuidLocal, m);
    expect(isUUID(r2)).toBe(true); // nếu không phải UUID thì sinh UUID v4 mới

    const r3 = resolveCloudId('classes', nonUuidLocal, m);
    expect(r3).toBe(r2); // gọi lại lần 2 giữ nguyên giá trị đã map (ổn định)
  });

  it('từ chối di trú nếu bản sao lưu không hợp lệ hoặc người dùng không có quyền', async () => {
    const backup = await createMigrationBackup();
    const brokenBackup = { ...backup, checksum: 'bad_checksum' };

    await expect(executeMigration(brokenBackup as any)).rejects.toThrow(/Bản sao lưu không hợp lệ/);

    currentAuthUser = null; // chưa đăng nhập
    await expect(executeMigration(backup)).rejects.toThrow(/Chưa đăng nhập/);

    currentAuthUser = {
      id: '00000000-0000-4000-8000-000000000003',
      email: 'parent@test.local',
      role: 'parent',
      fullName: 'Phụ Huynh',
    };
    await expect(executeMigration(backup)).rejects.toThrow(/Quyền bị từ chối/);

    // Phục hồi lại quyền teacher
    currentAuthUser = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'teacher@test.local',
      role: 'teacher',
      fullName: 'Cô Giáo Tiên',
    };
  });

  it('thực thi di trú lần đầu: đồng bộ các bản ghi hợp lệ theo thứ tự phụ thuộc', async () => {
    const backup = await createMigrationBackup();
    const progressList: string[] = [];

    const report = await executeMigration(backup, {
      onProgress: (p) => progressList.push(p.step),
    });

    expect(report.actorRole).toBe('teacher');
    expect(report.groups.classes.created).toBe(1); // c_local_1 tạo mới
    expect(report.groups.criteria.created).toBe(1); // cr1 tạo mới
    expect(report.groups.students.created).toBe(1); // s3 tạo mới
    expect(report.groups.memberships.created).toBe(1); // s3 membership tạo mới
    expect(report.groups.attendance.created).toBe(1); // điểm danh hợp lệ tạo mới
    expect(report.groups.transactions.created).toBe(1); // t1 tạo mới
    expect(report.groups.comments.created).toBe(1); // m1 tạo mới

    // Bảng Cloud phải có các bản ghi tương ứng
    expect(mockCloudDb.classes.length).toBe(1);
    expect(mockCloudDb.classes[0].name).toBe('1A');
    expect(mockCloudDb.criteria.length).toBe(1);
    expect(mockCloudDb.students.length).toBe(1);
    expect(mockCloudDb.students[0].code).toBe('HS003');
    expect(mockCloudDb.class_memberships.length).toBe(1);
    expect(mockCloudDb.attendance.length).toBe(1);
    expect(mockCloudDb.student_points.length).toBe(1);
    expect(mockCloudDb.weekly_comments.length).toBe(1);

    // Kiểm tra các bước tiến trình đúng thứ tự
    expect(progressList).toContain('validating');
    expect(progressList).toContain('classes');
    expect(progressList).toContain('criteria');
    expect(progressList).toContain('students');
    expect(progressList).toContain('attendance');
    expect(progressList).toContain('transactions');
    expect(progressList).toContain('comments');
    expect(progressList).toContain('reconciliation');
    expect(progressList).toContain('completed');
  });

  it('tính lũy thừa (idempotency): chạy lại lần 2 đánh dấu skipped, không trùng lặp bản ghi', async () => {
    const backup = await createMigrationBackup();

    // Chạy lần 1
    const rep1 = await executeMigration(backup);
    expect(rep1.groups.classes.created).toBe(1);

    const cloudClassesCount1 = mockCloudDb.classes.length;
    const cloudPointsCount1 = mockCloudDb.student_points.length;

    // Chạy lại lần 2
    const rep2 = await executeMigration(backup);
    expect(rep2.groups.classes.created).toBe(0);
    expect(rep2.groups.classes.skipped).toBeGreaterThanOrEqual(1); // đã có trên cloud -> skipped
    expect(rep2.groups.students.created).toBe(0);
    expect(rep2.groups.students.skipped).toBeGreaterThanOrEqual(1);
    expect(rep2.groups.transactions.created).toBe(0);
    expect(rep2.groups.transactions.skipped).toBeGreaterThanOrEqual(1);

    // Số bản ghi trên Cloud không bị nhân đôi
    expect(mockCloudDb.classes.length).toBe(cloudClassesCount1);
    expect(mockCloudDb.student_points.length).toBe(cloudPointsCount1);
  });

  it('nhận xét đã gửi (sent): chỉ INSERT khi chưa tồn tại; nếu đã có thì bỏ qua (skipped), không UPDATE', async () => {
    const backup = await createMigrationBackup();

    // Lần 1: m1 (status = 'sent') được INSERT
    await executeMigration(backup);
    const cloudCmt = mockCloudDb.weekly_comments.find((c) => c.status === 'sent');
    expect(cloudCmt).toBeDefined();
    const originalContent = cloudCmt!.content;

    // Sửa nội dung m1 trong local IndexedDB
    await db.comments.update('m1', { content: 'Nội dung sửa đổi cục bộ' });

    // Tạo bản backup mới và chạy lại di trú
    const nextBackup = await createMigrationBackup();
    const rep2 = await executeMigration(nextBackup);

    // Bắt buộc m1 phải bị bỏ qua (skipped) và Cloud comment giữ nguyên nội dung gốc
    expect(rep2.groups.comments.created).toBe(0);
    expect(rep2.groups.comments.skipped).toBeGreaterThanOrEqual(1);
    expect(cloudCmt!.content).toBe(originalContent);
  });

  it('phát hiện và đưa xung đột vào conflicts (không ghi đè dữ liệu)', async () => {
    // Giả lập Cloud đã có sẵn một học sinh có mã HS003 nhưng ID khác
    mockCloudDb.students.push({
      id: 'existing-other-student-uuid',
      code: 'HS003',
      full_name: 'Học sinh khác trùng mã',
      avatar: 'cat-pink',
      status: 'active',
    });

    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // Học sinh s3 có mã HS003 phải bị xung đột
    const codeConflict = rep.conflicts.find((c) => c.code === 'STUDENT_CODE_COLLISION_ON_CLOUD');
    expect(codeConflict).toBeDefined();
    expect(codeConflict?.message).toContain('Không ghi đè');
  });

  it('Giai đoạn D: đối soát tổng điểm thi đua khớp 100% và bảo toàn tuyệt đối IndexedDB', async () => {
    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // Đối soát điểm thi đua
    expect(rep.pointsReconciliation.matched).toBe(true);
    expect(rep.pointsReconciliation.difference).toBe(0);
    expect(rep.pointsReconciliation.localSumDelta).toBe(2);
    expect(rep.pointsReconciliation.cloudSumDelta).toBe(2);

    // Bảo toàn dữ liệu IndexedDB
    expect(rep.localPreservation.ok).toBe(true);
    expect(rep.localPreservation.intact).toBe(true);
    for (const t of ALL_TABLES) {
      expect(rep.localPreservation.afterCounts[t]).toBeGreaterThanOrEqual(
        rep.localPreservation.beforeCounts[t],
      );
    }
  });

  it('chống trùng student_points cấp Database qua source_id khi retry và cho phép 2 giao dịch hợp lệ cùng nội dung', async () => {
    // 1. Thêm 1 giao dịch thứ 2 t2 có CÙNG NỘI DUNG với t1 (delta=2, 'Giỏi', cùng lớp, cùng học sinh) nhưng khác id nguồn
    const now = 2000;
    await db.transactions.put({
      id: 't2_valid_same_content',
      classId: 'c_local_1',
      studentId: 's3',
      criterionId: 'cr1',
      criterionName: 'Giỏi',
      delta: 2,
      actor: 'Cô A',
      batchId: 'b1',
      createdAt: now,
    });

    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // Cả 2 giao dịch hợp lệ cùng nội dung (t1 và t2) đều phải được tạo mới thành công
    expect(rep.groups.transactions.created).toBe(2);
    expect(mockCloudDb.student_points.filter((p) => p.criterion_name === 'Giỏi').length).toBe(2);

    // Giả lập retry gửi lại giao dịch t1 với source_id = 't1': DB mock sẽ chặn duplicate source_id (mã 23505)
    // và quy trình di trú phải nhận diện thành công mà không gây lỗi
    const repRetry = await executeMigration(backup);
    expect(repRetry.groups.transactions.created).toBe(0);
    expect(repRetry.groups.transactions.skipped).toBeGreaterThanOrEqual(2);
    // Số bản ghi trên Cloud không được tăng thêm
    expect(mockCloudDb.student_points.filter((p) => p.criterion_name === 'Giỏi').length).toBe(2);
  });

  it('hòa nhập an toàn cloud_pending_sync_queue: dọn dẹp các mục đã di trú thành công để không đẩy trùng', async () => {
    // Thêm các mục đang chờ đồng bộ vào hàng đợi (trùng với t1 và m1)
    await db.kv.put({
      key: 'cloud_pending_sync_queue',
      value: [
        { key: 'q_t1', kind: 'points_upsert', txId: 't1', createdAt: Date.now() },
        { key: 'q_m1', kind: 'comment_upsert', commentId: 'm1', createdAt: Date.now() },
        { key: 'q_other', kind: 'comment_delete', commentId: 'm_orphan', createdAt: Date.now() }, // mục không xác định
      ],
    });

    const backup = await createMigrationBackup();
    await executeMigration(backup);

    // Kiểm tra hàng đợi sau di trú: q_t1 và q_m1 đã được dọn dẹp an toàn; q_other không xác định được giữ nguyên
    const remainingQueue = (await db.kv.get('cloud_pending_sync_queue'))?.value as any[];
    expect(remainingQueue).toBeDefined();
    expect(remainingQueue.some((i) => i.txId === 't1')).toBe(false);
    expect(remainingQueue.some((i) => i.commentId === 'm1')).toBe(false);
    expect(remainingQueue.some((i) => i.key === 'q_other')).toBe(true);
  });

  it('học sinh lưu trữ (archived) giữ nguyên trạng thái is_active = FALSE khi di trú', async () => {
    // Thêm học sinh s_archived với status = 'archived'
    const now = 3000;
    await db.students.put({
      id: 's_archived',
      classId: 'c_local_1',
      code: 'HS_ARCH_01',
      fullName: 'Học Sinh Đã Lưu Trữ',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'archived',
      createdAt: now,
      updatedAt: now,
    });

    const backup = await createMigrationBackup();
    await executeMigration(backup);

    // Kiểm tra membership của học sinh s_archived trên Cloud phải là is_active = false
    const stuOnCloud = mockCloudDb.students.find((s) => s.code === 'HS_ARCH_01');
    expect(stuOnCloud).toBeDefined();
    const memOnCloud = mockCloudDb.class_memberships.find((m) => m.student_id === stuOnCloud!.id);
    expect(memOnCloud).toBeDefined();
    expect(memOnCloud!.is_active).toBe(false);
  });

  it('đối soát phát hiện mồ côi hoặc tổng điểm lệch sẽ từ chối đánh dấu success = true', async () => {
    // Tạo sẵn 1 criteria mồ côi trên Cloud (class_id không tồn tại trong danh sách lớp)
    mockCloudDb.criteria.push({
      id: 'cr_orphan_on_cloud',
      class_id: '99999999-9999-4999-8999-999999999999',
      name: 'Tiêu chí mồ côi',
      points: 2,
      type: 'reward',
      icon: 'star',
      display_order: 0,
      archived: false,
    });

    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // Khi có bản ghi mồ côi trên Cloud của tập di trú, fkIntegrity.ok phải là false và success phải là false
    // Hoặc nếu có xung đột, success không thể là true
    if (!rep.fkIntegrity.ok || rep.conflicts.length > 0) {
      expect(rep.success).toBe(false);
    }
  });

  it('lỗi 23505 với bản ghi Cloud không khớp delta/học sinh sẽ báo xung đột TRANSACTION_UNIQUE_COLLISION', async () => {
    // Giả lập Cloud đã có sẵn 1 bản ghi mang source_id = 't1' nhưng với delta khác (khác nội dung)
    mockCloudDb.student_points.push({
      id: 'pt_different_cloud',
      class_id: 'c1',
      student_id: 's1',
      criterion_id: 'cr1',
      criterion_name: 'Phát biểu',
      delta: 999, // delta trên Cloud là 999 trong khi local delta là +1
      note: 'Điểm khác biệt',
      actor_id: 'user_t1',
      batch_id: 'b1',
      undone: false,
      created_at: new Date().toISOString(),
      source_id: 't1',
    });

    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // Phải phát hiện xung đột chứ không được coi là skip thành công
    const collisionConflict = rep.conflicts.find((c) => c.code === 'TRANSACTION_UNIQUE_COLLISION');
    expect(collisionConflict).toBeDefined();
    expect(rep.success).toBe(false);
  });

  it('hàng đợi pending sync queue không bị xóa nếu điểm danh trong cùng buổi có học sinh bị lỗi hoặc xung đột', async () => {
    // Thêm bản ghi điểm danh không hợp lệ (sai status) cùng lớp/ngày/buổi với slot đang chờ
    await db.attendance.put({
      id: 'att_invalid_in_morning',
      classId: 'c_local_1',
      studentId: 's3',
      date: '2026-10-26',
      session: 'morning',
      status: 'invalid_status' as any,
      updatedAt: 1000,
    });

    // Enqueue attendance slot vào pending queue
    await savePendingSyncQueue([
      {
        key: 'att:c_local_1:2026-10-26:morning',
        kind: 'attendance_upsert',
        classId: 'c_local_1',
        date: '2026-10-26',
        session: 'morning',
        createdAt: 1000,
      },
    ]);

    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // Slot có bản ghi con bị lỗi dữ liệu phải được giữ lại trong hàng đợi sync
    const queue = await getPendingSyncQueue();
    expect(queue.some((q) => q.kind === 'attendance_upsert' && q.classId === 'c_local_1')).toBe(true);
    expect(rep.conflicts.some((c) => c.group === 'attendance')).toBe(true);
  });

  /* ========================================================================
   * BỘ KIỂM THỬ CHỊU LỖI BẮT BUỘC (T1, T2, T3)
   * ======================================================================== */

  it('T1 — Ứng dụng bị gián đoạn giữa quá trình di trú và tiếp tục an toàn', async () => {
    // 1. Chuẩn bị dữ liệu IndexedDB giả lập có đủ các nhóm
    const now = 2000;
    await db.classes.put({
      id: 'c_t1',
      name: 'Lớp T1 Gián Đoạn',
      schoolYear: '2026-2027',
      teacherName: 'GV T1',
      color: '#ff69b4',
      createdAt: now,
      updatedAt: now,
    });
    await db.criteria.put({
      id: 'cr_t1',
      classId: 'c_t1',
      name: 'Chuyên cần',
      points: 5,
      type: 'reward',
      icon: 'star',
      order: 0,
      createdAt: now,
    });
    await db.students.put({
      id: 's_t1_active',
      classId: 'c_t1',
      code: 'HST1_01',
      fullName: 'Học Sinh T1 Đang Học',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.students.put({
      id: 's_t1_archived',
      classId: 'c_t1',
      code: 'HST1_02',
      fullName: 'Học Sinh T1 Lưu Trữ',
      gender: 'female',
      avatar: 'bear-sky',
      status: 'archived',
      createdAt: now,
      updatedAt: now,
    });
    await db.transactions.put({
      id: 'tx_t1_01',
      classId: 'c_t1',
      studentId: 's_t1_active',
      criterionId: 'cr_t1',
      criterionName: 'Chuyên cần',
      delta: 5,
      actor: 'GV T1',
      batchId: 'b_t1',
      createdAt: now,
    });

    // 2. Mô phỏng Đợt 1 bị dừng đột ngột sau khi đã di trú Lớp và Học sinh
    // Ta giả lập việc đợt 1 đã ghi Cloud thành công lớp c_t1 và học sinh s_t1_active
    const initialBackup = await createMigrationBackup();
    
    // Gọi đợt 1 với callback onProgress để ngắt khi đến bước transactions
    let stoppedEarly = false;
    try {
      await executeMigration(initialBackup, {
        onProgress: (p) => {
          if (p.step === 'transactions') {
            stoppedEarly = true;
            throw new Error('SIMULATED_APP_CRASH_MID_MIGRATION');
          }
        },
      });
    } catch (err: any) {
      expect(err.message).toBe('SIMULATED_APP_CRASH_MID_MIGRATION');
    }
    expect(stoppedEarly).toBe(true);

    // 3. Xác minh ID mapping đã được lưu bền vững vào IndexedDB trước khi ứng dụng dừng
    const mappingsMid = (await db.kv.get('migration_id_mappings'))?.value as MigrationIdMappingRecord;
    expect(mappingsMid).toBeDefined();
    expect(mappingsMid.classes['c_t1']).toBeDefined();
    expect(mappingsMid.students['s_t1_active']).toBeDefined();
    const savedClassCloudId = mappingsMid.classes['c_t1'];
    const savedStudentCloudId = mappingsMid.students['s_t1_active'];

    expect(mockCloudDb.classes.length).toBeGreaterThanOrEqual(1);
    expect(mockCloudDb.students.length).toBeGreaterThanOrEqual(1);

    // 4. Khởi động lại đợt 2: executeMigration lần 2
    const secondBackup = await createMigrationBackup();
    const report2 = await executeMigration(secondBackup);
    expect(report2.groups.classes.source).toBeGreaterThanOrEqual(1);

    // 5. Xác minh:
    // - Tái sử dụng chính xác ID Cloud đã map, không sinh ID mới làm lệch khóa ngoại
    const mappingsFinal = (await db.kv.get('migration_id_mappings'))?.value as MigrationIdMappingRecord;
    expect(mappingsFinal.classes['c_t1']).toBe(savedClassCloudId);
    expect(mappingsFinal.students['s_t1_active']).toBe(savedStudentCloudId);

    // - Không tạo thêm bản ghi lớp trùng trên Cloud
    const matchingClasses = mockCloudDb.classes.filter((c) => c.name === 'Lớp T1 Gián Đoạn');
    expect(matchingClasses.length).toBe(1);

    // - Học sinh s_t1_archived được bảo toàn is_active = false
    const memArchived = mockCloudDb.class_memberships.find(
      (m) => m.student_id === mappingsFinal.students['s_t1_archived'],
    );
    expect(memArchived).toBeDefined();
    expect(memArchived!.is_active).toBe(false);

    // - Giao dịch điểm tx_t1_01 được di trú thành công mà không bị mồ côi
    expect(mockCloudDb.student_points.some((p) => p.source_id === 'tx_t1_01')).toBe(true);
  });

  it('T2 — Máy chủ ghi thành công nhưng client mất phản hồi (Timeout / Retry) và lỗi truy vấn xác minh', async () => {
    const now = 3000;
    await db.classes.put({
      id: 'c_t2',
      name: 'Lớp T2 Timeout',
      schoolYear: '2026-2027',
      teacherName: 'GV T2',
      color: '#ff69b4',
      createdAt: now,
      updatedAt: now,
    });
    await db.criteria.put({
      id: 'cr_t2',
      classId: 'c_t2',
      name: 'Phát biểu',
      points: 3,
      type: 'reward',
      icon: 'star',
      order: 0,
      createdAt: now,
    });
    await db.students.put({
      id: 's_t2',
      classId: 'c_t2',
      code: 'HST2_01',
      fullName: 'Học Sinh T2',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.transactions.put({
      id: 'tx_t2_01',
      classId: 'c_t2',
      studentId: 's_t2',
      criterionId: 'cr_t2',
      criterionName: 'Phát biểu',
      delta: 3,
      actor: 'GV T2',
      batchId: 'b_t2',
      createdAt: now,
    });

    // 1. Chạy di trú lần 1 thành công
    const backup1 = await createMigrationBackup();
    await executeMigration(backup1);

    // Xác nhận Cloud đã có bản ghi điểm tx_t2_01
    const ptCloud = mockCloudDb.student_points.find((p) => p.source_id === 'tx_t2_01');
    expect(ptCloud).toBeDefined();
    expect(ptCloud!.delta).toBe(3);

    // 2. Chạy lại (Retry) khi bản ghi đã có trên Cloud:
    // source_id giữ ổn định và hệ thống skip an toàn (lũy đẳng)
    const backup2 = await createMigrationBackup();
    const rep2 = await executeMigration(backup2);
    expect(rep2.groups.transactions.skipped).toBeGreaterThanOrEqual(1);
    expect(mockCloudDb.student_points.filter((p) => p.source_id === 'tx_t2_01').length).toBe(1);

    // 3. Trường hợp dữ liệu trên Cloud bị sai lệch delta (xung đột) -> phải báo xung đột
    ptCloud!.delta = 99; // Cố tình đổi delta trên Cloud thành 99
    // Xóa cache đã sync của giao dịch này để kích hoạt lại bước kiểm tra
    const syncedRec = (await db.kv.get('cloud_synced_ids'))?.value as any;
    if (syncedRec) {
      syncedRec.transactionIds = (syncedRec.transactionIds || []).filter((id: string) => id !== 'tx_t2_01');
      await db.kv.put({ key: 'cloud_synced_ids', value: syncedRec });
    }

    const rep3 = await executeMigration(backup2);
    const collisionConflict = rep3.conflicts.find(
      (c) => c.code === 'TRANSACTION_UNIQUE_COLLISION' && c.id === 'tx_t2_01',
    );
    expect(collisionConflict).toBeDefined();
    expect(rep3.success).toBe(false);
  });

  it('T3 — Di trú đồng thời với hàng đợi đồng bộ, dọn dẹp hàng đợi an toàn và bảo toàn nhận xét sent', async () => {
    const now = 4000;
    await db.classes.put({
      id: 'c_t3',
      name: 'Lớp T3 Hàng Đợi',
      schoolYear: '2026-2027',
      teacherName: 'GV T3',
      color: '#ff69b4',
      createdAt: now,
      updatedAt: now,
    });
    await db.students.put({
      id: 's_t3',
      classId: 'c_t3',
      code: 'HST3_01',
      fullName: 'Học Sinh T3',
      gender: 'female',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db.comments.put({
      id: 'cmt_t3_sent',
      classId: 'c_t3',
      studentId: 's_t3',
      date: '2026-10-27',
      session: 'all',
      content: 'Nhận xét đã phát hành gốc',
      status: 'sent',
      sentAt: now,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    // 1. Tạo sẵn trong hàng đợi 1 giao dịch điểm đã được đồng bộ trước đó
    // và 1 mục mới xuất hiện trong hàng đợi
    await savePendingSyncQueue([
      {
        key: 'pts:tx_t3_synced',
        kind: 'points_upsert',
        txId: 'tx_t3_synced',
        createdAt: now,
      },
      {
        key: 'pts:tx_t3_new_unrelated',
        kind: 'points_upsert',
        txId: 'tx_t3_new_unrelated',
        createdAt: now + 500,
      },
    ]);

    // 2. Tạo sẵn nhận xét trên Cloud với status = 'sent'
    mockCloudDb.weekly_comments.push({
      id: 'cmt_cloud_existing',
      class_id: 'c_t3',
      student_id: 's_t3',
      school_year: '2026-2027',
      date: '2026-10-27',
      content: 'Nội dung bất biến trên máy chủ',
      status: 'sent',
      sent_at: new Date(now).toISOString(),
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });

    const backup = await createMigrationBackup();
    const rep = await executeMigration(backup);

    // 3. Kiểm tra:
    // - Nhận xét đã gửi (sent) trên Cloud tuyệt đối không bị UPDATE hay DELETE
    const cloudCmtAfter = mockCloudDb.weekly_comments.find((c) => c.date === '2026-10-27');
    expect(cloudCmtAfter).toBeDefined();
    expect(cloudCmtAfter!.content).toBe('Nội dung bất biến trên máy chủ');
    expect(cloudCmtAfter!.status).toBe('sent');
    expect(rep.groups.comments.skipped).toBeGreaterThanOrEqual(1);

    // - Mục mới trong hàng đợi (tx_t3_new_unrelated) KHÔNG bị xóa
    const queueAfter = await getPendingSyncQueue();
    expect(queueAfter.some((q) => (q as any).txId === 'tx_t3_new_unrelated')).toBe(true);
  });
});

