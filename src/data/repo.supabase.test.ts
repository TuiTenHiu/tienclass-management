import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isUUID, sha256 } from '../lib/utils';

/* ============================================================================
 * Bộ mô phỏng Supabase In-Memory bám sát RLS, Trigger & RPC V3.2 (20261026000002 + 0003)
 * ============================================================================ */

interface MockProfileRow {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'teacher' | 'parent';
  phone?: string | null;
  avatar_url?: string | null;
}

interface MockClassRow {
  id: string;
  name: string;
  school_year: string;
  teacher_id: string;
  subject: string | null;
  note: string | null;
  color: string;
  created_at: string;
  updated_at: string;
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
  created_at: string;
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
  created_at: string;
  updated_at: string;
}

interface MockMembershipRow {
  id: string;
  class_id: string;
  student_id: string;
  joined_at: string;
  left_at: string | null;
  is_active: boolean;
  created_at: string;
}

interface MockAttendanceRow {
  id: string;
  class_id: string;
  student_id: string;
  date: string;
  session: 'morning' | 'afternoon' | 'all';
  status: 'present' | 'late' | 'excused' | 'unexcused';
  note: string | null;
  recorded_by: string | null;
  updated_at: string;
}

interface MockStudentPointRow {
  id: string;
  class_id: string;
  student_id: string;
  criterion_id: string | null;
  criterion_name: string;
  delta: number;
  note: string | null;
  actor_id: string | null;
  batch_id: string;
  undone: boolean;
  undone_at: string | null;
  created_at: string;
}

interface MockWeeklyCommentRow {
  id: string;
  class_id: string;
  student_id: string;
  week_number: number | null;
  school_year: string;
  date: string;
  content: string;
  status: 'draft' | 'sent';
  sent_at: string | null;
  teacher_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface MockInvitationTokenRow {
  id: string;
  class_id: string;
  student_id: string;
  token_hash: string;
  parent_phone: string | null;
  expires_at: string;
  is_revoked: boolean;
  revoked_at: string | null;
  used_at: string | null;
  used_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface MockParentStudentRow {
  id: string;
  parent_id: string;
  student_id: string;
  relationship: string;
  is_verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
}

const TEACHER_A_ID = '11111111-1111-4111-8111-111111111111';
const TEACHER_B_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';
const PARENT_2_ID = '44444444-4444-4444-8444-444444444444';

const mockState = {
  currentUserId: null as string | null,
  networkOffline: false,
  profiles: new Map<string, MockProfileRow>(),
  classes: new Map<string, MockClassRow>(),
  criteria: new Map<string, MockCriterionRow>(),
  students: new Map<string, MockStudentRow>(),
  memberships: new Map<string, MockMembershipRow>(),
  attendance: new Map<string, MockAttendanceRow>(),
  studentPoints: new Map<string, MockStudentPointRow>(),
  weeklyComments: new Map<string, MockWeeklyCommentRow>(),
  parentInvitationTokens: new Map<string, MockInvitationTokenRow>(),
  parentStudents: new Map<string, MockParentStudentRow>(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
};

function resetMockCloud() {
  mockState.currentUserId = null;
  mockState.networkOffline = false;
  mockState.classes.clear();
  mockState.criteria.clear();
  mockState.students.clear();
  mockState.memberships.clear();
  mockState.attendance.clear();
  mockState.studentPoints.clear();
  mockState.weeklyComments.clear();
  mockState.parentInvitationTokens.clear();
  mockState.parentStudents.clear();
  mockState.rpcCalls = [];

  mockState.profiles.clear();
  mockState.profiles.set(TEACHER_A_ID, {
    id: TEACHER_A_ID,
    email: 'teacher.a@tienclass.local',
    full_name: 'Cô Tiên A',
    role: 'teacher',
  });
  mockState.profiles.set(TEACHER_B_ID, {
    id: TEACHER_B_ID,
    email: 'teacher.b@tienclass.local',
    full_name: 'Thầy Nam B',
    role: 'teacher',
  });
  mockState.profiles.set(PARENT_ID, {
    id: PARENT_ID,
    email: 'parent@tienclass.local',
    full_name: 'Phụ huynh C',
    role: 'parent',
  });
  mockState.profiles.set(PARENT_2_ID, {
    id: PARENT_2_ID,
    email: 'parent2@tienclass.local',
    full_name: 'Phụ huynh D',
    role: 'parent',
  });
}

function isClassTeacher(classId: string, uid: string | null): boolean {
  if (!uid) return false;
  const cls = mockState.classes.get(classId);
  const prof = mockState.profiles.get(uid);
  return Boolean(cls && prof && (prof.role === 'admin' || (prof.role === 'teacher' && cls.teacher_id === uid)));
}

function isVerifiedParent(studentId: string, uid: string | null): boolean {
  if (!uid) return false;
  for (const ps of mockState.parentStudents.values()) {
    if (ps.student_id === studentId && ps.parent_id === uid && ps.is_verified) {
      return true;
    }
  }
  return false;
}

function isVerifiedParentInClass(classId: string, uid: string | null): boolean {
  if (!uid) return false;
  for (const m of mockState.memberships.values()) {
    if (m.class_id === classId && m.is_active && isVerifiedParent(m.student_id, uid)) {
      return true;
    }
  }
  return false;
}

function isStudentInClass(studentId: string, classId: string, uid: string | null): boolean {
  if (!isClassTeacher(classId, uid) && !isVerifiedParent(studentId, uid)) return false;
  for (const m of mockState.memberships.values()) {
    if (m.class_id === classId && m.student_id === studentId && m.is_active) {
      return true;
    }
  }
  return false;
}

function isTeacherOfStudent(studentId: string, uid: string | null): boolean {
  if (!uid) return false;
  const prof = mockState.profiles.get(uid);
  if (prof?.role === 'admin') return true;
  for (const m of mockState.memberships.values()) {
    if (m.student_id === studentId && m.is_active) {
      const cls = mockState.classes.get(m.class_id);
      if (cls && cls.teacher_id === uid) return true;
    }
  }
  return false;
}

function canTeacherLinkStudent(studentId: string, classId: string, uid: string | null): boolean {
  if (!isClassTeacher(classId, uid)) return false;
  if (!mockState.students.has(studentId)) return false;
  for (const m of mockState.memberships.values()) {
    if (m.student_id === studentId) {
      const cls = mockState.classes.get(m.class_id);
      if (cls && cls.teacher_id !== uid) return false;
    }
  }
  return true;
}

let seqCounter = 1;
function nextMockUuid(): string {
  const hex = (seqCounter++).toString(16).padStart(12, '0');
  return `99999999-9999-4999-8999-${hex}`;
}

vi.mock('../lib/supabaseClient', () => {
  const createQueryBuilder = (table: string) => {
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: unknown = null;
    let headCount = false;
    const eqFilters: Array<[string, unknown]> = [];
    const neqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];

    const matchesFilters = (row: Record<string, unknown>) => {
      for (const [k, v] of eqFilters) {
        if (row[k] !== v) return false;
      }
      for (const [k, v] of neqFilters) {
        if (row[k] === v) return false;
      }
      for (const [k, arr] of inFilters) {
        if (!arr.includes(row[k])) return false;
      }
      return true;
    };

    const execute = async (): Promise<{
      data: unknown;
      error: { message: string; code?: string } | null;
      count?: number;
    }> => {
      const uid = mockState.currentUserId;
      const prof = uid ? mockState.profiles.get(uid) : null;

      // Mô phỏng mất kết nối mạng đối với các bảng nghiệp vụ khi cờ networkOffline = true
      if (mockState.networkOffline && table !== 'profiles') {
        return {
          data: null,
          error: { message: 'Failed to fetch: NetworkError when attempting to fetch resource.', code: 'NETWORK_ERROR' },
        };
      }

      if (table === 'profiles') {
        if (op === 'select') {
          const rows = Array.from(mockState.profiles.values()).filter(
            (r) => (r.id === uid || prof?.role === 'admin') && matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
      }

      if (table === 'classes') {
        if (op === 'select') {
          const rows = Array.from(mockState.classes.values()).filter(
            (r) =>
              (r.teacher_id === uid || prof?.role === 'admin' || isVerifiedParentInClass(r.id, uid)) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'insert') {
          if (!uid || (prof?.role !== 'teacher' && prof?.role !== 'admin')) {
            return { data: null, error: { message: 'new row violates row-level security policy for table "classes"' } };
          }
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted: MockClassRow[] = [];
          for (const raw of items as Partial<MockClassRow>[]) {
            if (raw.teacher_id !== uid && prof?.role !== 'admin') {
              return {
                data: null,
                error: { message: 'new row violates row-level security policy for table "classes"' },
              };
            }
            for (const existing of mockState.classes.values()) {
              if (existing.name === raw.name && existing.school_year === raw.school_year) {
                return {
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                };
              }
            }
            const nowIso = new Date().toISOString();
            const row: MockClassRow = {
              id: raw.id || nextMockUuid(),
              name: raw.name!,
              school_year: raw.school_year!,
              teacher_id: raw.teacher_id!,
              subject: raw.subject ?? null,
              note: raw.note ?? null,
              color: raw.color || '#F7A8C4',
              created_at: nowIso,
              updated_at: nowIso,
            };
            mockState.classes.set(row.id, row);
            inserted.push(row);
          }
          return { data: inserted, error: null };
        }
        if (op === 'update') {
          const updated: MockClassRow[] = [];
          for (const row of mockState.classes.values()) {
            if (isClassTeacher(row.id, uid) && matchesFilters(row as unknown as Record<string, unknown>)) {
              const next = { ...row, ...(payload as Partial<MockClassRow>) };
              mockState.classes.set(row.id, next);
              updated.push(next);
            }
          }
          return { data: updated, error: null };
        }
        if (op === 'delete') {
          const deleted: MockClassRow[] = [];
          for (const row of Array.from(mockState.classes.values())) {
            if (isClassTeacher(row.id, uid) && matchesFilters(row as unknown as Record<string, unknown>)) {
              mockState.classes.delete(row.id);
              for (const [cid, cr] of Array.from(mockState.criteria.entries())) {
                if (cr.class_id === row.id) mockState.criteria.delete(cid);
              }
              for (const [mid, m] of Array.from(mockState.memberships.entries())) {
                if (m.class_id === row.id) mockState.memberships.delete(mid);
              }
              for (const [aid, a] of Array.from(mockState.attendance.entries())) {
                if (a.class_id === row.id) mockState.attendance.delete(aid);
              }
              for (const [pid, p] of Array.from(mockState.studentPoints.entries())) {
                if (p.class_id === row.id) mockState.studentPoints.delete(pid);
              }
              for (const [cmid, cm] of Array.from(mockState.weeklyComments.entries())) {
                if (cm.class_id === row.id) mockState.weeklyComments.delete(cmid);
              }
              deleted.push(row);
            }
          }
          return { data: deleted, error: null };
        }
      }

      if (table === 'criteria') {
        if (op === 'select') {
          const rows = Array.from(mockState.criteria.values()).filter(
            (r) => isClassTeacher(r.class_id, uid) && matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'insert') {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted: MockCriterionRow[] = [];
          for (const raw of items as Partial<MockCriterionRow>[]) {
            if (!isClassTeacher(raw.class_id!, uid)) {
              return {
                data: null,
                error: { message: 'new row violates row-level security policy for table "criteria"' },
              };
            }
            const row: MockCriterionRow = {
              id: raw.id || nextMockUuid(),
              class_id: raw.class_id!,
              name: raw.name!,
              points: Number(raw.points),
              type: raw.type!,
              icon: raw.icon || 'star',
              display_order: Number(raw.display_order ?? 0),
              archived: Boolean(raw.archived),
              created_at: new Date().toISOString(),
            };
            mockState.criteria.set(row.id, row);
            inserted.push(row);
          }
          return { data: inserted, error: null };
        }
        if (op === 'update') {
          const updated: MockCriterionRow[] = [];
          for (const row of mockState.criteria.values()) {
            if (isClassTeacher(row.class_id, uid) && matchesFilters(row as unknown as Record<string, unknown>)) {
              const next = { ...row, ...(payload as Partial<MockCriterionRow>) };
              mockState.criteria.set(row.id, next);
              updated.push(next);
            }
          }
          return { data: updated, error: null };
        }
        if (op === 'delete') {
          const deleted: MockCriterionRow[] = [];
          for (const row of Array.from(mockState.criteria.values())) {
            if (isClassTeacher(row.class_id, uid) && matchesFilters(row as unknown as Record<string, unknown>)) {
              mockState.criteria.delete(row.id);
              deleted.push(row);
            }
          }
          return { data: deleted, error: null };
        }
      }

      if (table === 'students') {
        if (op === 'select') {
          const rows = Array.from(mockState.students.values()).filter(
            (r) =>
              (isTeacherOfStudent(r.id, uid) || isVerifiedParent(r.id, uid)) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'update') {
          const updated: MockStudentRow[] = [];
          for (const row of mockState.students.values()) {
            if (isTeacherOfStudent(row.id, uid) && matchesFilters(row as unknown as Record<string, unknown>)) {
              const next = { ...row, ...(payload as Partial<MockStudentRow>) };
              mockState.students.set(row.id, next);
              updated.push(next);
            }
          }
          return { data: updated, error: null };
        }
        if (op === 'delete') {
          const deleted: MockStudentRow[] = [];
          for (const row of Array.from(mockState.students.values())) {
            if (isTeacherOfStudent(row.id, uid) && matchesFilters(row as unknown as Record<string, unknown>)) {
              mockState.students.delete(row.id);
              for (const [mid, m] of Array.from(mockState.memberships.entries())) {
                if (m.student_id === row.id) mockState.memberships.delete(mid);
              }
              deleted.push(row);
            }
          }
          return { data: deleted, error: null };
        }
      }

      if (table === 'class_memberships') {
        if (op === 'select') {
          const rows = Array.from(mockState.memberships.values()).filter(
            (r) =>
              ((isClassTeacher(r.class_id, uid) && canTeacherLinkStudent(r.student_id, r.class_id, uid)) ||
                isVerifiedParent(r.student_id, uid)) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'upsert') {
          const items = Array.isArray(payload) ? payload : [payload];
          const upserted: MockMembershipRow[] = [];
          for (const raw of items as Partial<MockMembershipRow>[]) {
            if (!canTeacherLinkStudent(raw.student_id!, raw.class_id!, uid)) {
              return {
                data: null,
                error: { message: 'new row violates row-level security policy for table "class_memberships"' },
              };
            }
            let existing: MockMembershipRow | undefined;
            for (const m of mockState.memberships.values()) {
              if (m.student_id === raw.student_id && m.class_id === raw.class_id) {
                existing = m;
                break;
              }
            }
            if (existing) {
              const updated: MockMembershipRow = {
                ...existing,
                is_active: Boolean(raw.is_active ?? true),
                left_at: raw.left_at ?? null,
              };
              mockState.memberships.set(existing.id, updated);
              upserted.push(updated);
            } else {
              const created: MockMembershipRow = {
                id: nextMockUuid(),
                class_id: raw.class_id!,
                student_id: raw.student_id!,
                joined_at: raw.joined_at || '2026-10-26',
                left_at: raw.left_at ?? null,
                is_active: Boolean(raw.is_active ?? true),
                created_at: new Date().toISOString(),
              };
              mockState.memberships.set(created.id, created);
              upserted.push(created);
            }
          }
          return { data: upserted, error: null };
        }
        if (op === 'update') {
          const updated: MockMembershipRow[] = [];
          for (const row of mockState.memberships.values()) {
            if (
              isClassTeacher(row.class_id, uid) &&
              canTeacherLinkStudent(row.student_id, row.class_id, uid) &&
              matchesFilters(row as unknown as Record<string, unknown>)
            ) {
              const next = { ...row, ...(payload as Partial<MockMembershipRow>) };
              mockState.memberships.set(row.id, next);
              updated.push(next);
            }
          }
          return { data: updated, error: null };
        }
      }

      if (table === 'attendance') {
        if (op === 'select') {
          const rows = Array.from(mockState.attendance.values()).filter(
            (r) =>
              ((isClassTeacher(r.class_id, uid) && isStudentInClass(r.student_id, r.class_id, uid)) ||
                isVerifiedParent(r.student_id, uid)) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'upsert') {
          const items = Array.isArray(payload) ? payload : [payload];
          const upserted: MockAttendanceRow[] = [];
          for (const raw of items as Partial<MockAttendanceRow>[]) {
            if (!isUUID(raw.class_id) || !isUUID(raw.student_id)) {
              return { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } };
            }
            if (!isClassTeacher(raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp này để điểm danh.',
                },
              };
            }
            if (!isStudentInClass(raw.student_id!, raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: 'Ràng buộc điểm danh thất bại: Học sinh không thuộc lớp học này.',
                },
              };
            }
            let existing: MockAttendanceRow | undefined;
            for (const a of mockState.attendance.values()) {
              if (
                a.class_id === raw.class_id &&
                a.student_id === raw.student_id &&
                a.date === raw.date &&
                a.session === raw.session
              ) {
                existing = a;
                break;
              }
            }
            if (existing) {
              const updated: MockAttendanceRow = {
                ...existing,
                status: raw.status || 'present',
                note: raw.note ?? null,
                recorded_by: uid ?? raw.recorded_by ?? null,
                updated_at: new Date().toISOString(),
              };
              mockState.attendance.set(existing.id, updated);
              upserted.push(updated);
            } else {
              const created: MockAttendanceRow = {
                id: raw.id && isUUID(raw.id) ? raw.id : nextMockUuid(),
                class_id: raw.class_id!,
                student_id: raw.student_id!,
                date: raw.date!,
                session: raw.session || 'morning',
                status: raw.status || 'present',
                note: raw.note ?? null,
                recorded_by: uid ?? raw.recorded_by ?? null,
                updated_at: new Date().toISOString(),
              };
              mockState.attendance.set(created.id, created);
              upserted.push(created);
            }
          }
          return { data: upserted, error: null };
        }
        if (op === 'delete') {
          const deleted: MockAttendanceRow[] = [];
          for (const row of Array.from(mockState.attendance.values())) {
            if (
              isClassTeacher(row.class_id, uid) &&
              isStudentInClass(row.student_id, row.class_id, uid) &&
              matchesFilters(row as unknown as Record<string, unknown>)
            ) {
              mockState.attendance.delete(row.id);
              deleted.push(row);
            }
          }
          return { data: deleted, error: null };
        }
      }

      if (table === 'student_points') {
        if (headCount) {
          const matched = Array.from(mockState.studentPoints.values()).filter((r) =>
            matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: null, error: null, count: matched.length };
        }
        if (op === 'select') {
          const rows = Array.from(mockState.studentPoints.values()).filter(
            (r) =>
              ((isClassTeacher(r.class_id, uid) && isStudentInClass(r.student_id, r.class_id, uid)) ||
                isVerifiedParent(r.student_id, uid)) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'upsert' || op === 'insert') {
          const items = Array.isArray(payload) ? payload : [payload];
          const upserted: MockStudentPointRow[] = [];
          for (const raw of items as Partial<MockStudentPointRow>[]) {
            if (!isUUID(raw.id) || !isUUID(raw.class_id) || !isUUID(raw.student_id) || !isUUID(raw.batch_id)) {
              return { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } };
            }
            if (!isClassTeacher(raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp này để chấm điểm.',
                },
              };
            }
            if (!isStudentInClass(raw.student_id!, raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: 'Ràng buộc điểm thất bại: Học sinh không thuộc lớp học được chấm điểm.',
                },
              };
            }
            if (raw.criterion_id) {
              const crit = mockState.criteria.get(raw.criterion_id);
              if (!crit || crit.class_id !== raw.class_id) {
                return {
                  data: null,
                  error: {
                    code: 'P0001',
                    message: 'Tiêu chí thi đua được chọn không thuộc lớp học này.',
                  },
                };
              }
            }
            const row: MockStudentPointRow = {
              id: raw.id!,
              class_id: raw.class_id!,
              student_id: raw.student_id!,
              criterion_id: raw.criterion_id ?? null,
              criterion_name: raw.criterion_name!,
              delta: Number(raw.delta),
              note: raw.note ?? null,
              actor_id: uid ?? raw.actor_id ?? null,
              batch_id: raw.batch_id!,
              undone: Boolean(raw.undone),
              undone_at: raw.undone_at ?? null,
              created_at: raw.created_at || new Date().toISOString(),
            };
            mockState.studentPoints.set(row.id, row);
            upserted.push(row);
          }
          return { data: upserted, error: null };
        }
        if (op === 'update') {
          const updated: MockStudentPointRow[] = [];
          for (const row of mockState.studentPoints.values()) {
            if (
              isClassTeacher(row.class_id, uid) &&
              isStudentInClass(row.student_id, row.class_id, uid) &&
              matchesFilters(row as unknown as Record<string, unknown>)
            ) {
              const next = { ...row, ...(payload as Partial<MockStudentPointRow>) };
              mockState.studentPoints.set(row.id, next);
              updated.push(next);
            }
          }
          return { data: updated, error: null };
        }
      }

      if (table === 'weekly_comments') {
        if (op === 'select') {
          const rows = Array.from(mockState.weeklyComments.values()).filter(
            (r) =>
              ((isClassTeacher(r.class_id, uid) && isStudentInClass(r.student_id, r.class_id, uid)) ||
                (isVerifiedParent(r.student_id, uid) && r.status === 'sent')) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'upsert' || op === 'insert') {
          const items = Array.isArray(payload) ? payload : [payload];
          const upserted: MockWeeklyCommentRow[] = [];
          for (const raw of items as Partial<MockWeeklyCommentRow>[]) {
            if (!isUUID(raw.id) || !isUUID(raw.class_id) || !isUUID(raw.student_id)) {
              return { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } };
            }
            if (!isClassTeacher(raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: 'Chỉ giáo viên phụ trách lớp hoặc quản trị viên mới được thao tác nhận xét.',
                },
              };
            }
            if (!isStudentInClass(raw.student_id!, raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: `Học sinh (id: ${raw.student_id}) không thuộc lớp (id: ${raw.class_id}).`,
                },
              };
            }
            const existingById = mockState.weeklyComments.get(raw.id!);
            const status = (raw.status || 'draft') as 'draft' | 'sent';
            if (existingById) {
              if (existingById.status === 'sent' && status === 'draft' && prof?.role !== 'admin') {
                return {
                  data: null,
                  error: {
                    code: 'P0001',
                    message: 'Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.',
                  },
                };
              }
              const updated: MockWeeklyCommentRow = {
                ...existingById,
                content: raw.content ?? existingById.content,
                date: raw.date ?? existingById.date,
                week_number: raw.week_number ?? existingById.week_number,
                school_year: raw.school_year ?? existingById.school_year,
                status,
                sent_at:
                  existingById.status === 'sent' && status === 'sent'
                    ? existingById.sent_at
                    : status === 'sent'
                    ? raw.sent_at || new Date().toISOString()
                    : null,
                tags: raw.tags ?? existingById.tags,
                updated_at: new Date().toISOString(),
              };
              mockState.weeklyComments.set(updated.id, updated);
              upserted.push(updated);
            } else {
              const created: MockWeeklyCommentRow = {
                id: raw.id!,
                class_id: raw.class_id!,
                student_id: raw.student_id!,
                week_number: raw.week_number ?? null,
                school_year: raw.school_year!,
                date: raw.date!,
                content: raw.content!,
                status,
                sent_at: status === 'sent' ? raw.sent_at || new Date().toISOString() : null,
                teacher_id: uid ?? raw.teacher_id ?? null,
                tags: raw.tags ?? [],
                created_at: raw.created_at || new Date().toISOString(),
                updated_at: raw.updated_at || new Date().toISOString(),
              };
              mockState.weeklyComments.set(created.id, created);
              upserted.push(created);
            }
          }
          return { data: upserted, error: null };
        }
        if (op === 'update') {
          const updated: MockWeeklyCommentRow[] = [];
          for (const row of mockState.weeklyComments.values()) {
            if (
              isClassTeacher(row.class_id, uid) &&
              isStudentInClass(row.student_id, row.class_id, uid) &&
              matchesFilters(row as unknown as Record<string, unknown>)
            ) {
              const patch = payload as Partial<MockWeeklyCommentRow>;
              const nextStatus = patch.status ?? row.status;
              if (row.status === 'sent' && nextStatus === 'draft' && prof?.role !== 'admin') {
                return {
                  data: null,
                  error: {
                    code: 'P0001',
                    message: 'Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.',
                  },
                };
              }
              const nextSentAt =
                row.status === 'sent' && nextStatus === 'sent'
                  ? row.sent_at
                  : nextStatus === 'sent'
                  ? patch.sent_at || new Date().toISOString()
                  : null;
              const next: MockWeeklyCommentRow = {
                ...row,
                ...patch,
                status: nextStatus,
                sent_at: nextSentAt,
                teacher_id: row.status === 'sent' ? row.teacher_id : uid ?? row.teacher_id,
                updated_at: new Date().toISOString(),
              };
              mockState.weeklyComments.set(row.id, next);
              updated.push(next);
            }
          }
          return { data: updated, error: null };
        }
        if (op === 'delete') {
          const deleted: MockWeeklyCommentRow[] = [];
          for (const row of Array.from(mockState.weeklyComments.values())) {
            if (
              isClassTeacher(row.class_id, uid) &&
              isStudentInClass(row.student_id, row.class_id, uid) &&
              matchesFilters(row as unknown as Record<string, unknown>)
            ) {
              if (row.status === 'sent' && prof?.role !== 'admin') {
                return {
                  data: null,
                  error: {
                    code: 'P0001',
                    message: 'Không được phép xóa nhận xét đã gửi tới phụ huynh (bảo vệ lưu trữ sư phạm).',
                  },
                };
              }
              mockState.weeklyComments.delete(row.id);
              deleted.push(row);
            }
          }
          return { data: deleted, error: null };
        }
      }

      if (table === 'parent_invitation_tokens') {
        if (op === 'select') {
          const rows = Array.from(mockState.parentInvitationTokens.values()).filter(
            (r) =>
              isClassTeacher(r.class_id, uid) &&
              isStudentInClass(r.student_id, r.class_id, uid) &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
        if (op === 'insert') {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted: MockInvitationTokenRow[] = [];
          for (const raw of items as Partial<MockInvitationTokenRow>[]) {
            if (!isUUID(raw.class_id) || !isUUID(raw.student_id)) {
              return { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } };
            }
            if (!isClassTeacher(raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: `Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp ${raw.class_id}.`,
                },
              };
            }
            if (!isStudentInClass(raw.student_id!, raw.class_id!, uid)) {
              return {
                data: null,
                error: {
                  code: 'P0001',
                  message: `Ràng buộc không hợp lệ: Học sinh (id: ${raw.student_id}) không thuộc lớp (id: ${raw.class_id}) hoặc đã nghỉ học.`,
                },
              };
            }
            const nowIso = new Date().toISOString();
            const created: MockInvitationTokenRow = {
              id: raw.id && isUUID(raw.id) ? raw.id : nextMockUuid(),
              class_id: raw.class_id!,
              student_id: raw.student_id!,
              token_hash: raw.token_hash!,
              parent_phone: raw.parent_phone ?? null,
              expires_at: raw.expires_at || new Date(Date.now() + 30 * 86400000).toISOString(),
              is_revoked: false,
              revoked_at: null,
              used_at: null,
              used_by: null,
              created_by: uid ?? raw.created_by ?? null,
              created_at: nowIso,
              updated_at: nowIso,
            };
            mockState.parentInvitationTokens.set(created.id, created);
            inserted.push(created);
          }
          return { data: inserted, error: null };
        }
      }

      if (table === 'parent_students') {
        if (op === 'select') {
          const rows = Array.from(mockState.parentStudents.values()).filter(
            (r) =>
              (r.parent_id === uid || isTeacherOfStudent(r.student_id, uid) || prof?.role === 'admin') &&
              matchesFilters(r as unknown as Record<string, unknown>),
          );
          return { data: rows, error: null };
        }
      }

      return { data: [], error: null };
    };

    const builder = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) headCount = true;
        return builder;
      },
      insert: (data: unknown) => {
        op = 'insert';
        payload = data;
        return builder;
      },
      update: (data: unknown) => {
        op = 'update';
        payload = data;
        return builder;
      },
      upsert: (data: unknown) => {
        op = 'upsert';
        payload = data;
        return builder;
      },
      delete: () => {
        op = 'delete';
        return builder;
      },
      eq: (col: string, val: unknown) => {
        eqFilters.push([col, val]);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        neqFilters.push([col, val]);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        inFilters.push([col, vals]);
        return builder;
      },
      order: () => builder,
      maybeSingle: async () => {
        const res = await execute();
        if (res.error) return { data: null, error: res.error };
        const arr = Array.isArray(res.data) ? res.data : [];
        return { data: arr[0] ?? null, error: null };
      },
      then: (
        onFulfilled?: (value: { data: unknown; error: { message: string; code?: string } | null; count?: number }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => execute().then(onFulfilled, onRejected),
    };

    return builder;
  };

  return {
    isSupabaseConfigured: true,
    supabase: {
      auth: {
        getSession: async () => {
          if (!mockState.currentUserId) {
            return { data: { session: null }, error: null };
          }
          const prof = mockState.profiles.get(mockState.currentUserId);
          return {
            data: {
              session: {
                user: {
                  id: mockState.currentUserId,
                  email: prof?.email ?? 'user@tienclass.local',
                },
              },
            },
            error: null,
          };
        },
      },
      from: (table: string) => createQueryBuilder(table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        mockState.rpcCalls.push({ fn, args });
        if (fn === 'create_student_in_class') {
          const uid = mockState.currentUserId;
          if (!uid) {
            return { data: null, error: { message: 'Yêu cầu đăng nhập.', code: 'P0001' } };
          }
          const classId = args.p_class_id as string;
          if (!isClassTeacher(classId, uid)) {
            return {
              data: null,
              error: { message: 'Bạn không phải là giáo viên phụ trách lớp này.', code: 'P0001' },
            };
          }
          const code = String(args.p_code || '').toUpperCase();
          for (const existing of mockState.students.values()) {
            if (existing.code.toUpperCase() === code) {
              return {
                data: null,
                error: { message: 'duplicate key value violates unique constraint "students_code_key"', code: '23505' },
              };
            }
          }
          const studentId = nextMockUuid();
          const nowIso = new Date().toISOString();
          mockState.students.set(studentId, {
            id: studentId,
            code,
            full_name: String(args.p_full_name || ''),
            birth_date: (args.p_birth_date as string | null) ?? null,
            gender: (args.p_gender as string | null) ?? null,
            avatar: String(args.p_avatar || 'cat-pink'),
            note: (args.p_note as string | null) ?? null,
            parent_name: (args.p_parent_name as string | null) ?? null,
            parent_phone: (args.p_parent_phone as string | null) ?? null,
            status: 'active',
            created_at: nowIso,
            updated_at: nowIso,
          });
          const memId = nextMockUuid();
          mockState.memberships.set(memId, {
            id: memId,
            class_id: classId,
            student_id: studentId,
            joined_at: '2026-10-26',
            left_at: null,
            is_active: true,
            created_at: nowIso,
          });
          return { data: { ok: true, student_id: studentId }, error: null };
        }

        if (fn === 'revoke_parent_invitation') {
          const uid = mockState.currentUserId;
          if (!uid) {
            return { data: null, error: { message: 'Chưa được xác thực: Vui lòng đăng nhập.', code: 'P0001' } };
          }
          const tokenId = args.p_token_id as string;
          const record = mockState.parentInvitationTokens.get(tokenId);
          if (!record) {
            return { data: { ok: false, message: 'Mã liên kết không tồn tại.' }, error: null };
          }
          if (!isClassTeacher(record.class_id, uid)) {
            return {
              data: { ok: false, message: 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp này.' },
              error: null,
            };
          }
          if (record.used_at !== null) {
            return {
              data: { ok: false, message: 'Mã liên kết này đã được phụ huynh sử dụng, không thể thu hồi.' },
              error: null,
            };
          }
          if (record.is_revoked) {
            return {
              data: { ok: true, message: 'Mã liên kết này đã được thu hồi từ trước.' },
              error: null,
            };
          }
          const nowIso = new Date().toISOString();
          mockState.parentInvitationTokens.set(tokenId, {
            ...record,
            is_revoked: true,
            revoked_at: nowIso,
            updated_at: nowIso,
          });
          return { data: { ok: true, message: 'Thu hồi mã liên kết thành công.' }, error: null };
        }

        if (fn === 'claim_parent_invitation') {
          const uid = mockState.currentUserId;
          if (!uid) {
            return {
              data: null,
              error: { message: 'Chưa được xác thực: Vui lòng đăng nhập trước khi kích hoạt mã liên kết.', code: 'P0001' },
            };
          }
          const rawToken = typeof args.raw_token === 'string' ? args.raw_token.trim() : '';
          if (rawToken.length < 16) {
            return {
              data: { ok: false, message: 'Mã liên kết không đúng định dạng hoặc quá ngắn.' },
              error: null,
            };
          }
          const tokenHash = await sha256(rawToken);
          let matchedToken: MockInvitationTokenRow | undefined;
          for (const tk of mockState.parentInvitationTokens.values()) {
            if (tk.token_hash === tokenHash) {
              matchedToken = tk;
              break;
            }
          }
          if (!matchedToken) {
            return {
              data: { ok: false, message: 'Mã liên kết không tồn tại trong hệ thống.' },
              error: null,
            };
          }
          if (matchedToken.is_revoked) {
            return {
              data: { ok: false, message: 'Mã liên kết này đã bị giáo viên thu hồi hoặc cấp mới.' },
              error: null,
            };
          }
          if (matchedToken.used_at !== null) {
            return {
              data: { ok: false, message: 'Mã liên kết này đã được sử dụng trước đó.' },
              error: null,
            };
          }
          if (new Date(matchedToken.expires_at).getTime() <= Date.now()) {
            return {
              data: { ok: false, message: 'Mã liên kết này đã hết hạn hiệu lực.' },
              error: null,
            };
          }
          let isActiveMember = false;
          for (const m of mockState.memberships.values()) {
            if (
              m.class_id === matchedToken.class_id &&
              m.student_id === matchedToken.student_id &&
              m.is_active
            ) {
              isActiveMember = true;
              break;
            }
          }
          if (!isActiveMember) {
            return {
              data: { ok: false, message: 'Học sinh không còn hoạt động trong lớp học liên kết.' },
              error: null,
            };
          }

          const nowIso = new Date().toISOString();
          mockState.parentInvitationTokens.set(matchedToken.id, {
            ...matchedToken,
            used_at: nowIso,
            used_by: uid,
            updated_at: nowIso,
          });

          let existingLink: MockParentStudentRow | undefined;
          for (const ps of mockState.parentStudents.values()) {
            if (ps.parent_id === uid && ps.student_id === matchedToken.student_id) {
              existingLink = ps;
              break;
            }
          }

          if (existingLink?.is_verified) {
            return {
              data: {
                ok: true,
                message: 'Tài khoản của bạn đã được liên kết với học sinh này từ trước.',
                student_id: matchedToken.student_id,
              },
              error: null,
            };
          }

          const linkId = existingLink?.id ?? nextMockUuid();
          mockState.parentStudents.set(linkId, {
            id: linkId,
            parent_id: uid,
            student_id: matchedToken.student_id,
            relationship: 'Phụ huynh',
            is_verified: true,
            verified_at: nowIso,
            verified_by: matchedToken.created_by,
            created_at: existingLink?.created_at ?? nowIso,
          });

          return {
            data: {
              ok: true,
              message: 'Xác minh và liên kết học sinh thành công!',
              student_id: matchedToken.student_id,
            },
            error: null,
          };
        }

        return { data: null, error: { message: `Unknown RPC ${fn}` } };
      },
    },
  };
});

import { db, ALL_TABLES } from './db';
import {
  addStudent,
  archiveStudents,
  awardPoints,
  claimParentInvitationToken,
  clearAttendance,
  clearSyncedCloudCacheFromLocal,
  createClass,
  deleteClass,
  deleteComment,
  deleteStudentsPermanently,
  fetchParentPortalData,
  flushPendingSyncQueue,
  getCurrentUserProfile,
  getOrCreateParentLink,
  getPendingSyncQueue,
  redoTransaction,
  regenerateParentLink,
  removeCriterion,
  restoreStudents,
  revokeParentInvitationToken,
  saveAttendance,
  saveComment,
  saveCriterion,
  syncClassesAndStudentsFromSupabase,
  transferStudents,
  undoBatch,
  undoTransaction,
  updateClass,
  updateStudent,
} from './repo';

async function clearLocalDb() {
  for (const t of ALL_TABLES) {
    await db.table(t).clear();
  }
}

describe('Tích hợp Supabase Bước 3.1 – 3.4 (Auth, Lớp, Tiêu chí, Học sinh, Điểm danh, Điểm thi đua, Nhận xét tuần)', () => {
  beforeEach(async () => {
    resetMockCloud();
    await clearLocalDb();
  });

  it('Bước 3.1: Xác định đúng vai trò từ public.profiles và chặn tài khoản parent thực hiện thao tác của giáo viên', async () => {
    expect(await getCurrentUserProfile()).toBeNull();

    mockState.currentUserId = PARENT_ID;
    const parentProfile = await getCurrentUserProfile();
    expect(parentProfile?.role).toBe('parent');
    expect(parentProfile?.fullName).toBe('Phụ huynh C');

    await expect(
      createClass({
        name: '3A1',
        schoolYear: '2026-2027',
        teacherName: 'Phụ huynh C',
      }),
    ).rejects.toThrow(/Quyền bị từ chối/);

    mockState.currentUserId = TEACHER_A_ID;
    const teacherProfile = await getCurrentUserProfile();
    expect(teacherProfile?.role).toBe('teacher');
    expect(teacherProfile?.id).toBe(TEACHER_A_ID);
  });

  it('Bước 3.2: Giáo viên tạo, sửa, xóa lớp học và tiêu chí đồng bộ giữa Supabase và IndexedDB', async () => {
    mockState.currentUserId = TEACHER_A_ID;

    const cls = await createClass({
      name: '4A2',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
      subject: 'Toán - Tiếng Việt',
      note: 'Lớp thực nghiệm Cloud',
    });

    expect(isUUID(cls.id)).toBe(true);
    expect(mockState.classes.has(cls.id)).toBe(true);
    expect(mockState.classes.get(cls.id)?.teacher_id).toBe(TEACHER_A_ID);

    const localCriteria = await db.criteria.where('classId').equals(cls.id).toArray();
    expect(localCriteria).toHaveLength(6);
    expect(mockState.criteria.size).toBe(6);

    await saveCriterion(cls.id, {
      name: 'Viết chữ đẹp',
      points: 5,
      type: 'reward',
      icon: 'star',
    });
    const afterAddCriteria = await db.criteria.where('classId').equals(cls.id).toArray();
    expect(afterAddCriteria).toHaveLength(7);
    expect(mockState.criteria.size).toBe(7);

    const addedCrit = afterAddCriteria.find((c) => c.name === 'Viết chữ đẹp')!;
    expect(isUUID(addedCrit.id)).toBe(true);
    expect(mockState.criteria.get(addedCrit.id)?.display_order).toBe(6);

    await saveCriterion(
      cls.id,
      {
        name: 'Viết chữ rất đẹp',
        points: 10,
        type: 'reward',
        icon: 'sparkles',
      },
      addedCrit.id,
    );
    expect(mockState.criteria.get(addedCrit.id)?.name).toBe('Viết chữ rất đẹp');
    expect(mockState.criteria.get(addedCrit.id)?.points).toBe(10);

    await removeCriterion(addedCrit.id);
    expect(mockState.criteria.has(addedCrit.id)).toBe(false);

    await updateClass(cls.id, {
      name: '4A2 - Chất lượng cao',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
      subject: 'Chủ nhiệm',
    });
    expect(mockState.classes.get(cls.id)?.name).toBe('4A2 - Chất lượng cao');
    expect((await db.classes.get(cls.id))?.name).toBe('4A2 - Chất lượng cao');
  });

  it('Bước 3.3: Tạo học sinh qua RPC create_student_in_class kèm parent_name/parent_phone, cập nhật, lưu trữ và chuyển lớp', async () => {
    mockState.currentUserId = TEACHER_A_ID;

    const cls1 = await createClass({
      name: '5A1',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const cls2 = await createClass({
      name: '5A2',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });

    const student = await addStudent(cls1.id, {
      code: 'hs0101',
      fullName: 'Nguyễn Minh Châu',
      birthDate: '2016-09-05',
      gender: 'female',
      avatar: 'bunny-pink',
      parentName: 'Nguyễn Văn Hòa',
      parentPhone: '0912345678',
      note: 'Lớp trưởng gương mẫu',
    });

    expect(mockState.rpcCalls).toHaveLength(1);
    expect(mockState.rpcCalls[0]).toEqual({
      fn: 'create_student_in_class',
      args: {
        p_class_id: cls1.id,
        p_code: 'HS0101',
        p_full_name: 'Nguyễn Minh Châu',
        p_gender: 'female',
        p_birth_date: '2016-09-05',
        p_avatar: 'bunny-pink',
        p_note: 'Lớp trưởng gương mẫu',
        p_parent_name: 'Nguyễn Văn Hòa',
        p_parent_phone: '0912345678',
      },
    });

    expect(isUUID(student.id)).toBe(true);
    const cloudStu = mockState.students.get(student.id);
    expect(cloudStu?.parent_name).toBe('Nguyễn Văn Hòa');
    expect(cloudStu?.parent_phone).toBe('0912345678');

    const activeMemberships = Array.from(mockState.memberships.values()).filter(
      (m) => m.student_id === student.id && m.is_active,
    );
    expect(activeMemberships).toHaveLength(1);
    expect(activeMemberships[0].class_id).toBe(cls1.id);

    await updateStudent(student.id, {
      code: 'HS0101',
      fullName: 'Nguyễn Minh Châu',
      birthDate: '2016-09-05',
      gender: 'female',
      avatar: 'bunny-pink',
      parentName: 'Trần Thị Mai',
      parentPhone: '0987654321',
      note: 'Đã cập nhật SĐT mẹ',
    });
    expect(mockState.students.get(student.id)?.parent_name).toBe('Trần Thị Mai');
    expect(mockState.students.get(student.id)?.parent_phone).toBe('0987654321');
    expect((await db.students.get(student.id))?.parentPhone).toBe('0987654321');

    await archiveStudents([student.id]);
    expect(mockState.students.get(student.id)?.status).toBe('archived');
    expect((await db.students.get(student.id))?.status).toBe('archived');

    await restoreStudents([student.id]);
    expect(mockState.students.get(student.id)?.status).toBe('active');
    expect((await db.students.get(student.id))?.status).toBe('active');

    await transferStudents([student.id], cls2.id);
    const allMems = Array.from(mockState.memberships.values()).filter((m) => m.student_id === student.id);
    expect(allMems).toHaveLength(2);
    expect(allMems.find((m) => m.class_id === cls1.id)?.is_active).toBe(false);
    expect(allMems.find((m) => m.class_id === cls2.id)?.is_active).toBe(true);
    expect((await db.students.get(student.id))?.classId).toBe(cls2.id);

    await deleteStudentsPermanently([student.id]);
    expect(mockState.students.has(student.id)).toBe(false);
    expect(await db.students.get(student.id)).toBeUndefined();
  });

  it('Bước 3.4: Đồng bộ Điểm danh, Điểm thi đua và Nhận xét tuần (kèm bất biến nhận xét đã gửi)', async () => {
    mockState.currentUserId = TEACHER_A_ID;

    const cls = await createClass({
      name: '3B1',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stu1 = await addStudent(cls.id, {
      code: 'HS301',
      fullName: 'Lê Bảo Ngọc',
      gender: 'female',
      avatar: 'cat-pink',
    });
    const stu2 = await addStudent(cls.id, {
      code: 'HS302',
      fullName: 'Phạm Hoàng Quân',
      gender: 'male',
      avatar: 'bear-sky',
    });

    // --- 3.4.1: Điểm danh (Upsert không tạo bản ghi trùng khi bấm lưu nhiều lần) ---
    await saveAttendance(cls.id, '2026-10-26', 'morning', [
      { studentId: stu1.id, status: 'present' },
      { studentId: stu2.id, status: 'late', note: 'Muộn 5 phút' },
    ]);
    expect(mockState.attendance.size).toBe(2);

    // Lưu đè lần 2 cùng ngày/buổi -> vẫn chỉ có đúng 2 bản ghi trên Cloud và IndexedDB
    await saveAttendance(cls.id, '2026-10-26', 'morning', [
      { studentId: stu1.id, status: 'present' },
      { studentId: stu2.id, status: 'excused', note: 'Xin phép nghỉ ốm' },
    ]);
    expect(mockState.attendance.size).toBe(2);
    const localAtt = await db.attendance
      .where('[classId+date+session]')
      .equals([cls.id, '2026-10-26', 'morning'])
      .toArray();
    expect(localAtt).toHaveLength(2);
    expect(localAtt.find((a) => a.studentId === stu2.id)?.status).toBe('excused');

    // Xóa điểm danh ngày/buổi
    await clearAttendance(cls.id, '2026-10-26', 'morning');
    expect(mockState.attendance.size).toBe(0);

    // Điểm danh lại để phục vụ hậu kiểm
    await saveAttendance(cls.id, '2026-10-26', 'morning', [
      { studentId: stu1.id, status: 'present' },
      { studentId: stu2.id, status: 'present' },
    ]);
    expect(mockState.attendance.size).toBe(2);

    // --- 3.4.2: Điểm thi đua (UUID khóa chính, batch_id, hoàn tác & làm lại) ---
    const criteria = await db.criteria.where('classId').equals(cls.id).toArray();
    const rewardCrit = criteria.find((c) => c.type === 'reward')!;

    const awardRes = await awardPoints({
      classId: cls.id,
      studentIds: [stu1.id, stu2.id],
      criterion: rewardCrit,
      note: 'Hăng hái phát biểu',
    });
    expect(isUUID(awardRes.batchId)).toBe(true);
    expect(awardRes.count).toBe(2);
    expect(mockState.studentPoints.size).toBe(2);

    const tx1Id = awardRes.transactionIds[0];
    expect(isUUID(tx1Id)).toBe(true);

    // Hoàn tác 1 giao dịch -> đồng bộ undone = true lên Cloud
    await undoTransaction(tx1Id);
    expect(mockState.studentPoints.get(tx1Id)?.undone).toBe(true);
    expect((await db.transactions.get(tx1Id))?.undone).toBe(true);

    // Khôi phục giao dịch (redo)
    await redoTransaction(tx1Id);
    expect(mockState.studentPoints.get(tx1Id)?.undone).toBe(false);

    // Hoàn tác cả lô (batch)
    await undoBatch(awardRes.batchId);
    for (const row of mockState.studentPoints.values()) {
      expect(row.undone).toBe(true);
    }

    // --- 3.4.3: Nhận xét tuần (Draft -> Sent & Bảo vệ bất biến nhận xét đã gửi) ---
    const draftCmt = await saveComment(cls.id, {
      studentId: stu1.id,
      date: '2026-10-26',
      session: 'all',
      content: 'Bản nháp nhận xét tuần 43',
      tags: ['chăm ngoan'],
      status: 'draft',
    });
    expect(isUUID(draftCmt.id)).toBe(true);
    expect(mockState.weeklyComments.get(draftCmt.id)?.status).toBe('draft');
    expect(mockState.weeklyComments.get(draftCmt.id)?.sent_at).toBeNull();

    // Nhận xét ở trạng thái draft được phép xóa
    const tempDraft = await saveComment(cls.id, {
      studentId: stu2.id,
      date: '2026-10-26',
      session: 'all',
      content: 'Nháp tạm thời',
      tags: [],
      status: 'draft',
    });
    await deleteComment(tempDraft.id);
    expect(mockState.weeklyComments.has(tempDraft.id)).toBe(false);

    // Phát hành bản nháp sang trạng thái 'sent'
    const sentCmt = await saveComment(
      cls.id,
      {
        studentId: stu1.id,
        date: '2026-10-26',
        session: 'all',
        content: 'Con hoàn thành tốt bài tập tuần này!',
        tags: ['tiến bộ'],
        status: 'sent',
      },
      draftCmt.id,
    );
    expect(sentCmt.status).toBe('sent');
    expect(sentCmt.sentAt).toBeDefined();
    const originalSentAtIso = mockState.weeklyComments.get(draftCmt.id)?.sent_at;
    expect(originalSentAtIso).toBeTruthy();

    // Cố tình hoàn tác nhận xét đã gửi ('sent') về 'draft' -> BỊ TỪ CHỐI
    await expect(
      saveComment(
        cls.id,
        {
          studentId: stu1.id,
          date: '2026-10-26',
          session: 'all',
          content: 'Thử kéo về nháp',
          tags: [],
          status: 'draft',
        },
        draftCmt.id,
      ),
    ).rejects.toThrow(/Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp/);

    // Cố tình xóa nhận xét đã gửi ('sent') -> BỊ TỪ CHỐI
    await expect(deleteComment(draftCmt.id)).rejects.toThrow(
      /Không được phép xóa nhận xét đã gửi tới phụ huynh/,
    );
    expect(mockState.weeklyComments.has(draftCmt.id)).toBe(true);
    expect(await db.comments.get(draftCmt.id)).toBeDefined();

    // Cập nhật nội dung nhận xét đã gửi ('sent' -> 'sent') vẫn bảo toàn nguyên vẹn sent_at gốc
    await saveComment(
      cls.id,
      {
        studentId: stu1.id,
        date: '2026-10-26',
        session: 'all',
        content: 'Con hoàn thành xuất sắc bài tập tuần này!',
        tags: ['tiến bộ'],
        status: 'sent',
      },
      draftCmt.id,
    );
    expect(mockState.weeklyComments.get(draftCmt.id)?.sent_at).toBe(originalSentAtIso);
  });

  it('Bước 3.4: Chặn ID không hợp lệ (s_..., c_...), khóa ngoại sai lớp và thao tác trái vai trò / trái lớp', async () => {
    mockState.currentUserId = TEACHER_A_ID;
    const classA = await createClass({
      name: '1A1',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stuA = await addStudent(classA.id, {
      code: 'HS101',
      fullName: 'Học Sinh A',
      gender: 'female',
      avatar: 'cat-pink',
    });

    mockState.currentUserId = TEACHER_B_ID;
    const classB = await createClass({
      name: '1B1',
      schoolYear: '2026-2027',
      teacherName: 'Thầy Nam B',
    });
    const stuB = await addStudent(classB.id, {
      code: 'HS201',
      fullName: 'Học Sinh B',
      gender: 'male',
      avatar: 'bear-sky',
    });
    const critB = (await db.criteria.where('classId').equals(classB.id).toArray())[0];

    // 1. Chặn gửi ID cục bộ (s_..., c_...) lên lớp Cloud
    mockState.currentUserId = TEACHER_A_ID;
    await expect(
      saveAttendance(classA.id, '2026-10-26', 'morning', [{ studentId: 's_local_fake', status: 'present' }]),
    ).rejects.toThrow(/Mã định danh học sinh không hợp lệ/);

    await expect(
      awardPoints({
        classId: classA.id,
        studentIds: ['s_local_fake'],
        customName: 'Thưởng',
        delta: 2,
      }),
    ).rejects.toThrow(/Mã định danh học sinh không hợp lệ/);

    await expect(
      saveComment(classA.id, {
        studentId: 's_local_fake',
        date: '2026-10-26',
        session: 'all',
        content: 'Nhận xét',
        tags: [],
      }),
    ).rejects.toThrow(/Mã định danh học sinh không hợp lệ/);

    await expect(
      saveAttendance('c_non_existent', '2026-10-26', 'morning', [{ studentId: stuA.id, status: 'present' }]),
    ).rejects.toThrow(/Mã lớp học không hợp lệ hoặc không tồn tại/);

    // 2. Chặn dùng tiêu chí của Lớp B để chấm điểm cho Lớp A
    await expect(
      awardPoints({
        classId: classA.id,
        studentIds: [stuA.id],
        criterion: critB,
      }),
    ).rejects.toThrow(/Tiêu chí thi đua được chọn không thuộc lớp học này/);

    // 3. Chặn Giáo viên A điểm danh, chấm điểm hoặc nhận xét học sinh của Lớp B
    await expect(
      saveAttendance(classA.id, '2026-10-26', 'morning', [{ studentId: stuB.id, status: 'present' }]),
    ).rejects.toThrow(/Học sinh không thuộc lớp học này/);

    await expect(
      saveAttendance(classB.id, '2026-10-26', 'morning', [{ studentId: stuB.id, status: 'present' }]),
    ).rejects.toThrow(/Bạn không phải giáo viên phụ trách lớp này/);

    await expect(
      awardPoints({
        classId: classB.id,
        studentIds: [stuB.id],
        customName: 'Chấm trái lớp',
        delta: 2,
      }),
    ).rejects.toThrow(/Bạn không phải giáo viên phụ trách lớp này/);

    await expect(
      saveComment(classB.id, {
        studentId: stuB.id,
        date: '2026-10-26',
        session: 'all',
        content: 'Nhận xét trái lớp',
        tags: [],
      }),
    ).rejects.toThrow(/Chỉ giáo viên phụ trách lớp hoặc quản trị viên mới được thao tác nhận xét/);

    await expect(deleteClass(classB.id)).rejects.toThrow(/Không tìm thấy lớp học hoặc bạn không có quyền/);

    // 4. Chặn vai trò Parent gọi điểm danh, chấm điểm, nhận xét
    mockState.currentUserId = PARENT_ID;
    await expect(
      saveAttendance(classA.id, '2026-10-26', 'morning', [{ studentId: stuA.id, status: 'present' }]),
    ).rejects.toThrow(/Quyền bị từ chối/);
    await expect(
      awardPoints({ classId: classA.id, studentIds: [stuA.id], customName: 'Test', delta: 1 }),
    ).rejects.toThrow(/Quyền bị từ chối/);
    await expect(
      saveComment(classA.id, {
        studentId: stuA.id,
        date: '2026-10-26',
        session: 'all',
        content: 'Test',
        tags: [],
      }),
    ).rejects.toThrow(/Quyền bị từ chối/);
  });

  it('Bước 3.4: Mất mạng, lưu hàng đợi Offline, thử lại và đồng bộ lặp (Idempotent) không nhân đôi dữ liệu', async () => {
    mockState.currentUserId = TEACHER_A_ID;

    const cls = await createClass({
      name: '2B2',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stu = await addStudent(cls.id, {
      code: 'HS401',
      fullName: 'Đặng Tuấn Kiệt',
      gender: 'male',
      avatar: 'fox-lavender',
    });

    // Giả lập mất mạng đột ngột khi giáo viên đang thao tác trong lớp
    mockState.networkOffline = true;

    await saveAttendance(cls.id, '2026-10-26', 'morning', [
      { studentId: stu.id, status: 'late', note: 'Mưa lớn' },
    ]);
    // Bấm lưu điểm danh lần 2 khi vẫn mất mạng -> hàng đợi tự gộp khóa không trùng
    await saveAttendance(cls.id, '2026-10-26', 'morning', [
      { studentId: stu.id, status: 'present', note: 'Đã vào lớp' },
    ]);

    const ptRes = await awardPoints({
      classId: cls.id,
      studentIds: [stu.id],
      customName: 'Phát biểu bài mới',
      delta: 3,
    });

    const cmtRes = await saveComment(cls.id, {
      studentId: stu.id,
      date: '2026-10-26',
      session: 'all',
      content: 'Con học tập rất sôi nổi dù trời mưa.',
      tags: ['chăm học'],
      status: 'sent',
    });

    // Khi đang mất mạng, Cloud chưa nhận được nhưng IndexedDB và hàng đợi đã lưu đầy đủ
    expect(mockState.attendance.size).toBe(0);
    expect(mockState.studentPoints.size).toBe(0);
    expect(mockState.weeklyComments.size).toBe(0);

    const queueWhileOffline = await getPendingSyncQueue();
    expect(queueWhileOffline).toHaveLength(3); // 1 attendance_upsert + 1 points_upsert + 1 comment_upsert

    // Mạng khôi phục -> Gọi flushPendingSyncQueue và syncClassesAndStudentsFromSupabase lặp lại 3 lần liên tiếp
    mockState.networkOffline = false;
    const flush1 = await flushPendingSyncQueue();
    expect(flush1.flushedCount).toBe(3);
    expect(flush1.remainingCount).toBe(0);

    await syncClassesAndStudentsFromSupabase();
    await syncClassesAndStudentsFromSupabase();
    await flushPendingSyncQueue();

    // Kiểm tra tính Idempotent: Tuyệt đối KHÔNG nhân đôi điểm danh, giao dịch điểm hay nhận xét
    expect(mockState.attendance.size).toBe(1);
    expect(mockState.studentPoints.size).toBe(1);
    expect(mockState.weeklyComments.size).toBe(1);

    const localTxs = await db.transactions.where('classId').equals(cls.id).toArray();
    expect(localTxs).toHaveLength(1);
    expect(localTxs[0].id).toBe(ptRes.transactionIds[0]);
    expect(localTxs[0].delta).toBe(3);

    const localCmts = await db.comments.where('classId').equals(cls.id).toArray();
    expect(localCmts).toHaveLength(1);
    expect(localCmts[0].id).toBe(cmtRes.id);
  });

  it('Bảo toàn toàn bộ dữ liệu Offline (Lớp, HS, Điểm danh, Điểm, Nhận xét) khi chuyển tài khoản và đăng xuất', async () => {
    // 1. Tạo dữ liệu ở chế độ Offline (chưa đăng nhập)
    mockState.currentUserId = null;
    await db.classes.put({
      id: 'c_offline_legacy',
      name: '1A Offline',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên Offline',
      color: '#F7A8C4',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await db.students.put({
      id: 's_offline_legacy',
      classId: 'c_offline_legacy',
      code: 'HSOFF01',
      fullName: 'Bé Bông Offline',
      gender: 'female',
      avatar: 'cat-pink',
      parentName: 'Mẹ Bé Bông',
      parentPhone: '0909000111',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    });

    await saveAttendance('c_offline_legacy', '2026-10-26', 'morning', [
      { studentId: 's_offline_legacy', status: 'present' },
    ]);
    await awardPoints({
      classId: 'c_offline_legacy',
      studentIds: ['s_offline_legacy'],
      customName: 'Thưởng Offline',
      delta: 5,
    });
    await saveComment('c_offline_legacy', {
      studentId: 's_offline_legacy',
      date: '2026-10-26',
      session: 'all',
      content: 'Nhận xét Offline cục bộ',
      tags: [],
      status: 'sent',
    });

    // 2. Giáo viên A đăng nhập và tạo dữ liệu Cloud (Lớp, HS, Điểm danh, Điểm, Nhận xét)
    mockState.currentUserId = TEACHER_A_ID;
    const classA = await createClass({
      name: '2A Cloud',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stuA = await addStudent(classA.id, {
      code: 'HSA001',
      fullName: 'Học Sinh Lớp A',
      gender: 'male',
      avatar: 'bear-sky',
    });
    await saveAttendance(classA.id, '2026-10-26', 'morning', [{ studentId: stuA.id, status: 'present' }]);
    await awardPoints({
      classId: classA.id,
      studentIds: [stuA.id],
      customName: 'Thưởng Cloud A',
      delta: 2,
    });
    await saveComment(classA.id, {
      studentId: stuA.id,
      date: '2026-10-26',
      session: 'all',
      content: 'Nhận xét Cloud A',
      tags: [],
      status: 'sent',
    });

    // 3. Chuyển sang Giáo viên B -> dữ liệu Cloud của Giáo viên A được dọn sạch, không lộ chéo
    mockState.currentUserId = TEACHER_B_ID;
    const syncB = await syncClassesAndStudentsFromSupabase();
    expect(syncB.classesCount).toBe(0);
    expect(syncB.attendanceCount).toBe(0);
    expect(syncB.transactionsCount).toBe(0);
    expect(syncB.commentsCount).toBe(0);

    expect(await db.attendance.where('classId').equals(classA.id).count()).toBe(0);
    expect(await db.transactions.where('classId').equals(classA.id).count()).toBe(0);
    expect(await db.comments.where('classId').equals(classA.id).count()).toBe(0);

    // 4. Đăng xuất hoàn toàn -> toàn bộ dữ liệu Offline ('c_offline_legacy') vẫn còn nguyên 100%
    mockState.currentUserId = null;
    await clearSyncedCloudCacheFromLocal();

    expect(await db.classes.get('c_offline_legacy')).toBeDefined();
    expect(await db.students.get('s_offline_legacy')).toBeDefined();
    expect(await db.attendance.where('classId').equals('c_offline_legacy').count()).toBe(1);
    expect(await db.transactions.where('classId').equals('c_offline_legacy').count()).toBe(1);
    expect(await db.comments.where('classId').equals('c_offline_legacy').count()).toBe(1);
  });

  it('Bước 3.5.1: Tạo mã mời phụ huynh hợp lệ, chỉ lưu SHA-256 token_hash (không lưu raw_token vào DB/IndexedDB), hỗ trợ thu hồi & cấp lại mã', async () => {
    mockState.currentUserId = TEACHER_A_ID;
    const classA = await createClass({
      name: '2A Mã Mời',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stuA = await addStudent(classA.id, {
      code: 'HSINV01',
      fullName: 'Nguyễn Minh Khôi',
      gender: 'male',
      avatar: 'bear-sky',
      parentName: 'Chị Lan',
      parentPhone: '0912345678',
    });

    // 1. Tạo mã mời lần đầu
    const link1 = await getOrCreateParentLink(classA.id, stuA.id);
    expect(isUUID(link1.id)).toBe(true);
    expect(link1.issuedRawToken).toBeDefined();
    expect(link1.issuedRawToken!.length).toBeGreaterThanOrEqual(32);

    const expectedHash1 = await sha256(link1.issuedRawToken!.trim());
    expect(link1.tokenHash).toBe(expectedHash1);
    expect(link1.tokenHash).not.toBe(link1.issuedRawToken);

    // Kiểm tra trên Supabase Cloud mock: chỉ lưu token_hash, tuyệt đối không có raw_token
    const cloudToken1 = mockState.parentInvitationTokens.get(link1.id);
    expect(cloudToken1).toBeDefined();
    expect(cloudToken1?.token_hash).toBe(expectedHash1);
    expect(JSON.stringify(cloudToken1)).not.toContain(link1.issuedRawToken!);

    // Kiểm tra trong IndexedDB cục bộ: trường token rỗng '', không lưu issuedRawToken xuống DB
    const localLink1 = await db.parentLinks.get(link1.id);
    expect(localLink1).toBeDefined();
    expect(localLink1?.token).toBe('');
    expect(localLink1?.issuedRawToken).toBeUndefined();
    expect(localLink1?.tokenHash).toBe(expectedHash1);

    // 2. Cấp lại mã mời mới -> mã cũ tự động bị thu hồi qua RPC revoke_parent_invitation
    const link2 = await regenerateParentLink(classA.id, stuA.id);
    expect(link2.id).not.toBe(link1.id);
    expect(link2.issuedRawToken).toBeDefined();
    expect(link2.issuedRawToken).not.toBe(link1.issuedRawToken);

    expect(mockState.parentInvitationTokens.get(link1.id)?.is_revoked).toBe(true);
    expect(mockState.parentInvitationTokens.get(link2.id)?.is_revoked).toBe(false);

    // 3. Thu hồi trực tiếp mã mời thứ 2 qua revokeParentInvitationToken
    const revRes = await revokeParentInvitationToken(link2.id);
    expect(revRes.ok).toBe(true);
    expect(mockState.parentInvitationTokens.get(link2.id)?.is_revoked).toBe(true);
    const localLink2AfterRevoke = await db.parentLinks.get(link2.id);
    expect(localLink2AfterRevoke?.isRevoked).toBe(true);
  });

  it('Bước 3.5.2: Bảo mật claim_parent_invitation với mã sai, mã hết hạn, mã đã thu hồi, mã đã dùng và kích hoạt trùng lặp', async () => {
    mockState.currentUserId = TEACHER_A_ID;
    const classA = await createClass({
      name: '2A Xác Minh PH',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stuA = await addStudent(classA.id, {
      code: 'HSCLM01',
      fullName: 'Trần Bảo Ngọc',
      gender: 'female',
      avatar: 'cat-pink',
    });

    // 1. Tạo mã đã hết hạn
    const expiredLink = await getOrCreateParentLink(classA.id, stuA.id, {
      expiresAtMs: Date.now() - 60_000,
    });
    const expiredRawToken = expiredLink.issuedRawToken!;

    // 2. Tạo mã rồi thu hồi
    const revokedLink = await regenerateParentLink(classA.id, stuA.id);
    const revokedRawToken = revokedLink.issuedRawToken!;
    await revokeParentInvitationToken(revokedLink.id);

    // 3. Tạo mã hợp lệ mới
    const validLink = await regenerateParentLink(classA.id, stuA.id);
    const validRawToken = validLink.issuedRawToken!;

    // Chuyển sang tài khoản Phụ huynh 1 (PARENT_ID)
    mockState.currentUserId = PARENT_ID;

    // A. Mã quá ngắn hoặc sai định dạng -> bị từ chối, không lộ token trong lỗi
    await expect(claimParentInvitationToken('short_token')).rejects.toThrow(/không đúng định dạng hoặc quá ngắn/);

    // B. Mã không tồn tại trong hệ thống -> bị từ chối
    await expect(claimParentInvitationToken('ffffffffffffffffffffffffffffffff')).rejects.toThrow(
      /không tồn tại trong hệ thống/,
    );

    // C. Mã đã hết hạn -> bị từ chối
    await expect(claimParentInvitationToken(expiredRawToken)).rejects.toThrow(/đã hết hạn hiệu lực/);

    // D. Mã đã bị giáo viên thu hồi -> bị từ chối
    await expect(claimParentInvitationToken(revokedRawToken)).rejects.toThrow(/đã bị giáo viên thu hồi/);

    // E. Kích hoạt đồng thời cùng 1 mã hợp lệ (2 yêu cầu song song) -> chỉ 1 thành công, 1 bị từ chối
    const settled = await Promise.allSettled([
      claimParentInvitationToken(validRawToken),
      claimParentInvitationToken(validRawToken),
    ]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/đã được sử dụng trước đó/);

    // F. Phụ huynh thứ 2 (PARENT_2_ID) thử dùng lại mã đã tiêu thụ -> bị từ chối
    mockState.currentUserId = PARENT_2_ID;
    await expect(claimParentInvitationToken(validRawToken)).rejects.toThrow(/đã được sử dụng trước đó/);

    // G. Giáo viên không thể thu hồi mã đã được phụ huynh sử dụng
    mockState.currentUserId = TEACHER_A_ID;
    await expect(revokeParentInvitationToken(validLink.id)).rejects.toThrow(
      /đã được phụ huynh sử dụng, không thể thu hồi/,
    );
  });

  it('Bước 3.5.3: Chặn thao tác sai vai trò, chặn giáo viên khác lớp và cách ly dữ liệu học sinh giữa các phụ huynh trên ParentPortal', async () => {
    // 1. Thiết lập Lớp A (Giáo viên A) với 2 học sinh: stuA1, stuA2
    mockState.currentUserId = TEACHER_A_ID;
    const classA = await createClass({
      name: '2A Cô Tiên',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên A',
    });
    const stuA1 = await addStudent(classA.id, {
      code: 'HSISO01',
      fullName: 'Lê Hoàng Bách',
      gender: 'male',
      avatar: 'bear-sky',
    });
    const stuA2 = await addStudent(classA.id, {
      code: 'HSISO02',
      fullName: 'Phạm Khánh Linh',
      gender: 'female',
      avatar: 'bunny-lavender',
    });

    const linkA1 = await getOrCreateParentLink(classA.id, stuA1.id);
    const linkA2 = await getOrCreateParentLink(classA.id, stuA2.id);

    // Giáo viên A ghi điểm danh, điểm thi đua, 1 nhận xét NHÁP (draft) và 1 nhận xét ĐÃ GỬI (sent) cho stuA1
    await saveAttendance(classA.id, '2026-10-26', 'morning', [
      { studentId: stuA1.id, status: 'present', note: 'Đi học đúng giờ' },
      { studentId: stuA2.id, status: 'late', note: 'Muộn 5 phút' },
    ]);
    await awardPoints({
      classId: classA.id,
      studentIds: [stuA1.id],
      customName: 'Phát biểu sôi nổi',
      delta: 3,
    });
    await awardPoints({
      classId: classA.id,
      studentIds: [stuA2.id],
      customName: 'Giữ vở sạch đẹp',
      delta: 2,
    });
    await saveComment(classA.id, {
      studentId: stuA1.id,
      date: '2026-10-25',
      session: 'all',
      content: 'Nhận xét NHÁP nội bộ của giáo viên (phụ huynh tuyệt đối không được thấy)',
      tags: ['Nháp'],
      status: 'draft',
    });
    await saveComment(classA.id, {
      studentId: stuA1.id,
      date: '2026-10-26',
      session: 'all',
      content: 'Con hăng hái phát biểu và lễ phép với thầy cô.',
      tags: ['Chăm ngoan'],
      status: 'sent',
    });
    await saveComment(classA.id, {
      studentId: stuA2.id,
      date: '2026-10-26',
      session: 'all',
      content: 'Nhận xét riêng của Khánh Linh.',
      tags: ['Tích cực'],
      status: 'sent',
    });

    // 2. Giáo viên B (khác lớp) cố tình tạo hoặc thu hồi mã mời cho học sinh của Giáo viên A -> BỊ CHẶN
    mockState.currentUserId = TEACHER_B_ID;
    await expect(getOrCreateParentLink(classA.id, stuA1.id)).rejects.toThrow(/Bạn không phải giáo viên phụ trách lớp/);
    await expect(revokeParentInvitationToken(linkA1.id)).rejects.toThrow(/Bạn không phải giáo viên phụ trách lớp/);

    // 3. Kiểm tra gọi chức năng sai vai trò (Role Enforcement):
    // - Giáo viên gọi claimParentInvitationToken hoặc fetchParentPortalData -> BỊ CHẶN
    await expect(claimParentInvitationToken(linkA1.issuedRawToken!)).rejects.toThrow(
      /Chức năng này chỉ dành cho tài khoản Phụ huynh/,
    );
    await expect(fetchParentPortalData()).rejects.toThrow(/Chức năng này chỉ dành cho tài khoản Phụ huynh/);

    // - Chưa đăng nhập gọi claimParentInvitationToken hoặc fetchParentPortalData -> BỊ CHẶN
    mockState.currentUserId = null;
    await expect(claimParentInvitationToken(linkA1.issuedRawToken!)).rejects.toThrow(/Chưa được xác thực/);
    await expect(fetchParentPortalData()).rejects.toThrow(/Chưa được xác thực/);

    // - Phụ huynh cố tình gọi getOrCreateParentLink / regenerateParentLink / revokeParentInvitationToken -> BỊ CHẶN
    mockState.currentUserId = PARENT_ID;
    await expect(getOrCreateParentLink(classA.id, stuA1.id)).rejects.toThrow(/Tài khoản phụ huynh không được phép/);
    await expect(regenerateParentLink(classA.id, stuA1.id)).rejects.toThrow(/Tài khoản phụ huynh không được phép/);
    await expect(revokeParentInvitationToken(linkA1.id)).rejects.toThrow(/Tài khoản phụ huynh không được phép/);

    // 4. Khi Phụ huynh 1 chưa kích hoạt mã mời -> fetchParentPortalData trả về mảng rỗng []
    expect(await fetchParentPortalData()).toEqual([]);

    // 5. Phụ huynh 1 kích hoạt mã mời của stuA1; Phụ huynh 2 kích hoạt mã mời của stuA2
    const claimRes1 = await claimParentInvitationToken(linkA1.issuedRawToken!);
    expect(claimRes1.ok).toBe(true);
    expect(claimRes1.studentId).toBe(stuA1.id);

    mockState.currentUserId = PARENT_2_ID;
    const claimRes2 = await claimParentInvitationToken(linkA2.issuedRawToken!);
    expect(claimRes2.ok).toBe(true);
    expect(claimRes2.studentId).toBe(stuA2.id);

    // 6. Phụ huynh 1 truy vấn Cổng Phụ Huynh -> CHỈ thấy stuA1, KHÔNG thấy stuA2, và CHỈ thấy nhận xét 'sent' (ẩn 'draft')
    mockState.currentUserId = PARENT_ID;
    const portalDataParent1 = await fetchParentPortalData();
    expect(portalDataParent1).toHaveLength(1);
    expect(portalDataParent1[0].student.id).toBe(stuA1.id);
    expect(portalDataParent1[0].student.fullName).toBe('Lê Hoàng Bách');
    expect(portalDataParent1[0].classInfo?.name).toBe('2A Cô Tiên');
    expect(portalDataParent1[0].attendance).toHaveLength(1);
    expect(portalDataParent1[0].attendance[0].status).toBe('present');
    expect(portalDataParent1[0].points).toHaveLength(1);
    expect(portalDataParent1[0].points[0].delta).toBe(3);
    expect(portalDataParent1[0].sentComments).toHaveLength(1);
    expect(portalDataParent1[0].sentComments[0].status).toBe('sent');
    expect(portalDataParent1[0].sentComments[0].content).toBe('Con hăng hái phát biểu và lễ phép với thầy cô.');

    // 7. Phụ huynh 2 truy vấn Cổng Phụ Huynh -> CHỈ thấy stuA2, tuyệt đối không thấy dữ liệu của stuA1
    mockState.currentUserId = PARENT_2_ID;
    const portalDataParent2 = await fetchParentPortalData();
    expect(portalDataParent2).toHaveLength(1);
    expect(portalDataParent2[0].student.id).toBe(stuA2.id);
    expect(portalDataParent2[0].student.fullName).toBe('Phạm Khánh Linh');
    expect(portalDataParent2[0].attendance).toHaveLength(1);
    expect(portalDataParent2[0].attendance[0].status).toBe('late');
    expect(portalDataParent2[0].points).toHaveLength(1);
    expect(portalDataParent2[0].points[0].delta).toBe(2);
    expect(portalDataParent2[0].sentComments).toHaveLength(1);
    expect(portalDataParent2[0].sentComments[0].content).toBe('Nhận xét riêng của Khánh Linh.');
  });
});
