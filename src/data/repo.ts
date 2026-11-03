import { db as legacyDb, ALL_TABLES, PinkDB, LEGACY_DB_NAME } from './db';
import type {
  ActivityLog,
  AppSettings,
  AttendanceRecord,
  AttendanceStatus,
  ClassRoom,
  Criterion,
  ParentLink,
  ParentPortalStudentData,
  PointTransaction,
  Session,
  Student,
  StudentComment,
  TodoTask,
  UserProfile,
  UserRole,
} from '../types';
import {
  isUUID,
  isValidISODate,
  isValidPhone,
  isoWeekNumber,
  normalizeVN,
  parseISODate,
  schoolYearOf,
  sha256,
  toISODate,
  uid,
  uuidv4,
} from '../lib/utils';
import { supabase } from '../lib/supabaseClient';
import type { User } from '@supabase/supabase-js';

/* =========================================================
 * Dynamic User Database Resolution (Giai đoạn 2.2 & 2.3B-2)
 * Cho phép repository chỉ ghi/đọc dữ liệu vào database riêng
 * của tài khoản giáo viên đã xác thực.
 * Cố định ngữ cảnh (database, userId, sessionVersion) chống race condition.
 * ========================================================= */

let activeDatabase: PinkDB | null = null;
let activeUserId: string | null = null;
let activeSessionVersion = 0;

export function setActiveDatabase(database: PinkDB | null, userId?: string | null): void {
  const nextUserId = userId ?? null;
  // Nếu database instance và userId không thay đổi, không tăng sessionVersion
  // để tránh làm hủy nhầm các tác vụ đồng bộ nền đang chạy của chính phiên làm việc này.
  if (activeDatabase === database && activeUserId === nextUserId) {
    return;
  }
  activeDatabase = database;
  activeUserId = nextUserId;
  activeSessionVersion++;
  if (!database) {
    invalidateAuthenticatedContextCache();
  }
}

export function getActiveDatabase(): PinkDB | null {
  return activeDatabase;
}

export function getActiveUserId(): string | null {
  return activeUserId;
}

export function getActiveSessionVersion(): number {
  return activeSessionVersion;
}

export interface OperationScope {
  db: PinkDB;
  userId: string | null;
  sessionVersion: number;
  assertActive: () => void;
}

/**
 * Cố định database và danh tính người dùng cho toàn bộ vòng đời của một thao tác.
 * Không tra lại dynamic proxy sau mỗi lệnh await, ngăn race condition ghi nhầm sang tài khoản khác.
 */
export function getOperationScope(targetDb?: PinkDB): OperationScope {
  if (targetDb) {
    if (targetDb.name === LEGACY_DB_NAME) {
      const env = typeof globalThis !== 'undefined' ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env : undefined;
      if (!env || env.NODE_ENV !== 'test' || env.STRICT_USER_DB) {
        throw new Error('Cảnh báo an toàn: Thao tác không được phép thực thi trên database legacy "pink-classroom".');
      }
    }
    const boundDb = targetDb;
    const boundUserId = activeUserId;
    const boundVersion = activeSessionVersion;
    return {
      db: boundDb,
      userId: boundUserId,
      sessionVersion: boundVersion,
      assertActive: () => {
        if (activeDatabase && boundDb !== activeDatabase) {
          throw new Error('Phiên làm việc đã thay đổi. Thao tác đã bị hủy an toàn để bảo vệ dữ liệu.');
        }
      },
    };
  }

  if (activeDatabase) {
    if (activeDatabase.name === LEGACY_DB_NAME) {
      throw new Error('Cảnh báo an toàn: Thao tác không được phép thực thi trên database legacy "pink-classroom".');
    }
    const boundDb = activeDatabase;
    const boundUserId = activeUserId;
    const boundVersion = activeSessionVersion;
    return {
      db: boundDb,
      userId: boundUserId,
      sessionVersion: boundVersion,
      assertActive: () => {
        // Chỉ hủy bỏ khi database thực sự bị đóng/thay đổi hoặc người dùng thực sự đã chuyển đổi danh tính/đăng xuất
        if (
          activeDatabase !== boundDb ||
          activeUserId !== boundUserId
        ) {
          throw new Error('Phiên làm việc đã thay đổi hoặc đã đăng xuất. Thao tác đã bị hủy an toàn để bảo vệ dữ liệu.');
        }
      },
    };
  }

  // Môi trường test cũ không có explicit activeDatabase (legacy unit tests)
  const env = typeof globalThis !== 'undefined' ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env : undefined;
  if (env?.NODE_ENV === 'test' && !env?.STRICT_USER_DB) {
    const boundDb = legacyDb;
    const boundVersion = activeSessionVersion;
    return {
      db: boundDb,
      userId: null,
      sessionVersion: boundVersion,
      assertActive: () => {
        if (activeDatabase !== null || activeSessionVersion !== boundVersion) {
          throw new Error('Phiên làm việc đã thay đổi. Thao tác đã bị hủy an toàn.');
        }
      },
    };
  }

  throw new Error('Chưa thiết lập database người dùng hoặc phiên đăng nhập chưa hợp lệ.');
}

export function getRepoDb(): PinkDB {
  return getOperationScope().db;
}

export const currentDbProxy = new Proxy({} as PinkDB, {
  get(_target, prop) {
    const targetDb = getRepoDb();
    const value = (targetDb as any)[prop];
    if (typeof value === 'function') {
      return value.bind(targetDb);
    }
    return value;
  },
});

/* =========================================================
 * Repository: lớp trung gian duy nhất ghi/đọc dữ liệu.
 * Hỗ trợ song song Offline (IndexedDB) và Cloud Sync (Supabase)
 * cho Bước 3.1 (Auth/Profile), 3.2 (Classes/Criteria),
 * 3.3 (Students/Memberships), 3.4 (Attendance/Points/Comments)
 * và 3.5 (Parent Invitation Tokens & Parent Portal).
 * ========================================================= */

export const CLOUD_SYNC_KV_KEY = 'cloud_synced_ids';
export const PENDING_SYNC_QUEUE_KEY = 'cloud_pending_sync_queue';

interface CloudSyncedIdsRecord {
  userId: string | null;
  classIds: string[];
  criterionIds: string[];
  studentIds: string[];
  attendanceIds: string[];
  transactionIds: string[];
  commentIds: string[];
  parentLinkIds: string[];
}

export type PendingSyncItem = (
  | {
      key: string;
      kind: 'attendance_upsert';
      classId: string;
      date: string;
      session: Session;
      createdAt: number;
    }
  | {
      key: string;
      kind: 'attendance_clear';
      classId: string;
      date: string;
      session: Session;
      createdAt: number;
    }
  | {
      key: string;
      kind: 'points_upsert';
      txId: string;
      createdAt: number;
    }
  | {
      key: string;
      kind: 'comment_upsert';
      commentId: string;
      createdAt: number;
    }
  | {
      key: string;
      kind: 'comment_delete';
      commentId: string;
      createdAt: number;
    }
) & {
  userId?: string;
  retryCount?: number;
  lastError?: string;
  status?: 'pending' | 'failed_auth' | 'quarantined';
};

export interface AuthenticatedContext {
  userId: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  phone?: string | null;
  avatarUrl?: string | null;
}

export function isNetworkOrOfflineError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string })?.code;
  if (code === 'NETWORK_ERROR' || code === 'FETCH_ERROR') return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('load failed') ||
    msg.includes('err_network') ||
    msg.includes('offline') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

export function isAuthOrPermissionError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: string; status?: number; statusCode?: number; message?: string };
  if (anyErr.status === 401 || anyErr.status === 403 || anyErr.statusCode === 401 || anyErr.statusCode === 403) {
    return true;
  }
  if (anyErr.code === '42501' || anyErr.code === 'PGRST301' || anyErr.code === '401' || anyErr.code === '403') {
    return true;
  }
  const msg = (anyErr.message ? String(anyErr.message) : err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('jwt') ||
    msg.includes('token') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('permission') ||
    msg.includes('not allowed') ||
    msg.includes('row-level security') ||
    msg.includes('rls') ||
    msg.includes('không có quyền') ||
    msg.includes('access denied') ||
    msg.includes('invalid claim')
  );
}

export async function verifyCurrentSupabaseSessionUser(expectedUserId: string | null): Promise<boolean> {
  if (!supabase) return false;
  if (!expectedUserId) return false;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data?.session?.user) return false;
    return data.session.user.id === expectedUserId;
  } catch {
    return false;
  }
}

function isLegacyTestMode(): boolean {
  const env =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env
      : undefined;
  return env?.NODE_ENV === 'test' && !env?.STRICT_USER_DB && activeDatabase === null;
}

export async function getPendingSyncQueue(targetDb?: PinkDB): Promise<PendingSyncItem[]> {
  const scope = getOperationScope(targetDb);
  const row = await scope.db.kv.get(PENDING_SYNC_QUEUE_KEY);
  return Array.isArray(row?.value) ? (row.value as PendingSyncItem[]) : [];
}

export async function savePendingSyncQueue(items: PendingSyncItem[], targetDb?: PinkDB): Promise<void> {
  const scope = getOperationScope(targetDb);
  await scope.db.kv.put({ key: PENDING_SYNC_QUEUE_KEY, value: items });
}

async function enqueuePendingSyncItem(
  item: PendingSyncItem,
  targetDb?: PinkDB,
  authorUserId?: string,
): Promise<void> {
  const scope = getOperationScope(targetDb);
  const cur = await getPendingSyncQueue(scope.db);
  const filtered = cur.filter((x) => x.key !== item.key);
  const boundUserId = item.userId ?? authorUserId ?? scope.userId ?? undefined;
  const boundItem: PendingSyncItem = {
    ...item,
    userId: boundUserId,
    retryCount: item.retryCount ?? 0,
    status: item.status ?? 'pending',
  };
  filtered.push(boundItem);
  await savePendingSyncQueue(filtered, scope.db);
}

async function getCloudSyncedRecord(targetDb?: PinkDB): Promise<CloudSyncedIdsRecord> {
  const scope = getOperationScope(targetDb);
  const row = await scope.db.kv.get(CLOUD_SYNC_KV_KEY);
  const val = row?.value as Partial<CloudSyncedIdsRecord> | undefined;
  return {
    userId: val?.userId ?? null,
    classIds: Array.isArray(val?.classIds) ? val.classIds : [],
    criterionIds: Array.isArray(val?.criterionIds) ? val.criterionIds : [],
    studentIds: Array.isArray(val?.studentIds) ? val.studentIds : [],
    attendanceIds: Array.isArray(val?.attendanceIds) ? val.attendanceIds : [],
    transactionIds: Array.isArray(val?.transactionIds) ? val.transactionIds : [],
    commentIds: Array.isArray(val?.commentIds) ? val.commentIds : [],
    parentLinkIds: Array.isArray(val?.parentLinkIds) ? val.parentLinkIds : [],
  };
}

async function saveCloudSyncedRecord(rec: CloudSyncedIdsRecord, targetDb?: PinkDB): Promise<void> {
  const scope = getOperationScope(targetDb);
  await scope.db.kv.put({
    key: CLOUD_SYNC_KV_KEY,
    value: {
      userId: rec.userId,
      classIds: Array.from(new Set(rec.classIds)),
      criterionIds: Array.from(new Set(rec.criterionIds)),
      studentIds: Array.from(new Set(rec.studentIds)),
      attendanceIds: Array.from(new Set(rec.attendanceIds)),
      transactionIds: Array.from(new Set(rec.transactionIds)),
      commentIds: Array.from(new Set(rec.commentIds)),
      parentLinkIds: Array.from(new Set(rec.parentLinkIds)),
    },
  });
}

export async function trackCloudIds(
  userId: string,
  patch: {
    classIds?: string[];
    criterionIds?: string[];
    studentIds?: string[];
    attendanceIds?: string[];
    transactionIds?: string[];
    commentIds?: string[];
    parentLinkIds?: string[];
  },
  targetDb?: PinkDB,
) {
  const scope = getOperationScope(targetDb);
  scope.assertActive();
  const cur = await getCloudSyncedRecord(scope.db);
  scope.assertActive();
  await saveCloudSyncedRecord({
    userId,
    classIds: [...cur.classIds, ...(patch.classIds ?? [])],
    criterionIds: [...cur.criterionIds, ...(patch.criterionIds ?? [])],
    studentIds: [...cur.studentIds, ...(patch.studentIds ?? [])],
    attendanceIds: [...cur.attendanceIds, ...(patch.attendanceIds ?? [])],
    transactionIds: [...cur.transactionIds, ...(patch.transactionIds ?? [])],
    commentIds: [...cur.commentIds, ...(patch.commentIds ?? [])],
    parentLinkIds: [...cur.parentLinkIds, ...(patch.parentLinkIds ?? [])],
  }, scope.db);
}

let cachedAuthContext: { ctx: AuthenticatedContext; timestamp: number } | null = null;

export function invalidateAuthenticatedContextCache(): void {
  cachedAuthContext = null;
}

/**
 * Lấy thông tin phiên đăng nhập và hồ sơ phân quyền từ bảng public.profiles.
 * Trả về null nếu người dùng đang dùng chế độ Offline (chưa đăng nhập Supabase).
 * Tối ưu hóa: Sử dụng in-memory cache (TTL 15s) tránh gửi lặp lại nhiều query đến Supabase.
 */
export async function getAuthenticatedContext(explicitUser?: User | null): Promise<AuthenticatedContext | null> {
  if (!supabase) return null;

  let user: User | null = explicitUser ?? null;
  if (!user) {
    const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
    if (sessionErr || !sessionData?.session?.user) {
      cachedAuthContext = null;
      return null;
    }
    user = sessionData.session.user;
  }

  if (cachedAuthContext && cachedAuthContext.ctx.userId === user.id && Date.now() - cachedAuthContext.timestamp < 15000) {
    return cachedAuthContext.ctx;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) => {
    timer = setTimeout(() => resolve({ data: null, error: new Error('Hết thời gian chờ tải hồ sơ') }), 5000);
  });

  const queryPromise = supabase
    .from('profiles')
    .select('id, email, full_name, role, phone, avatar_url')
    .eq('id', user.id)
    .maybeSingle();

  const { data: profile, error: profileErr } = await Promise.race([queryPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  if (profileErr || !profile) {
    return null;
  }

  const result: AuthenticatedContext = {
    userId: profile.id,
    email: profile.email ?? user.email ?? null,
    fullName: profile.full_name || 'Người dùng',
    role: profile.role as UserRole,
    phone: profile.phone ?? null,
    avatarUrl: profile.avatar_url ?? null,
  };

  cachedAuthContext = {
    ctx: result,
    timestamp: Date.now(),
  };

  return result;
}

/**
 * Kiểm tra quyền ghi của giáo viên/admin khi đã đăng nhập Supabase.
 * - Nếu chưa đăng nhập (Offline): trả về null (cho phép ghi vào IndexedDB cục bộ).
 * - Nếu đăng nhập với role = 'parent': chặn thao tác ghi của giáo viên.
 * - Nếu đăng nhập với role = 'teacher' | 'admin': trả về context để đồng bộ Supabase.
 */
async function requireTeacherOrOfflineContext(): Promise<AuthenticatedContext | null> {
  const ctx = await getAuthenticatedContext();
  if (!ctx) return null;
  if (ctx.role !== 'teacher' && ctx.role !== 'admin') {
    throw new Error('Quyền bị từ chối: Tài khoản phụ huynh không được phép tạo hoặc chỉnh sửa dữ liệu lớp học.');
  }
  return ctx;
}

/**
 * Đọc hồ sơ người dùng hiện tại dưới dạng UserProfile.
 */
export async function getCurrentUserProfile(explicitUser?: User | null): Promise<UserProfile | null> {
  const ctx = await getAuthenticatedContext(explicitUser);
  if (!ctx) return null;
  return {
    id: ctx.userId,
    email: ctx.email,
    fullName: ctx.fullName,
    role: ctx.role,
    phone: ctx.phone,
    avatarUrl: ctx.avatarUrl,
  };
}

/**
 * Xóa các bản ghi đã từng đồng bộ từ tài khoản Cloud khỏi bộ nhớ đệm IndexedDB
 * (khi đăng xuất hoặc chuyển tài khoản), nhưng GIỮ NGUYÊN 100% dữ liệu Offline cục bộ
 * và BẢO TOÀN toàn bộ các bản ghi đang có thay đổi chờ đồng bộ trong cloud_pending_sync_queue.
 */
export async function clearSyncedCloudCacheFromLocal(targetDb?: PinkDB): Promise<void> {
  invalidateAuthenticatedContextCache();
  let scope: OperationScope;
  try {
    scope = getOperationScope(targetDb);
  } catch {
    // Nếu không có database người dùng hợp lệ nào đang hoạt động, an toàn bỏ qua
    return;
  }

  // 1. Đọc hàng đợi đồng bộ đang chờ (cloud_pending_sync_queue)
  // Tuyệt đối không xóa bất kỳ bản ghi nào đang có thay đổi chờ đồng bộ lên Cloud!
  const pendingQueue = await getPendingSyncQueue(scope.db);
  const pendingTxIds = new Set(
    pendingQueue
      .filter((i): i is Extract<PendingSyncItem, { kind: 'points_upsert' }> => i.kind === 'points_upsert')
      .map((i) => i.txId),
  );
  const pendingCommentIds = new Set(
    pendingQueue
      .filter((i): i is Extract<PendingSyncItem, { kind: 'comment_upsert' | 'comment_delete' }> => i.kind === 'comment_upsert' || i.kind === 'comment_delete')
      .map((i) => i.commentId),
  );
  const pendingAttendanceSlotKeys = new Set(
    pendingQueue
      .filter((i): i is Extract<PendingSyncItem, { kind: 'attendance_upsert' | 'attendance_clear' }> => i.kind === 'attendance_upsert' || i.kind === 'attendance_clear')
      .map((i) => `${i.classId}|${i.date}|${i.session}`),
  );
  const pendingClassIds = new Set<string>();
  for (const item of pendingQueue) {
    if ('classId' in item && typeof item.classId === 'string') {
      pendingClassIds.add(item.classId);
    }
  }

  const prev = await getCloudSyncedRecord(scope.db);

  // Chỉ dọn các bản ghi được xác định chắc chắn là cache Cloud CÓ THỂ TÁI TẠO từ Supabase (không có pending modifications)
  const removedTransactionIds = prev.transactionIds.filter((id) => !pendingTxIds.has(id));
  const remainingTransactionIds = prev.transactionIds.filter((id) => pendingTxIds.has(id));

  const removedCommentIds = prev.commentIds.filter((id) => !pendingCommentIds.has(id));
  const remainingCommentIds = prev.commentIds.filter((id) => pendingCommentIds.has(id));

  const removedAttendanceIds = prev.attendanceIds.filter((id) => {
    const slotKey = id.split('|').slice(0, 3).join('|');
    return !pendingAttendanceSlotKeys.has(slotKey);
  });
  const remainingAttendanceIds = prev.attendanceIds.filter((id) => {
    const slotKey = id.split('|').slice(0, 3).join('|');
    return pendingAttendanceSlotKeys.has(slotKey);
  });

  // Nếu lớp học có chứa pending transactions/comments/attendance, giữ lại lớp học đó để không làm mồ côi dữ liệu chờ
  const removedClassIds = prev.classIds.filter((id) => !pendingClassIds.has(id));
  const remainingClassIds = prev.classIds.filter((id) => pendingClassIds.has(id));

  // Tương tự, nếu học sinh có giao dịch hoặc điểm danh đang chờ, không xóa học sinh đó
  const activeStudentIdsWithPending = new Set<string>();
  if (pendingQueue.length > 0) {
    if (remainingTransactionIds.length > 0) {
      const remainingTxRows = await scope.db.transactions.bulkGet(remainingTransactionIds);
      for (const tx of remainingTxRows) {
        if (tx?.studentId) activeStudentIdsWithPending.add(tx.studentId);
      }
    }
    for (const attId of remainingAttendanceIds) {
      const parts = attId.split('|');
      if (parts[3]) activeStudentIdsWithPending.add(parts[3]);
    }
  }

  const removedStudentIds = prev.studentIds.filter((id) => !activeStudentIdsWithPending.has(id));
  const remainingStudentIds = prev.studentIds.filter((id) => activeStudentIdsWithPending.has(id));

  // Criteria và parent links là cache Cloud có thể tái tạo hoàn toàn
  const removedCriterionIds = prev.criterionIds;
  const removedParentLinkIds = prev.parentLinkIds;

  const hasAnyToRemove =
    removedClassIds.length > 0 ||
    removedCriterionIds.length > 0 ||
    removedStudentIds.length > 0 ||
    removedAttendanceIds.length > 0 ||
    removedTransactionIds.length > 0 ||
    removedCommentIds.length > 0 ||
    removedParentLinkIds.length > 0;

  if (!hasAnyToRemove) {
    if (
      prev.userId &&
      remainingTransactionIds.length === 0 &&
      remainingCommentIds.length === 0 &&
      remainingAttendanceIds.length === 0 &&
      remainingClassIds.length === 0 &&
      remainingStudentIds.length === 0
    ) {
      await saveCloudSyncedRecord(
        {
          userId: null,
          classIds: [],
          criterionIds: [],
          studentIds: [],
          attendanceIds: [],
          transactionIds: [],
          commentIds: [],
          parentLinkIds: [],
        },
        scope.db,
      );
    }
    return;
  }

  scope.assertActive();
  await scope.db.transaction(
    'rw',
    [
      scope.db.classes,
      scope.db.criteria,
      scope.db.students,
      scope.db.attendance,
      scope.db.transactions,
      scope.db.comments,
      scope.db.parentLinks,
      scope.db.kv,
    ],
    async () => {
      if (removedClassIds.length) await scope.db.classes.bulkDelete(removedClassIds);
      if (removedCriterionIds.length) await scope.db.criteria.bulkDelete(removedCriterionIds);
      if (removedStudentIds.length) await scope.db.students.bulkDelete(removedStudentIds);
      if (removedAttendanceIds.length) await scope.db.attendance.bulkDelete(removedAttendanceIds);
      if (removedTransactionIds.length) await scope.db.transactions.bulkDelete(removedTransactionIds);
      if (removedCommentIds.length) await scope.db.comments.bulkDelete(removedCommentIds);
      if (removedParentLinkIds.length) await scope.db.parentLinks.bulkDelete(removedParentLinkIds);

      await scope.db.kv.put({
        key: CLOUD_SYNC_KV_KEY,
        value: {
          userId: prev.userId,
          classIds: remainingClassIds,
          criterionIds: [],
          studentIds: remainingStudentIds,
          attendanceIds: remainingAttendanceIds,
          transactionIds: remainingTransactionIds,
          commentIds: remainingCommentIds,
          parentLinkIds: [],
        },
      });
    },
  );
}

/**
 * Đẩy các thao tác đang chờ trong hàng đợi Offline (cloud_pending_sync_queue) lên Supabase.
 * Thực thi idempotent bằng khóa duy nhất / khóa chính UUID để không tạo bản ghi trùng lặp.
 */
export async function flushPendingSyncQueue(targetDb?: PinkDB): Promise<{
  flushedCount: number;
  remainingCount: number;
}> {
  const scope = getOperationScope(targetDb);
  if (!supabase) return { flushedCount: 0, remainingCount: (await getPendingSyncQueue(scope.db)).length };
  const ctx = await getAuthenticatedContext();
  try {
    scope.assertActive();
  } catch {
    return { flushedCount: 0, remainingCount: (await getPendingSyncQueue(scope.db)).length };
  }
  if (!ctx || (ctx.role !== 'teacher' && ctx.role !== 'admin')) {
    return { flushedCount: 0, remainingCount: (await getPendingSyncQueue(scope.db)).length };
  }

  // Xác minh phiên làm việc: database của scope phải khớp với danh tính ctx
  const effectiveUserId = scope.userId ?? (isLegacyTestMode() ? ctx.userId : null);
  if (!effectiveUserId || ctx.userId !== effectiveUserId) {
    return { flushedCount: 0, remainingCount: (await getPendingSyncQueue(scope.db)).length };
  }

  const queue = await getPendingSyncQueue(scope.db);
  if (!queue.length) return { flushedCount: 0, remainingCount: 0 };

  const remaining: PendingSyncItem[] = [];
  let flushedCount = 0;
  let sessionAborted = false;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];

    // Nếu đã phát hiện phiên đổi giữa các tab, bảo toàn toàn bộ mục còn lại và dừng
    if (sessionAborted) {
      remaining.push(item);
      continue;
    }

    scope.assertActive();

    // 1. Kiểm tra chủ sở hữu của mục:
    // Nếu item có userId và không khớp với effectiveUserId -> cách ly
    if (item.userId && item.userId !== effectiveUserId) {
      remaining.push({
        ...item,
        status: 'quarantined',
        lastError: `Chủ sở hữu mục (${item.userId}) không khớp với tài khoản hiện hành (${effectiveUserId}).`,
      });
      continue;
    }

    // Nếu item chưa có userId (mục cũ / legacy):
    // Giữ nguyên và cách ly; không tự gán chủ sở hữu, gửi lên Cloud hoặc xóa.
    if (!item.userId) {
      if (isLegacyTestMode()) {
        item.userId = effectiveUserId;
      } else {
        remaining.push({
          ...item,
          status: 'quarantined',
          lastError: 'Mục hàng đợi cũ chưa xác định chủ sở hữu (cần quy trình di trú an toàn).',
        });
        continue;
      }
    }

    // 2. Không tự động retry vô hạn khi gặp lỗi xác thực
    if (item.status === 'failed_auth') {
      remaining.push(item);
      continue;
    }

    // 3. Kiểm tra danh tính phiên Supabase trước khi gửi (Multi-tab protection)
    const validPre = await verifyCurrentSupabaseSessionUser(effectiveUserId);
    if (!validPre) {
      sessionAborted = true;
      remaining.push(item);
      continue;
    }

    try {
      if (item.kind === 'attendance_upsert') {
        const localRows = await scope.db.attendance
          .where('[classId+date+session]')
          .equals([item.classId, item.date, item.session])
          .toArray();
        scope.assertActive();
        const validRows = localRows.filter((r) => isUUID(r.classId) && isUUID(r.studentId));
        if (validRows.length > 0) {
          const payload = validRows.map((r) => ({
            class_id: r.classId,
            student_id: r.studentId,
            date: r.date,
            session: r.session,
            status: r.status,
            note: r.note ?? null,
            recorded_by: effectiveUserId,
            updated_at: new Date(r.updatedAt).toISOString(),
          }));
          const { data: upserted, error } = await supabase
            .from('attendance')
            .upsert(payload, { onConflict: 'class_id,student_id,date,session' })
            .select('id');
          scope.assertActive();

          // Kiểm tra lại phiên Supabase sau khi chờ mạng (phát hiện tab khác đổi phiên trong lúc request đang bay)
          const validPost = await verifyCurrentSupabaseSessionUser(effectiveUserId);
          if (!validPost) {
            sessionAborted = true;
            remaining.push(item);
            continue;
          }

          if (error) {
            if (isNetworkOrOfflineError(error)) {
              remaining.push({
                ...item,
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            if (isAuthOrPermissionError(error)) {
              remaining.push({
                ...item,
                status: 'failed_auth',
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            throw new Error(error.message);
          }
          if (!upserted || upserted.length !== validRows.length) {
            throw new Error('Không có quyền đồng bộ điểm danh.');
          }
          await trackCloudIds(effectiveUserId, { attendanceIds: validRows.map((r) => r.id) }, scope.db);
          flushedCount++;
        }
      } else if (item.kind === 'attendance_clear') {
        if (isUUID(item.classId)) {
          const { error } = await supabase
            .from('attendance')
            .delete()
            .eq('class_id', item.classId)
            .eq('date', item.date)
            .eq('session', item.session);
          scope.assertActive();

          const validPost = await verifyCurrentSupabaseSessionUser(effectiveUserId);
          if (!validPost) {
            sessionAborted = true;
            remaining.push(item);
            continue;
          }

          if (error) {
            if (isNetworkOrOfflineError(error)) {
              remaining.push({
                ...item,
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            if (isAuthOrPermissionError(error)) {
              remaining.push({
                ...item,
                status: 'failed_auth',
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            throw new Error(error.message);
          }
          flushedCount++;
        }
      } else if (item.kind === 'points_upsert') {
        const tx = await scope.db.transactions.get(item.txId);
        scope.assertActive();
        if (tx && isUUID(tx.id) && isUUID(tx.classId) && isUUID(tx.studentId) && isUUID(tx.batchId)) {
          const { data: upserted, error } = await supabase
            .from('student_points')
            .upsert(
              {
                id: tx.id,
                class_id: tx.classId,
                student_id: tx.studentId,
                criterion_id: tx.criterionId && isUUID(tx.criterionId) ? tx.criterionId : null,
                criterion_name: tx.criterionName,
                delta: tx.delta,
                note: tx.note ?? null,
                actor_id: effectiveUserId,
                batch_id: tx.batchId,
                undone: Boolean(tx.undone),
                undone_at: tx.undone && tx.undoneAt ? new Date(tx.undoneAt).toISOString() : null,
                created_at: new Date(tx.createdAt).toISOString(),
                source_id: tx.id,
              },
              { onConflict: 'id' },
            )
            .select('id');
          scope.assertActive();

          const validPost = await verifyCurrentSupabaseSessionUser(effectiveUserId);
          if (!validPost) {
            sessionAborted = true;
            remaining.push(item);
            continue;
          }

          if (error) {
            if (isNetworkOrOfflineError(error)) {
              remaining.push({
                ...item,
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            if (error.code === '23505') {
              const { data: exPoint } = await supabase
                .from('student_points')
                .select('id')
                .or(`id.eq.${tx.id},source_id.eq.${tx.id}`)
                .maybeSingle();
              scope.assertActive();
              if (exPoint) {
                await trackCloudIds(effectiveUserId, { transactionIds: [tx.id] }, scope.db);
                flushedCount++;
                continue;
              }
            }
            if (isAuthOrPermissionError(error)) {
              remaining.push({
                ...item,
                status: 'failed_auth',
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            throw new Error(error.message);
          }
          if (!upserted || upserted.length === 0) {
            throw new Error('Không có quyền đồng bộ giao dịch điểm.');
          }
          await trackCloudIds(effectiveUserId, { transactionIds: [tx.id] }, scope.db);
          flushedCount++;
        }
      } else if (item.kind === 'comment_upsert') {
        const cmt = await scope.db.comments.get(item.commentId);
        scope.assertActive();
        if (cmt && isUUID(cmt.id) && isUUID(cmt.classId) && isUUID(cmt.studentId)) {
          const cls = await scope.db.classes.get(cmt.classId);
          scope.assertActive();
          const schoolYear = cls?.schoolYear || schoolYearOf(parseISODate(cmt.date));
          const weekNumber = isoWeekNumber(cmt.date);
          const status = cmt.status ?? 'sent';
          const { data: upserted, error } = await supabase
            .from('weekly_comments')
            .upsert(
              {
                id: cmt.id,
                class_id: cmt.classId,
                student_id: cmt.studentId,
                week_number: weekNumber,
                school_year: schoolYear,
                date: cmt.date,
                content: cmt.content,
                status,
                sent_at: status === 'sent' ? new Date(cmt.sentAt ?? cmt.updatedAt).toISOString() : null,
                teacher_id: effectiveUserId,
                tags: cmt.tags ?? [],
                created_at: new Date(cmt.createdAt).toISOString(),
                updated_at: new Date(cmt.updatedAt).toISOString(),
              },
              { onConflict: 'id' },
            )
            .select('id');
          scope.assertActive();

          const validPost = await verifyCurrentSupabaseSessionUser(effectiveUserId);
          if (!validPost) {
            sessionAborted = true;
            remaining.push(item);
            continue;
          }

          if (error) {
            if (isNetworkOrOfflineError(error)) {
              remaining.push({
                ...item,
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            if (isAuthOrPermissionError(error)) {
              remaining.push({
                ...item,
                status: 'failed_auth',
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            throw new Error(error.message);
          }
          if (!upserted || upserted.length === 0) {
            throw new Error('Không có quyền đồng bộ nhận xét.');
          }
          await trackCloudIds(effectiveUserId, { commentIds: [cmt.id] }, scope.db);
          flushedCount++;
        }
      } else if (item.kind === 'comment_delete') {
        if (isUUID(item.commentId)) {
          const { error } = await supabase.from('weekly_comments').delete().eq('id', item.commentId);
          scope.assertActive();

          const validPost = await verifyCurrentSupabaseSessionUser(effectiveUserId);
          if (!validPost) {
            sessionAborted = true;
            remaining.push(item);
            continue;
          }

          if (error) {
            if (isNetworkOrOfflineError(error)) {
              remaining.push({
                ...item,
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            if (isAuthOrPermissionError(error)) {
              remaining.push({
                ...item,
                status: 'failed_auth',
                retryCount: (item.retryCount ?? 0) + 1,
                lastError: error.message,
              });
              continue;
            }
            throw new Error(error.message);
          }
          flushedCount++;
        }
      }
    } catch (err) {
      if (isAuthOrPermissionError(err)) {
        remaining.push({
          ...item,
          status: 'failed_auth',
          retryCount: (item.retryCount ?? 0) + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
      } else {
        remaining.push({
          ...item,
          retryCount: (item.retryCount ?? 0) + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Đảm bảo lưu lại các mục còn lại vào đúng scope.db
  try {
    scope.assertActive();
    await savePendingSyncQueue(remaining, scope.db);
  } catch {
    // Nếu phiên thay đổi khiến assertActive fail, cố gắng lưu trực tiếp vào scope.db ban đầu
    try {
      await scope.db.kv.put({ key: PENDING_SYNC_QUEUE_KEY, value: remaining });
    } catch {
      // ignore
    }
  }

  return { flushedCount, remainingCount: remaining.length };
}

/**
 * Đồng bộ chiều về (Pull Sync) cho Lớp học, Tiêu chí, Học sinh (qua class_memberships),
 * Điểm danh, Điểm thi đua và Nhận xét tuần từ Supabase về IndexedDB,
 * bảo toàn toàn bộ dữ liệu Offline hiện có.
 */
export async function syncClassesAndStudentsFromSupabase(
  options?: { autoFlush?: boolean },
  targetDb?: PinkDB,
): Promise<{
  synced: boolean;
  classesCount: number;
  criteriaCount: number;
  studentsCount: number;
  attendanceCount?: number;
  transactionsCount?: number;
  commentsCount?: number;
}> {
  const scope = getOperationScope(targetDb);
  if (!supabase) {
    return {
      synced: false,
      classesCount: 0,
      criteriaCount: 0,
      studentsCount: 0,
      attendanceCount: 0,
      transactionsCount: 0,
      commentsCount: 0,
    };
  }

  const ctx = await getAuthenticatedContext();
  scope.assertActive();
  if (!ctx) {
    // Không xóa dữ liệu cục bộ khi mất mạng hoặc không thể tải hồ sơ tạm thời,
    // đảm bảo tính bền vững Offline-First cho ứng dụng.
    return {
      synced: false,
      classesCount: 0,
      criteriaCount: 0,
      studentsCount: 0,
      attendanceCount: 0,
      transactionsCount: 0,
      commentsCount: 0,
    };
  }

  if (ctx.role !== 'teacher' && ctx.role !== 'admin') {
    // Chỉ dọn cache lớp học của giáo viên khi đã xác minh người dùng hiện tại có vai trò khác (ví dụ: phụ huynh)
    await clearSyncedCloudCacheFromLocal(scope.db);
    return {
      synced: false,
      classesCount: 0,
      criteriaCount: 0,
      studentsCount: 0,
      attendanceCount: 0,
      transactionsCount: 0,
      commentsCount: 0,
    };
  }

  // Đẩy các thao tác đang chờ trong hàng đợi Offline lên Cloud (chỉ khi được yêu cầu tường minh, không tự động khi init/switch)
  if (options?.autoFlush) {
    await flushPendingSyncQueue(scope.db);
    scope.assertActive();
  }
  const pendingQueue = await getPendingSyncQueue(scope.db);
  const pendingTxIds = new Set(
    pendingQueue.filter((i): i is Extract<PendingSyncItem, { kind: 'points_upsert' }> => i.kind === 'points_upsert').map((i) => i.txId),
  );
  const pendingCommentIds = new Set(
    pendingQueue
      .filter((i): i is Extract<PendingSyncItem, { kind: 'comment_upsert' }> => i.kind === 'comment_upsert')
      .map((i) => i.commentId),
  );
  const pendingAttendanceSlotKeys = new Set(
    pendingQueue
      .filter((i): i is Extract<PendingSyncItem, { kind: 'attendance_upsert' }> => i.kind === 'attendance_upsert')
      .map((i) => `${i.classId}|${i.date}|${i.session}`),
  );

  let classesQuery = supabase
    .from('classes')
    .select('id, name, school_year, teacher_id, subject, note, color, created_at, updated_at')
    .order('created_at', { ascending: true });

  if (ctx.role === 'teacher') {
    classesQuery = classesQuery.eq('teacher_id', ctx.userId);
  }

  const { data: cloudClasses, error: clsErr } = await classesQuery;
  scope.assertActive();
  if (clsErr) throw new Error(`Lỗi tải danh sách lớp từ Supabase: ${clsErr.message}`);

  const classIds = (cloudClasses ?? []).map((c) => c.id as string);

  // Tối ưu hóa: Chạy song song 6 bảng phụ thuộc classIds bằng Promise.all thay vì tuần tự
  const [
    criteriaRes,
    membershipsRes,
    attendanceRes,
    pointsRes,
    commentsRes,
    tokensRes,
  ] = await Promise.all([
    classIds.length
      ? supabase
          .from('criteria')
          .select('id, class_id, name, points, type, icon, display_order, archived, created_at')
          .in('class_id', classIds)
      : Promise.resolve({ data: [], error: null }),
    classIds.length
      ? supabase
          .from('class_memberships')
          .select('class_id, student_id, is_active, created_at')
          .in('class_id', classIds)
          .eq('is_active', true)
      : Promise.resolve({ data: [], error: null }),
    classIds.length
      ? supabase
          .from('attendance')
          .select('id, class_id, student_id, date, session, status, note, recorded_by, updated_at')
          .in('class_id', classIds)
      : Promise.resolve({ data: [], error: null }),
    classIds.length
      ? supabase
          .from('student_points')
          .select(
            'id, class_id, student_id, criterion_id, criterion_name, delta, note, actor_id, batch_id, undone, undone_at, created_at',
          )
          .in('class_id', classIds)
      : Promise.resolve({ data: [], error: null }),
    classIds.length
      ? supabase
          .from('weekly_comments')
          .select(
            'id, class_id, student_id, week_number, school_year, date, content, status, sent_at, teacher_id, tags, created_at, updated_at',
          )
          .in('class_id', classIds)
      : Promise.resolve({ data: [], error: null }),
    classIds.length
      ? supabase
          .from('parent_invitation_tokens')
          .select(
            'id, class_id, student_id, token_hash, parent_phone, expires_at, is_revoked, revoked_at, used_at, used_by, created_at, updated_at',
          )
          .in('class_id', classIds)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  scope.assertActive();

  if (criteriaRes.error) throw new Error(`Lỗi tải tiêu chí từ Supabase: ${criteriaRes.error.message}`);
  if (membershipsRes.error) throw new Error(`Lỗi tải liên kết lớp từ Supabase: ${membershipsRes.error.message}`);
  if (attendanceRes.error) throw new Error(`Lỗi tải điểm danh từ Supabase: ${attendanceRes.error.message}`);
  if (pointsRes.error) throw new Error(`Lỗi tải điểm thi đua từ Supabase: ${pointsRes.error.message}`);
  if (commentsRes.error) throw new Error(`Lỗi tải nhận xét tuần từ Supabase: ${commentsRes.error.message}`);
  if (tokensRes.error) throw new Error(`Lỗi tải mã mời phụ huynh từ Supabase: ${tokensRes.error.message}`);

  const cloudCriteria = criteriaRes.data;
  const cloudMemberships = membershipsRes.data;
  const cloudAttendance = attendanceRes.data;
  const cloudPoints = pointsRes.data;
  const cloudComments = commentsRes.data;
  const cloudTokens = tokensRes.data;

  const studentToClassMap = new Map<string, string>();
  for (const m of cloudMemberships ?? []) {
    studentToClassMap.set(m.student_id as string, m.class_id as string);
  }

  const studentIds = Array.from(studentToClassMap.keys());

  // Tối ưu hóa: Chạy song song students và parent_students
  const [studentsRes, parentStudentsRes] = await Promise.all([
    studentIds.length
      ? supabase
          .from('students')
          .select(
            'id, code, full_name, birth_date, gender, avatar, note, parent_name, parent_phone, status, created_at, updated_at',
          )
          .in('id', studentIds)
      : Promise.resolve({ data: [], error: null }),
    studentIds.length
      ? supabase
          .from('parent_students')
          .select('student_id, parent_id, is_verified')
          .in('student_id', studentIds)
          .eq('is_verified', true)
      : Promise.resolve({ data: [], error: null }),
  ]);
  scope.assertActive();

  if (studentsRes.error) throw new Error(`Lỗi tải danh sách học sinh từ Supabase: ${studentsRes.error.message}`);
  if (parentStudentsRes.error) throw new Error(`Lỗi tải trạng thái liên kết phụ huynh từ Supabase: ${parentStudentsRes.error.message}`);

  const cloudStudents = studentsRes.data;
  const cloudParentStudents = parentStudentsRes.data;

  const verifiedStudentSet = new Set<string>(
    (cloudParentStudents ?? []).map((ps) => ps.student_id as string),
  );

  const existingLocalClasses = await scope.db.classes.bulkGet(classIds);
  const existingTeacherNameById = new Map<string, string>();
  for (const lc of existingLocalClasses) {
    if (lc?.id && lc.teacherName) existingTeacherNameById.set(lc.id, lc.teacherName);
  }
  const defaultTeacherLabel = await actorName(scope.db);

  const mappedClasses: ClassRoom[] = (cloudClasses ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    schoolYear: c.school_year as string,
    teacherName: existingTeacherNameById.get(c.id as string) || ctx.fullName || defaultTeacherLabel,
    subject: (c.subject as string | null) ?? undefined,
    note: (c.note as string | null) ?? undefined,
    color: (c.color as string) || '#F7A8C4',
    createdAt: c.created_at ? new Date(c.created_at as string).getTime() : Date.now(),
    updatedAt: c.updated_at ? new Date(c.updated_at as string).getTime() : Date.now(),
  }));

  const mappedCriteria: Criterion[] = (cloudCriteria ?? []).map((cr) => ({
    id: cr.id as string,
    classId: cr.class_id as string,
    name: cr.name as string,
    points: Number(cr.points),
    type: cr.type as Criterion['type'],
    icon: (cr.icon as string) || 'star',
    order: Number(cr.display_order ?? 0),
    archived: Boolean(cr.archived),
    createdAt: cr.created_at ? new Date(cr.created_at as string).getTime() : Date.now(),
  }));

  const mappedStudents: Student[] = [];
  for (const s of cloudStudents ?? []) {
    const cId = studentToClassMap.get(s.id as string);
    if (!cId) continue;
    mappedStudents.push({
      id: s.id as string,
      classId: cId,
      code: s.code as string,
      fullName: s.full_name as string,
      birthDate: (s.birth_date as string | null) ?? undefined,
      gender: ((s.gender as Student['gender'] | null) ?? '') as Student['gender'],
      avatar: (s.avatar as string) || 'cat-pink',
      parentName: (s.parent_name as string | null) ?? undefined,
      parentPhone: (s.parent_phone as string | null) ?? undefined,
      note: (s.note as string | null) ?? undefined,
      status: ((s.status as Student['status']) || 'active') as Student['status'],
      createdAt: s.created_at ? new Date(s.created_at as string).getTime() : Date.now(),
      updatedAt: s.updated_at ? new Date(s.updated_at as string).getTime() : Date.now(),
    });
  }

  const mappedAttendance: AttendanceRecord[] = [];
  for (const a of cloudAttendance ?? []) {
    const sess = ((a.session as string) === 'afternoon' ? 'afternoon' : 'morning') as Session;
    const slotKey = `${a.class_id as string}|${a.date as string}|${sess}`;
    if (pendingAttendanceSlotKeys.has(slotKey)) continue;
    mappedAttendance.push({
      id: attendanceId(a.class_id as string, a.date as string, sess, a.student_id as string),
      classId: a.class_id as string,
      studentId: a.student_id as string,
      date: a.date as string,
      session: sess,
      status: (a.status as AttendanceStatus) || 'present',
      note: (a.note as string | null) ?? undefined,
      updatedAt: a.updated_at ? new Date(a.updated_at as string).getTime() : Date.now(),
    });
  }

  const mappedTransactions: PointTransaction[] = [];
  for (const p of cloudPoints ?? []) {
    if (pendingTxIds.has(p.id as string)) continue;
    mappedTransactions.push({
      id: p.id as string,
      classId: p.class_id as string,
      studentId: p.student_id as string,
      criterionId: (p.criterion_id as string | null) ?? null,
      criterionName: p.criterion_name as string,
      delta: Number(p.delta),
      note: (p.note as string | null) ?? undefined,
      actor: existingTeacherNameById.get(p.class_id as string) || ctx.fullName || defaultTeacherLabel,
      batchId: p.batch_id as string,
      createdAt: p.created_at ? new Date(p.created_at as string).getTime() : Date.now(),
      undone: Boolean(p.undone),
      undoneAt: p.undone_at ? new Date(p.undone_at as string).getTime() : undefined,
    });
  }

  const mappedComments: StudentComment[] = [];
  for (const cm of cloudComments ?? []) {
    if (pendingCommentIds.has(cm.id as string)) continue;
    mappedComments.push({
      id: cm.id as string,
      classId: cm.class_id as string,
      studentId: cm.student_id as string,
      date: cm.date as string,
      session: 'all',
      content: cm.content as string,
      tags: Array.isArray(cm.tags) ? (cm.tags as string[]) : [],
      status: ((cm.status as StudentComment['status']) || 'sent') as StudentComment['status'],
      sentAt: cm.sent_at ? new Date(cm.sent_at as string).getTime() : undefined,
      createdAt: cm.created_at ? new Date(cm.created_at as string).getTime() : Date.now(),
      updatedAt: cm.updated_at ? new Date(cm.updated_at as string).getTime() : Date.now(),
    });
  }

  const existingLocalLinks = await scope.db.parentLinks.toArray();
  const lastSentById = new Map<string, number>();
  for (const ll of existingLocalLinks) {
    if (ll.lastSentAt) lastSentById.set(ll.id, ll.lastSentAt);
  }

  const latestTokenByPair = new Map<string, ParentLink>();
  for (const tk of cloudTokens ?? []) {
    const classIdStr = tk.class_id as string;
    const studentIdStr = tk.student_id as string;
    if (!studentToClassMap.has(studentIdStr)) continue;
    const tkId = tk.id as string;
    const pairKey = `${classIdStr}|${studentIdStr}`;
    latestTokenByPair.set(pairKey, {
      id: tkId,
      classId: classIdStr,
      studentId: studentIdStr,
      token: '', // Tuyệt đối không lưu raw_token vào IndexedDB cho dữ liệu Cloud
      tokenHash: tk.token_hash as string,
      parentPhone: (tk.parent_phone as string | null) ?? undefined,
      expiresAt: tk.expires_at ? new Date(tk.expires_at as string).getTime() : undefined,
      isRevoked: Boolean(tk.is_revoked),
      revokedAt: tk.revoked_at ? new Date(tk.revoked_at as string).getTime() : undefined,
      usedAt: tk.used_at ? new Date(tk.used_at as string).getTime() : undefined,
      usedBy: (tk.used_by as string | null) ?? null,
      isVerifiedParentLinked: verifiedStudentSet.has(studentIdStr) || Boolean(tk.used_at),
      createdAt: tk.created_at ? new Date(tk.created_at as string).getTime() : Date.now(),
      updatedAt: tk.updated_at ? new Date(tk.updated_at as string).getTime() : Date.now(),
      lastSentAt: lastSentById.get(tkId),
    });
  }
  const mappedParentLinks: ParentLink[] = Array.from(latestTokenByPair.values());

  const prevSynced = await getCloudSyncedRecord(scope.db);
  const nextClassIds = mappedClasses.map((c) => c.id);
  const nextCriterionIds = mappedCriteria.map((c) => c.id);
  const nextStudentIds = mappedStudents.map((s) => s.id);
  const nextAttendanceIds = mappedAttendance.map((a) => a.id);
  const nextTransactionIds = mappedTransactions.map((t) => t.id);
  const nextCommentIds = mappedComments.map((c) => c.id);
  const nextParentLinkIds = mappedParentLinks.map((pl) => pl.id);

  const nextClassSet = new Set(nextClassIds);
  const nextCriterionSet = new Set(nextCriterionIds);
  const nextStudentSet = new Set(nextStudentIds);
  const nextAttendanceSet = new Set(nextAttendanceIds);
  const nextTransactionSet = new Set(nextTransactionIds);
  const nextCommentSet = new Set(nextCommentIds);
  const nextParentLinkSet = new Set(nextParentLinkIds);

  const removedClassIds = prevSynced.classIds.filter((id) => !nextClassSet.has(id));
  const removedCriterionIds = prevSynced.criterionIds.filter((id) => !nextCriterionSet.has(id));
  const removedStudentIds = prevSynced.studentIds.filter((id) => !nextStudentSet.has(id));
  const removedAttendanceIds = prevSynced.attendanceIds.filter(
    (id) => !nextAttendanceSet.has(id) && !pendingAttendanceSlotKeys.has(id.split('|').slice(0, 3).join('|')),
  );
  const removedTransactionIds = prevSynced.transactionIds.filter(
    (id) => !nextTransactionSet.has(id) && !pendingTxIds.has(id),
  );
  const removedCommentIds = prevSynced.commentIds.filter(
    (id) => !nextCommentSet.has(id) && !pendingCommentIds.has(id),
  );
  const removedParentLinkIds = prevSynced.parentLinkIds.filter((id) => !nextParentLinkSet.has(id));

  scope.assertActive();
  await scope.db.transaction(
    'rw',
    [scope.db.classes, scope.db.criteria, scope.db.students, scope.db.attendance, scope.db.transactions, scope.db.comments, scope.db.parentLinks, scope.db.kv],
    async () => {
      if (removedClassIds.length) await scope.db.classes.bulkDelete(removedClassIds);
      if (removedCriterionIds.length) await scope.db.criteria.bulkDelete(removedCriterionIds);
      if (removedStudentIds.length) await scope.db.students.bulkDelete(removedStudentIds);
      if (removedAttendanceIds.length) await scope.db.attendance.bulkDelete(removedAttendanceIds);
      if (removedTransactionIds.length) await scope.db.transactions.bulkDelete(removedTransactionIds);
      if (removedCommentIds.length) await scope.db.comments.bulkDelete(removedCommentIds);
      if (removedParentLinkIds.length) await scope.db.parentLinks.bulkDelete(removedParentLinkIds);

      if (mappedClasses.length) await scope.db.classes.bulkPut(mappedClasses);
      if (mappedCriteria.length) await scope.db.criteria.bulkPut(mappedCriteria);
      if (mappedStudents.length) await scope.db.students.bulkPut(mappedStudents);
      if (mappedAttendance.length) await scope.db.attendance.bulkPut(mappedAttendance);
      if (mappedTransactions.length) await scope.db.transactions.bulkPut(mappedTransactions);
      if (mappedComments.length) await scope.db.comments.bulkPut(mappedComments);
      if (mappedParentLinks.length) await scope.db.parentLinks.bulkPut(mappedParentLinks);

      await scope.db.kv.put({
        key: CLOUD_SYNC_KV_KEY,
        value: {
          userId: ctx.userId,
          classIds: nextClassIds,
          criterionIds: nextCriterionIds,
          studentIds: nextStudentIds,
          attendanceIds: nextAttendanceIds,
          transactionIds: nextTransactionIds,
          commentIds: nextCommentIds,
          parentLinkIds: nextParentLinkIds,
        },
      });
    },
  );

  return {
    synced: true,
    classesCount: mappedClasses.length,
    criteriaCount: mappedCriteria.length,
    studentsCount: mappedStudents.length,
    attendanceCount: mappedAttendance.length,
    transactionsCount: mappedTransactions.length,
    commentsCount: mappedComments.length,
  };
}

export class ValidationError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(Object.values(fields)[0] || 'Dữ liệu không hợp lệ');
    this.fields = fields;
  }
}

export const CLASS_COLORS = ['#F7A8C4', '#DCD2FF', '#FFE9A8', '#CFF3E4', '#D9EDFF', '#FBD3C4'];

/* ---------------- Settings ---------------- */

export const DEFAULT_SETTINGS: AppSettings = {
  teacherName: 'Tiên',
  teacherTitle: 'cô',
  defaultSession: 'morning',
  soundEnabled: true,
};

export async function getSettings(targetDb?: PinkDB): Promise<AppSettings> {
  const scope = getOperationScope(targetDb);
  const row = await scope.db.kv.get('settings');
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) || {}) };
}

export async function saveSettings(patch: Partial<AppSettings>, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const cur = await getSettings(scope.db);
  const next = { ...cur, ...patch };
  if (!next.teacherName.trim()) throw new ValidationError({ teacherName: 'Vui lòng nhập tên giáo viên' });
  await scope.db.kv.put({ key: 'settings', value: next });
  return next;
}

export async function actorName(targetDb?: PinkDB): Promise<string> {
  const s = await getSettings(targetDb);
  return `${s.teacherTitle === 'cô' ? 'Cô' : 'Thầy'} ${s.teacherName}`;
}

/* ---------------- Activity log ---------------- */

export async function logActivity(
  classId: string | null,
  kind: ActivityLog['kind'],
  message: string,
  targetDb?: PinkDB,
) {
  const scope = getOperationScope(targetDb);
  await scope.db.activities.add({ id: uid('a_'), classId, kind, message, createdAt: Date.now() });
}

/* ---------------- Classes ---------------- */

export interface ClassInput {
  name: string;
  schoolYear: string;
  teacherName: string;
  subject?: string;
  note?: string;
  color?: string;
}

export function validateClass(input: ClassInput) {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) errors.name = 'Vui lòng nhập tên lớp';
  else if (input.name.trim().length > 40) errors.name = 'Tên lớp tối đa 40 ký tự';
  if (!/^\d{4}-\d{4}$/.test(input.schoolYear.trim())) errors.schoolYear = 'Năm học có dạng 2026-2027';
  else {
    const [a, b] = input.schoolYear.split('-').map(Number);
    if (b !== a + 1) errors.schoolYear = 'Năm sau phải lớn hơn năm trước 1 năm';
  }
  if (input.teacherName.trim().length > 60) errors.teacherName = 'Tên giáo viên tối đa 60 ký tự';
  if ((input.note || '').length > 1000) errors.note = 'Ghi chú tối đa 1000 ký tự';
  return errors;
}

export const DEFAULT_CRITERIA: Omit<Criterion, 'id' | 'classId' | 'createdAt' | 'order'>[] = [
  { name: 'Phát biểu tích cực', points: 2, type: 'reward', icon: 'hand' },
  { name: 'Hoàn thành bài tập', points: 2, type: 'reward', icon: 'book' },
  { name: 'Giúp đỡ bạn bè', points: 3, type: 'reward', icon: 'heart' },
  { name: 'Giữ gìn vệ sinh', points: 2, type: 'reward', icon: 'sparkles' },
  { name: 'Quên đồ dùng học tập', points: -1, type: 'penalty', icon: 'pencil' },
  { name: 'Nói chuyện riêng', points: -1, type: 'penalty', icon: 'message' },
];

export async function createClass(input: ClassInput, targetDb?: PinkDB): Promise<ClassRoom> {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const errors = validateClass(input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const dup = await scope.db.classes
    .filter((c) => normalizeVN(c.name) === normalizeVN(input.name) && c.schoolYear === input.schoolYear.trim())
    .first();
  if (dup) throw new ValidationError({ name: 'Đã có lớp cùng tên trong năm học này' });

  const count = await scope.db.classes.count();
  const now = Date.now();
  const classId = uuidv4();
  const color = input.color || CLASS_COLORS[count % CLASS_COLORS.length];

  const cls: ClassRoom = {
    id: classId,
    name: input.name.trim(),
    schoolYear: input.schoolYear.trim(),
    teacherName: input.teacherName.trim(),
    subject: input.subject?.trim(),
    note: input.note?.trim(),
    color,
    createdAt: now,
    updatedAt: now,
  };

  const criteriaRows: Criterion[] = DEFAULT_CRITERIA.map((c, i) => ({
    ...c,
    id: uuidv4(),
    classId: cls.id,
    order: i,
    createdAt: now,
  }));

  if (authCtx && supabase) {
    const { error: clsErr } = await supabase.from('classes').insert({
      id: cls.id,
      name: cls.name,
      school_year: cls.schoolYear,
      teacher_id: authCtx.userId,
      subject: cls.subject || null,
      note: cls.note || null,
      color: cls.color,
    });
    scope.assertActive();
    if (clsErr) {
      if (clsErr.code === '23505') {
        throw new ValidationError({ name: 'Đã có lớp cùng tên trong năm học này' });
      }
      throw new Error(clsErr.message);
    }

    const { error: critErr } = await supabase.from('criteria').insert(
      criteriaRows.map((cr) => ({
        id: cr.id,
        class_id: cls.id,
        name: cr.name,
        points: cr.points,
        type: cr.type,
        icon: cr.icon,
        display_order: cr.order,
        archived: false,
      })),
    );
    scope.assertActive();
    if (critErr) {
      throw new Error(critErr.message);
    }

    await trackCloudIds(
      authCtx.userId,
      {
        classIds: [cls.id],
        criterionIds: criteriaRows.map((c) => c.id),
      },
      scope.db,
    );
    scope.assertActive();
  }

  await scope.db.transaction('rw', scope.db.classes, scope.db.criteria, scope.db.activities, async () => {
    await scope.db.classes.put(cls);
    await scope.db.criteria.bulkPut(criteriaRows);
    await logActivity(cls.id, 'class', `Tạo lớp ${cls.name}`, scope.db);
  });
  return cls;
}

export async function updateClass(id: string, input: ClassInput, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const errors = validateClass(input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const dup = await scope.db.classes
    .filter((c) => c.id !== id && normalizeVN(c.name) === normalizeVN(input.name) && c.schoolYear === input.schoolYear.trim())
    .first();
  if (dup) throw new ValidationError({ name: 'Đã có lớp cùng tên trong năm học này' });

  if (authCtx && supabase && isUUID(id)) {
    const patchPayload: Record<string, unknown> = {
      name: input.name.trim(),
      school_year: input.schoolYear.trim(),
      subject: input.subject?.trim() || null,
      note: input.note?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (input.color) patchPayload.color = input.color;

    const { data: updatedRows, error: updErr } = await supabase
      .from('classes')
      .update(patchPayload)
      .eq('id', id)
      .select('id');
    scope.assertActive();

    if (updErr) {
      if (updErr.code === '23505') {
        throw new ValidationError({ name: 'Đã có lớp cùng tên trong năm học này' });
      }
      throw new Error(updErr.message);
    }
    if (!updatedRows || updatedRows.length === 0) {
      throw new Error('Không tìm thấy lớp học hoặc bạn không có quyền chỉnh sửa lớp này.');
    }
  }

  await scope.db.classes.update(id, {
    name: input.name.trim(),
    schoolYear: input.schoolYear.trim(),
    teacherName: input.teacherName.trim(),
    subject: input.subject?.trim(),
    note: input.note?.trim(),
    color: input.color,
    updatedAt: Date.now(),
  });
  await logActivity(id, 'class', `Cập nhật thông tin lớp ${input.name.trim()}`, scope.db);
}

/** Xóa lớp và toàn bộ dữ liệu thuộc lớp (gọi sau khi giáo viên đã xác nhận & được gợi ý sao lưu) */
export async function deleteClass(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const cls = await scope.db.classes.get(id);

  if (authCtx && supabase && isUUID(id)) {
    // Lấy danh sách học sinh đang hoạt động trong lớp để xóa khi giáo viên còn quyền is_teacher_of_student
    const { data: memRows, error: memErr } = await supabase
      .from('class_memberships')
      .select('student_id')
      .eq('class_id', id);
    scope.assertActive();
    if (memErr) throw new Error(memErr.message);

    const stuIds = Array.from(new Set((memRows ?? []).map((m) => m.student_id as string))).filter(isUUID);
    if (stuIds.length > 0) {
      const { error: stuDelErr } = await supabase.from('students').delete().in('id', stuIds);
      scope.assertActive();
      if (stuDelErr) throw new Error(stuDelErr.message);
    }

    const { data: deletedClasses, error: clsDelErr } = await supabase
      .from('classes')
      .delete()
      .eq('id', id)
      .select('id');
    scope.assertActive();
    if (clsDelErr) throw new Error(clsDelErr.message);
    if (!deletedClasses || deletedClasses.length === 0) {
      throw new Error('Không tìm thấy lớp học hoặc bạn không có quyền xóa lớp này.');
    }
  }

  await scope.db.transaction(
    'rw',
    [
      scope.db.classes,
      scope.db.students,
      scope.db.attendance,
      scope.db.criteria,
      scope.db.transactions,
      scope.db.comments,
      scope.db.gamePicks,
      scope.db.tasks,
      scope.db.activities,
    ],
    async () => {
      await scope.db.students.where('classId').equals(id).delete();
      await scope.db.attendance.where('classId').equals(id).delete();
      await scope.db.criteria.where('classId').equals(id).delete();
      await scope.db.transactions.where('classId').equals(id).delete();
      await scope.db.comments.where('classId').equals(id).delete();
      await scope.db.gamePicks.where('classId').equals(id).delete();
      await scope.db.tasks.where('classId').equals(id).delete();
      await scope.db.activities.where('classId').equals(id).delete();
      await scope.db.classes.delete(id);
      await logActivity(null, 'class', `Đã xóa lớp ${cls?.name ?? ''}`, scope.db);
    },
  );
}

/* ---------------- Students ---------------- */

export interface StudentInput {
  code: string;
  fullName: string;
  birthDate?: string;
  gender: Student['gender'];
  avatar: string;
  parentName?: string;
  parentPhone?: string;
  note?: string;
}

export function validateStudentInput(input: StudentInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const code = input.code.trim();
  if (!code) errors.code = 'Vui lòng nhập mã học sinh';
  else if (!/^[A-Za-z0-9_.-]{1,20}$/.test(code)) errors.code = 'Mã chỉ gồm chữ, số, dấu - _ . (tối đa 20 ký tự)';
  const name = input.fullName.trim();
  if (!name) errors.fullName = 'Vui lòng nhập họ và tên';
  else if (name.length < 2 || name.length > 60) errors.fullName = 'Họ tên từ 2 đến 60 ký tự';
  else if (/[0-9<>{}]/.test(name)) errors.fullName = 'Họ tên không chứa số hoặc ký tự đặc biệt';
  if (input.birthDate) {
    if (!isValidISODate(input.birthDate)) errors.birthDate = 'Ngày sinh không hợp lệ';
    else {
      const y = Number(input.birthDate.slice(0, 4));
      const now = new Date().getFullYear();
      if (y < now - 25 || y > now - 3) errors.birthDate = 'Năm sinh có vẻ chưa đúng';
    }
  }
  if (input.parentPhone && !isValidPhone(input.parentPhone)) errors.parentPhone = 'Số điện thoại không hợp lệ';
  if ((input.note || '').length > 1000) errors.note = 'Ghi chú tối đa 1000 ký tự';
  return errors;
}

/** Mã học sinh là duy nhất trên toàn hệ thống */
export async function isCodeTaken(code: string, exceptId?: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const c = code.trim().toUpperCase();
  const found = await scope.db.students.filter((s) => s.code.toUpperCase() === c && s.id !== exceptId).first();
  return !!found;
}

export async function suggestNextCode(targetDb?: PinkDB): Promise<string> {
  const scope = getOperationScope(targetDb);
  const all = await scope.db.students.toArray();
  let max = 0;
  for (const s of all) {
    const m = /^HS(\d+)$/i.exec(s.code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `HS${String(max + 1).padStart(4, '0')}`;
}

function cleanStudent(input: StudentInput) {
  return {
    code: input.code.trim().toUpperCase(),
    fullName: input.fullName.trim().replace(/\s+/g, ' '),
    birthDate: input.birthDate || undefined,
    gender: input.gender,
    avatar: input.avatar,
    parentName: input.parentName?.trim() || undefined,
    parentPhone: input.parentPhone?.trim() || undefined,
    note: input.note?.trim() || undefined,
  };
}

export async function addStudent(classId: string, input: StudentInput, targetDb?: PinkDB): Promise<Student> {
  if (!classId || !classId.trim()) {
    throw new Error('Vui lòng chọn hoặc tạo lớp học trước khi thêm học sinh.');
  }

  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const errors = validateStudentInput(input);
  if (!errors.code && (await isCodeTaken(input.code, undefined, scope.db))) errors.code = 'Mã học sinh đã tồn tại';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const cleaned = cleanStudent(input);
  const now = Date.now();
  let studentId = uuidv4();

  if (authCtx && supabase && isUUID(classId)) {
    // Đảm bảo lớp học tồn tại trên Supabase trước khi tạo học sinh
    const { data: cloudCls, error: checkClsErr } = await supabase
      .from('classes')
      .select('id, teacher_id')
      .eq('id', classId)
      .maybeSingle();

    if (!cloudCls && !checkClsErr) {
      const localCls = await scope.db.classes.get(classId);
      if (localCls) {
        const { error: insClsErr } = await supabase.from('classes').insert({
          id: localCls.id,
          name: localCls.name,
          school_year: localCls.schoolYear,
          teacher_id: authCtx.userId,
          subject: localCls.subject || null,
          note: localCls.note || null,
          color: localCls.color,
        });
        if (insClsErr && insClsErr.code !== '23505') {
          console.warn('[addStudent] Lớp học chưa có trên máy chủ và không thể đồng bộ tự động:', insClsErr.message);
        }
      }
    }

    const { data: rpcRes, error: rpcErr } = await supabase.rpc('create_student_in_class', {
      p_class_id: classId,
      p_code: cleaned.code,
      p_full_name: cleaned.fullName,
      p_gender: cleaned.gender ? cleaned.gender : null,
      p_birth_date: cleaned.birthDate ?? null,
      p_avatar: cleaned.avatar || 'cat-pink',
      p_note: cleaned.note ?? null,
      p_parent_name: cleaned.parentName ?? null,
      p_parent_phone: cleaned.parentPhone ?? null,
    });
    scope.assertActive();

    if (rpcErr) {
      if (
        rpcErr.code === '23505' ||
        rpcErr.message.includes('Mã học sinh') ||
        rpcErr.message.includes('already exists') ||
        rpcErr.message.includes('duplicate key')
      ) {
        throw new ValidationError({ code: 'Mã học sinh đã tồn tại trên hệ thống' });
      }
      if (rpcErr.message.includes('Bạn không phải là giáo viên')) {
        throw new Error('Quyền bị từ chối: Bạn không phải là giáo viên phụ trách lớp này trên máy chủ.');
      }
      throw new Error(rpcErr.message);
    }

    const returnedId = (rpcRes as { ok?: boolean; student_id?: string } | null)?.student_id;
    if (!returnedId || !isUUID(returnedId)) {
      throw new Error('Không nhận được mã định danh học sinh hợp lệ từ máy chủ.');
    }
    studentId = returnedId;
    await trackCloudIds(authCtx.userId, { studentIds: [studentId] }, scope.db);
    scope.assertActive();
  }

  const s: Student = {
    id: studentId,
    classId,
    ...cleaned,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await scope.db.students.put(s);
  await logActivity(classId, 'student', `Thêm học sinh ${s.fullName}`, scope.db);
  return s;
}

export async function updateStudent(id: string, input: StudentInput, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const errors = validateStudentInput(input);
  if (!errors.code && (await isCodeTaken(input.code, id, scope.db))) errors.code = 'Mã học sinh đã tồn tại';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const cleaned = cleanStudent(input);

  if (authCtx && supabase && isUUID(id)) {
    const { data: updatedRows, error: updErr } = await supabase
      .from('students')
      .update({
        code: cleaned.code,
        full_name: cleaned.fullName,
        birth_date: cleaned.birthDate ?? null,
        gender: cleaned.gender ? cleaned.gender : null,
        avatar: cleaned.avatar || 'cat-pink',
        note: cleaned.note ?? null,
        parent_name: cleaned.parentName ?? null,
        parent_phone: cleaned.parentPhone ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id');
    scope.assertActive();

    if (updErr) {
      if (updErr.code === '23505') {
        throw new ValidationError({ code: 'Mã học sinh đã tồn tại' });
      }
      throw new Error(updErr.message);
    }
    if (!updatedRows || updatedRows.length === 0) {
      throw new Error('Không tìm thấy học sinh hoặc bạn không có quyền chỉnh sửa học sinh này.');
    }
  }

  const cur = await scope.db.students.get(id);
  if (!cur && (!authCtx || !isUUID(id))) throw new Error('Không tìm thấy học sinh');
  if (cur) {
    await scope.db.students.update(id, { ...cleaned, updatedAt: Date.now() });
    await logActivity(cur.classId, 'student', `Cập nhật hồ sơ ${input.fullName.trim()}`, scope.db);
  }
}

export async function bulkAddStudents(classId: string, inputs: StudentInput[], targetDb?: PinkDB) {
  if (!classId || !classId.trim()) {
    throw new Error('Vui lòng chọn hoặc tạo lớp học trước khi thêm học sinh.');
  }

  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const now = Date.now();
  const cleanedList = inputs.map((i) => cleanStudent(i));

  // Kiểm tra trùng mã trong lô nhập và với dữ liệu hiện có trước khi thực thi
  const existing = new Set((await scope.db.students.toArray()).map((s) => s.code.toUpperCase()));
  for (const item of cleanedList) {
    if (existing.has(item.code)) throw new Error(`Mã ${item.code} đã tồn tại`);
    existing.add(item.code);
  }

  const rows: Student[] = [];

  if (authCtx && supabase && isUUID(classId)) {
    // Đảm bảo lớp học tồn tại trên Supabase trước khi tạo học sinh hàng loạt
    const { data: cloudCls, error: checkClsErr } = await supabase
      .from('classes')
      .select('id, teacher_id')
      .eq('id', classId)
      .maybeSingle();

    if (!cloudCls && !checkClsErr) {
      const localCls = await scope.db.classes.get(classId);
      if (localCls) {
        await supabase.from('classes').insert({
          id: localCls.id,
          name: localCls.name,
          school_year: localCls.schoolYear,
          teacher_id: authCtx.userId,
          subject: localCls.subject || null,
          note: localCls.note || null,
          color: localCls.color,
        });
      }
    }

    for (let idx = 0; idx < cleanedList.length; idx++) {
      const cleaned = cleanedList[idx];
      const { data: rpcRes, error: rpcErr } = await supabase.rpc('create_student_in_class', {
        p_class_id: classId,
        p_code: cleaned.code,
        p_full_name: cleaned.fullName,
        p_gender: cleaned.gender ? cleaned.gender : null,
        p_birth_date: cleaned.birthDate ?? null,
        p_avatar: cleaned.avatar || 'cat-pink',
        p_note: cleaned.note ?? null,
        p_parent_name: cleaned.parentName ?? null,
        p_parent_phone: cleaned.parentPhone ?? null,
      });
      scope.assertActive();

      if (rpcErr) {
        if (
          rpcErr.code === '23505' ||
          rpcErr.message.includes('Mã học sinh') ||
          rpcErr.message.includes('already exists') ||
          rpcErr.message.includes('duplicate key')
        ) {
          throw new Error(`Mã học sinh ${cleaned.code} đã tồn tại trên hệ thống`);
        }
        if (rpcErr.message.includes('Bạn không phải là giáo viên')) {
          throw new Error('Quyền bị từ chối: Bạn không phải là giáo viên phụ trách lớp này trên máy chủ.');
        }
        throw new Error(rpcErr.message);
      }

      const returnedId = (rpcRes as { ok?: boolean; student_id?: string } | null)?.student_id;
      if (!returnedId || !isUUID(returnedId)) {
        throw new Error('Không nhận được mã định danh học sinh hợp lệ từ máy chủ.');
      }

      rows.push({
        id: returnedId,
        classId,
        ...cleaned,
        status: 'active',
        createdAt: now + idx,
        updatedAt: now + idx,
      });
    }

    await trackCloudIds(authCtx.userId, { studentIds: rows.map((r) => r.id) }, scope.db);
    scope.assertActive();
    await scope.db.transaction('rw', scope.db.students, scope.db.activities, async () => {
      await scope.db.students.bulkPut(rows);
      await logActivity(classId, 'student', `Nhập ${rows.length} học sinh từ Excel`, scope.db);
    });
    return rows.length;
  }

  for (let idx = 0; idx < cleanedList.length; idx++) {
    rows.push({
      id: uuidv4(),
      classId,
      ...cleanedList[idx],
      status: 'active',
      createdAt: now + idx,
      updatedAt: now + idx,
    });
  }

  await scope.db.transaction('rw', scope.db.students, scope.db.activities, async () => {
    await scope.db.students.bulkAdd(rows);
    await logActivity(classId, 'student', `Nhập ${rows.length} học sinh từ Excel`, scope.db);
  });
  return rows.length;
}

/** Lưu trữ (xóa mềm) – có thể khôi phục */
export async function archiveStudents(ids: string[], targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const uuidIds = ids.filter(isUUID);

  if (authCtx && supabase && uuidIds.length > 0) {
    const { data: updatedRows, error: updErr } = await supabase
      .from('students')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .in('id', uuidIds)
      .select('id');
    scope.assertActive();
    if (updErr) throw new Error(updErr.message);
    if (!updatedRows || updatedRows.length !== uuidIds.length) {
      throw new Error('Không có quyền lưu trữ một hoặc nhiều học sinh đã chọn.');
    }
  }

  const list = await scope.db.students.bulkGet(ids);
  await scope.db.students.where('id').anyOf(ids).modify({ status: 'archived', updatedAt: Date.now() });
  const first = list.find(Boolean);
  if (first) await logActivity(first.classId, 'student', `Chuyển ${ids.length} học sinh vào mục lưu trữ`, scope.db);
}

export async function restoreStudents(ids: string[], targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const uuidIds = ids.filter(isUUID);

  if (authCtx && supabase && uuidIds.length > 0) {
    const { data: updatedRows, error: updErr } = await supabase
      .from('students')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .in('id', uuidIds)
      .select('id');
    scope.assertActive();
    if (updErr) throw new Error(updErr.message);
    if (!updatedRows || updatedRows.length !== uuidIds.length) {
      throw new Error('Không có quyền khôi phục một hoặc nhiều học sinh đã chọn.');
    }
  }

  const list = await scope.db.students.bulkGet(ids);
  await scope.db.students.where('id').anyOf(ids).modify({ status: 'active', updatedAt: Date.now() });
  const first = list.find(Boolean);
  if (first) await logActivity(first.classId, 'student', `Khôi phục ${ids.length} học sinh`, scope.db);
}

/** Xóa vĩnh viễn học sinh và dữ liệu liên quan */
export async function deleteStudentsPermanently(ids: string[], targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const uuidIds = ids.filter(isUUID);

  if (authCtx && supabase && uuidIds.length > 0) {
    const { data: deletedRows, error: delErr } = await supabase
      .from('students')
      .delete()
      .in('id', uuidIds)
      .select('id');
    scope.assertActive();
    if (delErr) throw new Error(delErr.message);
    if (!deletedRows || deletedRows.length !== uuidIds.length) {
      throw new Error('Không có quyền xóa một hoặc nhiều học sinh đã chọn.');
    }
  }

  const list = (await scope.db.students.bulkGet(ids)).filter(Boolean) as Student[];
  await scope.db.transaction(
    'rw',
    [
      scope.db.students,
      scope.db.attendance,
      scope.db.transactions,
      scope.db.comments,
      scope.db.gamePicks,
      scope.db.activities,
    ],
    async () => {
      await scope.db.attendance.where('studentId').anyOf(ids).delete();
      await scope.db.transactions.where('studentId').anyOf(ids).delete();
      await scope.db.comments.where('studentId').anyOf(ids).delete();
      await scope.db.gamePicks.filter((g) => ids.includes(g.studentId)).delete();
      await scope.db.students.bulkDelete(ids);
      if (list[0]) await logActivity(list[0].classId, 'student', `Xóa vĩnh viễn ${list.length} học sinh`, scope.db);
    },
  );
}

/** Chuyển lớp: lịch sử cũ vẫn nằm ở lớp cũ, học sinh bắt đầu dữ liệu mới ở lớp mới */
export async function transferStudents(ids: string[], toClassId: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const target = await scope.db.classes.get(toClassId);
  if (!target && (!authCtx || !isUUID(toClassId))) throw new Error('Lớp đích không tồn tại');

  const uuidIds = ids.filter(isUUID);
  if (authCtx && supabase && uuidIds.length > 0 && isUUID(toClassId)) {
    const today = toISODate();
    const upsertPayload = uuidIds.map((studentId) => ({
      class_id: toClassId,
      student_id: studentId,
      is_active: true,
      joined_at: today,
      left_at: null,
    }));

    const { data: linkedRows, error: linkErr } = await supabase
      .from('class_memberships')
      .upsert(upsertPayload, { onConflict: 'student_id,class_id' })
      .select('id');
    scope.assertActive();
    if (linkErr) throw new Error(linkErr.message);
    if (!linkedRows || linkedRows.length !== uuidIds.length) {
      throw new Error('Không có quyền chuyển học sinh sang lớp đích.');
    }

    const { error: deactErr } = await supabase
      .from('class_memberships')
      .update({ is_active: false, left_at: today })
      .in('student_id', uuidIds)
      .neq('class_id', toClassId)
      .eq('is_active', true);
    scope.assertActive();
    if (deactErr) throw new Error(deactErr.message);
  }

  const list = (await scope.db.students.bulkGet(ids)).filter(Boolean) as Student[];
  await scope.db.students.where('id').anyOf(ids).modify({ classId: toClassId, updatedAt: Date.now() });
  if (list[0]) {
    await logActivity(list[0].classId, 'student', `Chuyển ${list.length} học sinh sang lớp ${target?.name ?? ''}`, scope.db);
    await logActivity(toClassId, 'student', `Nhận ${list.length} học sinh chuyển đến`, scope.db);
  }
}

/* ---------------- Attendance ---------------- */

export function attendanceId(classId: string, date: string, session: Session, studentId: string) {
  return `${classId}|${date}|${session}|${studentId}`;
}

/**
 * Lưu điểm danh. Khóa bản ghi xác định (deterministic) nên bấm lưu nhiều lần
 * chỉ ghi đè chứ không tạo bản ghi trùng.
 */
export async function saveAttendance(
  classId: string,
  date: string,
  session: Session,
  entries: { studentId: string; status: AttendanceStatus; note?: string }[],
  targetDb?: PinkDB,
) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  if (!isValidISODate(date)) throw new Error('Ngày điểm danh không hợp lệ');
  if (session !== 'morning' && session !== 'afternoon') throw new Error('Buổi điểm danh không hợp lệ');
  if (!entries.length) throw new Error('Danh sách điểm danh trống');

  const localCls = await scope.db.classes.get(classId);
  if (!isUUID(classId) && !localCls) {
    throw new Error('Mã lớp học không hợp lệ hoặc không tồn tại.');
  }

  if (isUUID(classId)) {
    for (const e of entries) {
      if (!isUUID(e.studentId)) {
        throw new Error('Mã định danh học sinh không hợp lệ (không được gửi ID cục bộ lên Cloud).');
      }
    }
  } else {
    // Đối với lớp Offline cục bộ: kiểm tra học sinh phải thuộc đúng lớp
    const localStudents = await scope.db.students.bulkGet(entries.map((e) => e.studentId));
    for (const st of localStudents) {
      if (!st || st.classId !== classId) {
        throw new Error('Học sinh không tồn tại hoặc không thuộc lớp học này.');
      }
    }
  }

  const now = Date.now();
  const rows: AttendanceRecord[] = entries.map((e) => ({
    id: attendanceId(classId, date, session, e.studentId),
    classId,
    studentId: e.studentId,
    date,
    session,
    status: e.status,
    note: e.note?.trim() || undefined,
    updatedAt: now,
  }));

  if (authCtx && supabase && isUUID(classId)) {
    const cloudPayload = entries.map((e) => ({
      class_id: classId,
      student_id: e.studentId,
      date,
      session,
      status: e.status,
      note: e.note?.trim() || null,
      recorded_by: authCtx.userId,
      updated_at: new Date(now).toISOString(),
    }));

    try {
      const { data: upsertedRows, error: attErr } = await supabase
        .from('attendance')
        .upsert(cloudPayload, { onConflict: 'class_id,student_id,date,session' })
        .select('id');
      scope.assertActive();

      if (attErr) {
        if (isNetworkOrOfflineError(attErr)) {
          await enqueuePendingSyncItem(
            {
              key: `att:${classId}:${date}:${session}`,
              kind: 'attendance_upsert',
              classId,
              date,
              session,
              createdAt: now,
            },
            scope.db,
          );
        } else {
          throw new Error(attErr.message);
        }
      } else {
        if (!upsertedRows || upsertedRows.length !== entries.length) {
          throw new Error('Không có quyền lưu điểm danh cho lớp hoặc học sinh này.');
        }
        await trackCloudIds(authCtx.userId, { attendanceIds: rows.map((r) => r.id) }, scope.db);
        scope.assertActive();
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        await enqueuePendingSyncItem(
          {
            key: `att:${classId}:${date}:${session}`,
            kind: 'attendance_upsert',
            classId,
            date,
            session,
            createdAt: now,
          },
          scope.db,
        );
      } else {
        throw err;
      }
    }
  } else if (!authCtx && isUUID(classId)) {
    const localStudents = await scope.db.students.bulkGet(entries.map((e) => e.studentId));
    for (const st of localStudents) {
      if (!st || st.classId !== classId) {
        throw new Error('Học sinh không tồn tại hoặc không thuộc lớp học này.');
      }
    }
  }

  const existed = await scope.db.attendance.where('[classId+date+session]').equals([classId, date, session]).count();
  await scope.db.attendance.bulkPut(rows);
  const absent = rows.filter((r) => r.status === 'excused' || r.status === 'unexcused').length;
  await logActivity(
    classId,
    'attendance',
    `${existed ? 'Cập nhật' : 'Điểm danh'} buổi ${session === 'morning' ? 'sáng' : 'chiều'} ${date.split('-').reverse().join('/')}: vắng ${absent}`,
    scope.db,
  );
}

export async function clearAttendance(classId: string, date: string, session: Session, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  if (authCtx && supabase && isUUID(classId)) {
    try {
      const { error } = await supabase
        .from('attendance')
        .delete()
        .eq('class_id', classId)
        .eq('date', date)
        .eq('session', session);
      scope.assertActive();
      if (error) {
        if (isNetworkOrOfflineError(error)) {
          await enqueuePendingSyncItem(
            {
              key: `att_clear:${classId}:${date}:${session}`,
              kind: 'attendance_clear',
              classId,
              date,
              session,
              createdAt: Date.now(),
            },
            scope.db,
          );
        } else {
          throw new Error(error.message);
        }
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        await enqueuePendingSyncItem(
          {
            key: `att_clear:${classId}:${date}:${session}`,
            kind: 'attendance_clear',
            classId,
            date,
            session,
            createdAt: Date.now(),
          },
          scope.db,
        );
      } else {
        throw err;
      }
    }
  }

  await scope.db.attendance.where('[classId+date+session]').equals([classId, date, session]).delete();
  await logActivity(classId, 'attendance', `Xóa điểm danh ngày ${date.split('-').reverse().join('/')}`, scope.db);
}

/* ---------------- Criteria ---------------- */

export interface CriterionInput {
  name: string;
  points: number;
  type: Criterion['type'];
  icon: string;
}

export function validateCriterion(i: CriterionInput) {
  const e: Record<string, string> = {};
  if (!i.name.trim()) e.name = 'Vui lòng nhập tên tiêu chí';
  else if (i.name.trim().length > 50) e.name = 'Tên tiêu chí tối đa 50 ký tự';
  if (!Number.isInteger(i.points) || i.points === 0) e.points = 'Số điểm phải là số nguyên khác 0';
  else if (Math.abs(i.points) > 100) e.points = 'Số điểm tối đa ±100';
  else if (i.type === 'reward' && i.points < 0) e.points = 'Tiêu chí thưởng phải có điểm dương';
  else if (i.type === 'penalty' && i.points > 0) e.points = 'Tiêu chí trừ phải có điểm âm';
  return e;
}

export async function saveCriterion(classId: string, input: CriterionInput, id?: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const e = validateCriterion(input);
  if (Object.keys(e).length) throw new ValidationError(e);

  if (id) {
    if (authCtx && supabase && isUUID(id)) {
      const { data: updatedRows, error: updErr } = await supabase
        .from('criteria')
        .update({
          name: input.name.trim(),
          points: input.points,
          type: input.type,
          icon: input.icon,
        })
        .eq('id', id)
        .select('id');
      scope.assertActive();
      if (updErr) throw new Error(updErr.message);
      if (!updatedRows || updatedRows.length === 0) {
        throw new Error('Không tìm thấy tiêu chí hoặc bạn không có quyền chỉnh sửa tiêu chí này.');
      }
    }
    await scope.db.criteria.update(id, { name: input.name.trim(), points: input.points, type: input.type, icon: input.icon });
  } else {
    const max = (await scope.db.criteria.where('classId').equals(classId).toArray()).reduce((m, c) => Math.max(m, c.order), -1);
    const newId = uuidv4();
    const order = max + 1;

    if (authCtx && supabase && isUUID(classId)) {
      const { error: insErr } = await supabase.from('criteria').insert({
        id: newId,
        class_id: classId,
        name: input.name.trim(),
        points: input.points,
        type: input.type,
        icon: input.icon,
        display_order: order,
        archived: false,
      });
      scope.assertActive();
      if (insErr) throw new Error(insErr.message);
      await trackCloudIds(authCtx.userId, { criterionIds: [newId] }, scope.db);
      scope.assertActive();
    }

    await scope.db.criteria.put({
      id: newId,
      classId,
      ...input,
      name: input.name.trim(),
      order,
      createdAt: Date.now(),
    });
  }
}

/** Tiêu chí đã dùng thì ẩn (archived) thay vì xóa để giữ lịch sử */
export async function removeCriterion(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  let used = await scope.db.transactions.filter((t) => t.criterionId === id).count();

  if (authCtx && supabase && isUUID(id)) {
    const { count: cloudUsed, error: cntErr } = await supabase
      .from('student_points')
      .select('id', { count: 'exact', head: true })
      .eq('criterion_id', id);
    scope.assertActive();
    if (!cntErr && typeof cloudUsed === 'number') {
      used = Math.max(used, cloudUsed);
    }

    if (used > 0) {
      const { data: updRows, error: updErr } = await supabase
        .from('criteria')
        .update({ archived: true })
        .eq('id', id)
        .select('id');
      scope.assertActive();
      if (updErr) throw new Error(updErr.message);
      if (!updRows || updRows.length === 0) {
        throw new Error('Không tìm thấy tiêu chí hoặc bạn không có quyền ẩn tiêu chí này.');
      }
    } else {
      const { data: delRows, error: delErr } = await supabase
        .from('criteria')
        .delete()
        .eq('id', id)
        .select('id');
      scope.assertActive();
      if (delErr) throw new Error(delErr.message);
      if (!delRows || delRows.length === 0) {
        throw new Error('Không tìm thấy tiêu chí hoặc bạn không có quyền xóa tiêu chí này.');
      }
    }
  }

  if (used > 0) await scope.db.criteria.update(id, { archived: true });
  else await scope.db.criteria.delete(id);
}

/* ---------------- Points ---------------- */

export async function awardPoints(
  opts: {
    classId: string;
    studentIds: string[];
    criterion?: Criterion | null;
    customName?: string;
    delta?: number;
    note?: string;
    targetDb?: PinkDB;
  },
  explicitDb?: PinkDB,
) {
  const targetDb = explicitDb ?? opts.targetDb;
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const { classId, studentIds } = opts;
  if (!studentIds.length) throw new Error('Chưa chọn học sinh nào');
  const delta = opts.criterion ? opts.criterion.points : Number(opts.delta);
  const name = opts.criterion ? opts.criterion.name : (opts.customName || '').trim();
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
    throw new Error('Số điểm phải là số nguyên khác 0 (tối đa ±100)');
  }
  if (!name) throw new Error('Vui lòng nhập lý do');

  const localCls = await scope.db.classes.get(classId);
  if (!isUUID(classId) && !localCls) {
    throw new Error('Mã lớp học không hợp lệ hoặc không tồn tại.');
  }

  if (isUUID(classId)) {
    for (const sid of studentIds) {
      if (!isUUID(sid)) {
        throw new Error('Mã định danh học sinh không hợp lệ (không được gửi ID cục bộ lên Cloud).');
      }
    }
    if (opts.criterion?.id && !isUUID(opts.criterion.id)) {
      throw new Error('Mã định danh tiêu chí không hợp lệ (không được gửi ID cục bộ lên Cloud).');
    }
    if (opts.criterion?.classId && opts.criterion.classId !== classId) {
      throw new Error('Tiêu chí thi đua được chọn không thuộc lớp học này.');
    }
  }

  const localStudents = await scope.db.students.bulkGet(studentIds);
  const valid = localStudents.filter(
    (s): s is Student => !!s && s.classId === classId && s.status === 'active',
  );

  // Nếu đang ở chế độ Offline hoặc thiếu học sinh hợp lệ trong lớp cục bộ (và không phải gọi trực tiếp Cloud)
  if (valid.length !== studentIds.length && (!authCtx || !isUUID(classId))) {
    throw new Error('Không có học sinh hợp lệ trong lớp');
  }

  const actor = authCtx?.fullName || (await actorName(scope.db));
  const batchId = uuidv4();
  const now = Date.now();
  const targetStudentIds = valid.length === studentIds.length ? valid.map((s) => s.id) : studentIds;

  const rows: PointTransaction[] = targetStudentIds.map((sid) => ({
    id: uuidv4(),
    classId,
    studentId: sid,
    criterionId: opts.criterion?.id ?? null,
    criterionName: name,
    delta,
    note: opts.note?.trim() || undefined,
    actor,
    batchId,
    createdAt: now,
  }));

  if (authCtx && supabase && isUUID(classId)) {
    const cloudRows = rows.map((r) => ({
      id: r.id,
      class_id: r.classId,
      student_id: r.studentId,
      criterion_id: r.criterionId,
      criterion_name: r.criterionName,
      delta: r.delta,
      note: r.note ?? null,
      actor_id: authCtx.userId,
      batch_id: r.batchId,
      undone: false,
      undone_at: null,
      created_at: new Date(r.createdAt).toISOString(),
      source_id: r.id,
    }));

    try {
      const { data: upsertedRows, error: ptsErr } = await supabase
        .from('student_points')
        .upsert(cloudRows, { onConflict: 'id' })
        .select('id');
      scope.assertActive();

      if (ptsErr) {
        if (isNetworkOrOfflineError(ptsErr)) {
          for (const r of rows) {
            await enqueuePendingSyncItem(
              {
                key: `pts:${r.id}`,
                kind: 'points_upsert',
                txId: r.id,
                createdAt: now,
              },
              scope.db,
            );
          }
        } else {
          throw new Error(ptsErr.message);
        }
      } else {
        if (!upsertedRows || upsertedRows.length !== rows.length) {
          throw new Error('Không có quyền chấm điểm cho lớp hoặc học sinh này.');
        }
        await trackCloudIds(authCtx.userId, { transactionIds: rows.map((r) => r.id) }, scope.db);
        scope.assertActive();
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        for (const r of rows) {
          await enqueuePendingSyncItem(
            {
              key: `pts:${r.id}`,
              kind: 'points_upsert',
              txId: r.id,
              createdAt: now,
            },
            scope.db,
          );
        }
      } else {
        throw err;
      }
    }
  }

  await scope.db.transactions.bulkPut(rows);
  const who = valid.length === 1 ? valid[0].fullName : `${rows.length} học sinh`;
  await logActivity(classId, 'points', `${delta > 0 ? '+' : ''}${delta} điểm "${name}" cho ${who}`, scope.db);
  return { batchId, count: rows.length, transactionIds: rows.map((r) => r.id) };
}

export async function undoTransaction(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const t = await scope.db.transactions.get(id);
  if (!t || t.undone) return;
  const now = Date.now();

  if (authCtx && supabase && isUUID(id)) {
    try {
      const { data: updatedRows, error: updErr } = await supabase
        .from('student_points')
        .update({ undone: true, undone_at: new Date(now).toISOString() })
        .eq('id', id)
        .select('id');
      scope.assertActive();
      if (updErr) {
        if (isNetworkOrOfflineError(updErr)) {
          await enqueuePendingSyncItem({ key: `pts:${id}`, kind: 'points_upsert', txId: id, createdAt: now }, scope.db);
        } else {
          throw new Error(updErr.message);
        }
      } else if (!updatedRows || updatedRows.length === 0) {
        throw new Error('Không tìm thấy giao dịch điểm hoặc bạn không có quyền hoàn tác.');
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        await enqueuePendingSyncItem({ key: `pts:${id}`, kind: 'points_upsert', txId: id, createdAt: now }, scope.db);
      } else {
        throw err;
      }
    }
  }

  await scope.db.transactions.update(id, { undone: true, undoneAt: now });
  await logActivity(t.classId, 'points', `Hoàn tác ${t.delta > 0 ? '+' : ''}${t.delta} điểm "${t.criterionName}"`, scope.db);
}

export async function undoBatch(batchId: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const list = await scope.db.transactions.where('batchId').equals(batchId).toArray();
  const live = list.filter((t) => !t.undone);
  if (!live.length) return;
  const now = Date.now();

  if (authCtx && supabase && isUUID(batchId)) {
    try {
      const { data: updatedRows, error: updErr } = await supabase
        .from('student_points')
        .update({ undone: true, undone_at: new Date(now).toISOString() })
        .eq('batch_id', batchId)
        .select('id');
      scope.assertActive();
      if (updErr) {
        if (isNetworkOrOfflineError(updErr)) {
          for (const t of live) {
            await enqueuePendingSyncItem({ key: `pts:${t.id}`, kind: 'points_upsert', txId: t.id, createdAt: now }, scope.db);
          }
        } else {
          throw new Error(updErr.message);
        }
      } else if (!updatedRows || updatedRows.length === 0) {
        throw new Error('Không tìm thấy lượt chấm điểm hoặc bạn không có quyền hoàn tác.');
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        for (const t of live) {
          await enqueuePendingSyncItem({ key: `pts:${t.id}`, kind: 'points_upsert', txId: t.id, createdAt: now }, scope.db);
        }
      } else {
        throw err;
      }
    }
  }

  await scope.db.transactions.bulkPut(live.map((t) => ({ ...t, undone: true, undoneAt: now })));
  await logActivity(live[0].classId, 'points', `Hoàn tác lượt chấm "${live[0].criterionName}" (${live.length} học sinh)`, scope.db);
}

export async function redoTransaction(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const t = await scope.db.transactions.get(id);
  if (!t || !t.undone) return;

  if (authCtx && supabase && isUUID(id)) {
    try {
      const { data: updatedRows, error: updErr } = await supabase
        .from('student_points')
        .update({ undone: false, undone_at: null })
        .eq('id', id)
        .select('id');
      scope.assertActive();
      if (updErr) {
        if (isNetworkOrOfflineError(updErr)) {
          await enqueuePendingSyncItem({ key: `pts:${id}`, kind: 'points_upsert', txId: id, createdAt: Date.now() }, scope.db);
        } else {
          throw new Error(updErr.message);
        }
      } else if (!updatedRows || updatedRows.length === 0) {
        throw new Error('Không tìm thấy giao dịch điểm hoặc bạn không có quyền khôi phục.');
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        await enqueuePendingSyncItem({ key: `pts:${id}`, kind: 'points_upsert', txId: id, createdAt: Date.now() }, scope.db);
      } else {
        throw err;
      }
    }
  }

  await scope.db.transactions.update(id, { undone: false, undoneAt: undefined });
}

/* ---------------- Comments ---------------- */

export interface CommentInput {
  studentId: string;
  date: string;
  session: StudentComment['session'];
  content: string;
  tags: string[];
  status?: StudentComment['status'];
}

export async function saveComment(
  classId: string,
  input: CommentInput,
  id?: string,
  targetDb?: PinkDB,
): Promise<StudentComment> {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const e: Record<string, string> = {};
  if (!input.studentId) e.studentId = 'Vui lòng chọn học sinh';
  if (!isValidISODate(input.date)) e.date = 'Ngày không hợp lệ';
  if (!input.content.trim()) e.content = 'Vui lòng nhập nội dung nhận xét';
  else if (input.content.length > 2000) e.content = 'Nhận xét tối đa 2000 ký tự';
  if (Object.keys(e).length) throw new ValidationError(e);

  const localCls = await scope.db.classes.get(classId);
  if (!isUUID(classId) && !localCls) {
    throw new Error('Mã lớp học không hợp lệ hoặc không tồn tại.');
  }

  if (isUUID(classId)) {
    if (!isUUID(input.studentId)) {
      throw new Error('Mã định danh học sinh không hợp lệ (không được gửi ID cục bộ lên Cloud).');
    }
    if (id && !isUUID(id)) {
      throw new Error('Mã định danh nhận xét không hợp lệ.');
    }
  }

  const student = await scope.db.students.get(input.studentId);
  if (student && student.classId !== classId) {
    throw new Error('Học sinh không thuộc lớp học này.');
  }
  if (!student && (!authCtx || !isUUID(classId))) {
    throw new Error('Học sinh không tồn tại trong lớp.');
  }

  const existing = id ? await scope.db.comments.get(id) : undefined;
  const status: StudentComment['status'] = input.status ?? 'sent';

  // Kiểm tra quy tắc bất biến đối với nhận xét đã gửi (khớp với trigger handle_comment_status_and_consistency)
  if (existing && (existing.status ?? 'sent') === 'sent' && status === 'draft' && authCtx?.role !== 'admin') {
    throw new Error('Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.');
  }

  const now = Date.now();
  let sentAt: number | undefined;
  if (status === 'sent') {
    sentAt = existing?.status === 'sent' && existing.sentAt ? existing.sentAt : now;
  } else {
    sentAt = undefined;
  }

  const commentId = id ?? uuidv4();
  const schoolYear = localCls?.schoolYear || schoolYearOf(parseISODate(input.date));
  const weekNumber = isoWeekNumber(input.date);

  if (authCtx && supabase && isUUID(classId)) {
    try {
      if (id) {
        const updatePayload: Record<string, unknown> = {
          date: input.date,
          week_number: weekNumber,
          school_year: schoolYear,
          content: input.content.trim(),
          tags: input.tags ?? [],
          status,
          updated_at: new Date(now).toISOString(),
        };
        if (status === 'sent' && (!existing || existing.status !== 'sent')) {
          updatePayload.sent_at = new Date(now).toISOString();
        } else if (status === 'draft') {
          updatePayload.sent_at = null;
        }

        const { data: updatedRows, error: cmtErr } = await supabase
          .from('weekly_comments')
          .update(updatePayload)
          .eq('id', id)
          .select('id, status, sent_at');
        scope.assertActive();

        if (cmtErr) {
          if (isNetworkOrOfflineError(cmtErr)) {
            await enqueuePendingSyncItem(
              {
                key: `cmt:${id}`,
                kind: 'comment_upsert',
                commentId: id,
                createdAt: now,
              },
              scope.db,
            );
          } else {
            throw new Error(cmtErr.message);
          }
        } else if (!updatedRows || updatedRows.length === 0) {
          throw new Error('Không tìm thấy nhận xét hoặc bạn không có quyền chỉnh sửa nhận xét này.');
        } else {
          const row0 = updatedRows[0] as { sent_at?: string | null };
          if (row0?.sent_at) sentAt = new Date(row0.sent_at).getTime();
        }
      } else {
        const { data: insertedRows, error: cmtErr } = await supabase
          .from('weekly_comments')
          .upsert(
            {
              id: commentId,
              class_id: classId,
              student_id: input.studentId,
              week_number: weekNumber,
              school_year: schoolYear,
              date: input.date,
              content: input.content.trim(),
              status,
              sent_at: status === 'sent' && sentAt ? new Date(sentAt).toISOString() : null,
              teacher_id: authCtx.userId,
              tags: input.tags ?? [],
              created_at: new Date(now).toISOString(),
              updated_at: new Date(now).toISOString(),
            },
            { onConflict: 'id' },
          )
          .select('id, status, sent_at');
        scope.assertActive();

        if (cmtErr) {
          if (isNetworkOrOfflineError(cmtErr)) {
            await enqueuePendingSyncItem(
              {
                key: `cmt:${commentId}`,
                kind: 'comment_upsert',
                commentId,
                createdAt: now,
              },
              scope.db,
            );
          } else if (cmtErr.code === '23505') {
            throw new ValidationError({ date: 'Học sinh đã có nhận xét trong ngày này' });
          } else {
            throw new Error(cmtErr.message);
          }
        } else {
          if (!insertedRows || insertedRows.length === 0) {
            throw new Error('Không có quyền tạo nhận xét cho lớp hoặc học sinh này.');
          }
          const row0 = insertedRows[0] as { sent_at?: string | null };
          if (row0?.sent_at) sentAt = new Date(row0.sent_at).getTime();
          await trackCloudIds(authCtx.userId, { commentIds: [commentId] }, scope.db);
          scope.assertActive();
        }
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        await enqueuePendingSyncItem(
          {
            key: `cmt:${commentId}`,
            kind: 'comment_upsert',
            commentId,
            createdAt: now,
          },
          scope.db,
        );
      } else {
        throw err;
      }
    }
  }

  const savedRecord: StudentComment = {
    id: commentId,
    classId,
    studentId: input.studentId,
    date: input.date,
    session: input.session,
    content: input.content.trim(),
    tags: input.tags ?? [],
    status,
    sentAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await scope.db.comments.put(savedRecord);
  await logActivity(
    classId,
    'comment',
    `${id ? 'Sửa' : 'Ghi'} nhận xét cho ${student?.fullName ?? ''}`,
    scope.db,
  );
  return savedRecord;
}

export async function deleteComment(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const existing = await scope.db.comments.get(id);

  // Bảo vệ lưu trữ sư phạm: Giáo viên không được xóa nhận xét đã gửi
  if (existing && (existing.status ?? 'sent') === 'sent' && authCtx?.role !== 'admin') {
    throw new Error('Không được phép xóa nhận xét đã gửi tới phụ huynh (bảo vệ lưu trữ sư phạm).');
  }

  if (authCtx && supabase && isUUID(id)) {
    try {
      const { data: deletedRows, error: delErr } = await supabase
        .from('weekly_comments')
        .delete()
        .eq('id', id)
        .select('id');
      scope.assertActive();
      if (delErr) {
        if (isNetworkOrOfflineError(delErr)) {
          await enqueuePendingSyncItem(
            {
              key: `cmt_del:${id}`,
              kind: 'comment_delete',
              commentId: id,
              createdAt: Date.now(),
            },
            scope.db,
          );
        } else {
          throw new Error(delErr.message);
        }
      } else if (!deletedRows || deletedRows.length === 0) {
        throw new Error('Không tìm thấy nhận xét hoặc bạn không có quyền xóa nhận xét này.');
      }
    } catch (err) {
      scope.assertActive();
      if (isNetworkOrOfflineError(err)) {
        await enqueuePendingSyncItem(
          {
            key: `cmt_del:${id}`,
            kind: 'comment_delete',
            commentId: id,
            createdAt: Date.now(),
          },
          scope.db,
        );
      } else {
        throw err;
      }
    }
  }

  await scope.db.comments.delete(id);
}

/* ---------------- Parent Links & Parent Portal ---------------- */

/**
 * Kiểm tra bắt buộc người dùng hiện tại phải đăng nhập Supabase với vai trò 'parent'
 * (được xác định từ bảng public.profiles, tuyệt đối không tin user_metadata).
 */
async function requireParentContext(): Promise<AuthenticatedContext> {
  const ctx = await getAuthenticatedContext();
  if (!ctx) {
    throw new Error('Chưa được xác thực: Vui lòng đăng nhập tài khoản Phụ huynh để tiếp tục.');
  }
  if (ctx.role !== 'parent') {
    throw new Error('Quyền bị từ chối: Chức năng này chỉ dành cho tài khoản Phụ huynh.');
  }
  return ctx;
}

/** Tạo token bảo mật ngẫu nhiên không thể suy đoán (128-bit) */
export function generateSecureToken(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return uid('pl_') + Math.random().toString(36).slice(2);
}

async function issueCloudParentInvitationToken(
  authCtx: AuthenticatedContext,
  classId: string,
  studentId: string,
  opts?: { expiresAtMs?: number },
  targetDb?: PinkDB,
): Promise<ParentLink> {
  const scope = getOperationScope(targetDb);
  if (!supabase) {
    throw new Error('Chưa cấu hình kết nối Supabase.');
  }
  if (!isUUID(classId)) {
    throw new Error('Mã lớp học không hợp lệ.');
  }
  if (!isUUID(studentId)) {
    throw new Error('Mã định danh học sinh không hợp lệ (không được gửi ID cục bộ lên Cloud).');
  }

  const localStudent = await scope.db.students.get(studentId);
  if (localStudent && (localStudent.classId !== classId || localStudent.status !== 'active')) {
    throw new Error('Học sinh không thuộc lớp học này hoặc đã ngừng theo học.');
  }

  const now = Date.now();

  // Thu hồi các mã mời cũ đang còn hiệu lực (chưa sử dụng và chưa hết hạn) của cùng học sinh trong lớp này trước khi cấp mã mới
  const { data: existingTokens, error: listErr } = await supabase
    .from('parent_invitation_tokens')
    .select('id, is_revoked, used_at, expires_at')
    .eq('class_id', classId)
    .eq('student_id', studentId)
    .eq('is_revoked', false);
  scope.assertActive();

  if (listErr) {
    throw new Error(listErr.message || 'Không thể kiểm tra danh sách mã mời hiện có.');
  }

  for (const oldTok of existingTokens ?? []) {
    const notExpired = !oldTok.expires_at || new Date(oldTok.expires_at as string).getTime() > now;
    if (!oldTok.used_at && notExpired) {
      const { data: revData, error: revErr } = await supabase.rpc('revoke_parent_invitation', {
        p_token_id: oldTok.id as string,
      });
      scope.assertActive();
      if (revErr) {
        throw new Error(revErr.message || 'Không thể thu hồi mã mời cũ.');
      }
      const revRes = revData as { ok?: boolean; message?: string } | null;
      if (revRes && revRes.ok === false) {
        throw new Error(revRes.message || 'Không thể thu hồi mã mời cũ.');
      }
    }
  }

  const rawToken = generateSecureToken();
  const tokenHash = await sha256(rawToken.trim());
  const tokenId = uuidv4();
  const expiresAtMs = opts?.expiresAtMs ?? now + 30 * 24 * 60 * 60 * 1000;

  const { data: insertedRows, error: insErr } = await supabase
    .from('parent_invitation_tokens')
    .insert({
      id: tokenId,
      class_id: classId,
      student_id: studentId,
      token_hash: tokenHash,
      parent_phone: localStudent?.parentPhone || null,
      expires_at: new Date(expiresAtMs).toISOString(),
      created_by: authCtx.userId,
    })
    .select(
      'id, class_id, student_id, token_hash, parent_phone, expires_at, is_revoked, revoked_at, used_at, used_by, created_at, updated_at',
    );
  scope.assertActive();

  if (insErr) {
    throw new Error(insErr.message || 'Không thể tạo mã mời phụ huynh.');
  }
  if (!insertedRows || insertedRows.length === 0) {
    throw new Error('Không có quyền tạo mã mời phụ huynh cho lớp hoặc học sinh này.');
  }

  const row0 = insertedRows[0] as Record<string, unknown>;
  const persistedLink: ParentLink = {
    id: (row0.id as string) || tokenId,
    classId,
    studentId,
    token: '', // Tuyệt đối không lưu raw_token vào DB hoặc IndexedDB ở chế độ Cloud
    tokenHash: (row0.token_hash as string) || tokenHash,
    parentPhone: (row0.parent_phone as string | null) ?? localStudent?.parentPhone,
    expiresAt: row0.expires_at ? new Date(row0.expires_at as string).getTime() : expiresAtMs,
    isRevoked: Boolean(row0.is_revoked),
    revokedAt: row0.revoked_at ? new Date(row0.revoked_at as string).getTime() : undefined,
    usedAt: row0.used_at ? new Date(row0.used_at as string).getTime() : undefined,
    usedBy: (row0.used_by as string | null) ?? null,
    createdAt: row0.created_at ? new Date(row0.created_at as string).getTime() : now,
    updatedAt: row0.updated_at ? new Date(row0.updated_at as string).getTime() : now,
  };

  const oldLocalLinks = await scope.db.parentLinks.where('[classId+studentId]').equals([classId, studentId]).toArray();
  if (oldLocalLinks.length) {
    await scope.db.parentLinks.bulkDelete(oldLocalLinks.map((l) => l.id));
  }
  await scope.db.parentLinks.put(persistedLink);
  await trackCloudIds(authCtx.userId, { parentLinkIds: [persistedLink.id] }, scope.db);

  // Chỉ trả về issuedRawToken 1 lần duy nhất trong bộ nhớ (RAM) để giáo viên sao chép gửi phụ huynh
  return {
    ...persistedLink,
    issuedRawToken: rawToken,
  };
}

export async function getOrCreateParentLink(
  classId: string,
  studentId: string,
  opts?: { expiresAtMs?: number },
  targetDb?: PinkDB,
): Promise<ParentLink> {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const localCls = await scope.db.classes.get(classId);
  if (!isUUID(classId) && !localCls) {
    throw new Error('Mã lớp học không hợp lệ hoặc không tồn tại.');
  }

  if (authCtx && supabase && isUUID(classId)) {
    return issueCloudParentInvitationToken(authCtx, classId, studentId, opts, scope.db);
  }

  const student = await scope.db.students.get(studentId);
  if (!student || student.classId !== classId || student.status !== 'active') {
    throw new Error('Học sinh không tồn tại hoặc không thuộc lớp học này.');
  }

  const existing = await scope.db.parentLinks.where('[classId+studentId]').equals([classId, studentId]).first();
  if (existing && !existing.isRevoked && (!existing.expiresAt || existing.expiresAt > Date.now())) {
    return existing;
  }

  const now = Date.now();
  const rawToken = generateSecureToken();
  const tokenHash = await sha256(rawToken.trim());
  const link: ParentLink = {
    id: existing?.id ?? uid('plnk_'),
    classId,
    studentId,
    token: rawToken,
    tokenHash,
    parentPhone: student.parentPhone,
    expiresAt: opts?.expiresAtMs ?? now + 30 * 24 * 60 * 60 * 1000,
    isRevoked: false,
    revokedAt: undefined,
    createdAt: now,
    updatedAt: now,
  };
  await scope.db.parentLinks.put(link);
  return { ...link, issuedRawToken: rawToken };
}

export async function regenerateParentLink(
  classId: string,
  studentId: string,
  opts?: { expiresAtMs?: number },
  targetDb?: PinkDB,
): Promise<ParentLink> {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  const localCls = await scope.db.classes.get(classId);
  if (!isUUID(classId) && !localCls) {
    throw new Error('Mã lớp học không hợp lệ hoặc không tồn tại.');
  }

  if (authCtx && supabase && isUUID(classId)) {
    return issueCloudParentInvitationToken(authCtx, classId, studentId, opts, scope.db);
  }

  const student = await scope.db.students.get(studentId);
  if (!student || student.classId !== classId || student.status !== 'active') {
    throw new Error('Học sinh không tồn tại hoặc không thuộc lớp học này.');
  }

  const existing = await scope.db.parentLinks.where('[classId+studentId]').equals([classId, studentId]).first();
  const now = Date.now();
  const newToken = generateSecureToken();
  const tokenHash = await sha256(newToken.trim());

  if (existing) {
    const updated: ParentLink = {
      ...existing,
      token: newToken,
      tokenHash,
      expiresAt: opts?.expiresAtMs ?? now + 30 * 24 * 60 * 60 * 1000,
      isRevoked: false,
      revokedAt: undefined,
      usedAt: undefined,
      usedBy: null,
      updatedAt: now,
    };
    await scope.db.parentLinks.put(updated);
    return { ...updated, issuedRawToken: newToken };
  }
  return getOrCreateParentLink(classId, studentId, opts, scope.db);
}

/**
 * Thu hồi mã mời phụ huynh qua RPC public.revoke_parent_invitation (chế độ Cloud)
 * hoặc cập nhật trạng thái thu hồi cục bộ (chế độ Offline).
 */
export async function revokeParentInvitationToken(
  tokenId: string,
  targetDb?: PinkDB,
): Promise<{ ok: boolean; message: string }> {
  const scope = getOperationScope(targetDb);
  const authCtx = await requireTeacherOrOfflineContext();
  scope.assertActive();
  if (!tokenId) {
    throw new Error('Mã định danh token không hợp lệ.');
  }

  const now = Date.now();

  if (authCtx && supabase && isUUID(tokenId)) {
    const { data, error } = await supabase.rpc('revoke_parent_invitation', {
      p_token_id: tokenId,
    });
    scope.assertActive();
    if (error) {
      throw new Error(error.message || 'Không thể thu hồi mã liên kết.');
    }
    const res = data as { ok?: boolean; message?: string } | null;
    if (!res || res.ok !== true) {
      throw new Error(res?.message || 'Thu hồi mã liên kết thất bại.');
    }

    const existing = await scope.db.parentLinks.get(tokenId);
    if (existing) {
      await scope.db.parentLinks.update(tokenId, {
        isRevoked: true,
        revokedAt: now,
        token: '',
        updatedAt: now,
      });
    }
    return {
      ok: true,
      message: res.message || 'Thu hồi mã liên kết thành công.',
    };
  }

  const existing = await scope.db.parentLinks.get(tokenId);
  if (!existing) {
    throw new Error('Mã liên kết không tồn tại.');
  }
  if (existing.usedAt) {
    throw new Error('Mã liên kết này đã được phụ huynh sử dụng, không thể thu hồi.');
  }
  await scope.db.parentLinks.update(tokenId, {
    isRevoked: true,
    revokedAt: now,
    token: '',
    updatedAt: now,
  });
  return {
    ok: true,
    message: 'Thu hồi mã liên kết thành công.',
  };
}

export async function recordParentLinkSent(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  await scope.db.parentLinks.update(id, { lastSentAt: Date.now() });
}

const CLAIM_RATE_LIMIT_MAX_ATTEMPTS = 5;
const CLAIM_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CLAIM_RATE_LIMIT_COOLDOWN_MS = 30 * 1000;

interface ClaimRateLimitState {
  failedAttempts: number;
  firstFailedAt: number;
  cooldownUntil: number;
}

let claimRateLimitState: ClaimRateLimitState = {
  failedAttempts: 0,
  firstFailedAt: 0,
  cooldownUntil: 0,
};

export function resetClaimRateLimitForTesting(): void {
  claimRateLimitState = {
    failedAttempts: 0,
    firstFailedAt: 0,
    cooldownUntil: 0,
  };
}

/**
 * Phụ huynh nhập mã mời (raw_token) để kích hoạt liên kết tài khoản với học sinh
 * qua RPC nguyên tử public.claim_parent_invitation(raw_token).
 * Tuyệt đối không ghi raw_token vào DB, console log hay thông báo lỗi.
 * Tích hợp giới hạn tần suất thử sai (Rate limit & Cooldown) chống tấn công vét cạn.
 */
export async function claimParentInvitationToken(rawToken: string): Promise<{
  ok: boolean;
  message: string;
  studentId?: string;
}> {
  await requireParentContext();
  if (!supabase) {
    throw new Error('Chưa cấu hình kết nối Supabase.');
  }

  const now = Date.now();
  if (now < claimRateLimitState.cooldownUntil) {
    const remainingSeconds = Math.ceil((claimRateLimitState.cooldownUntil - now) / 1000);
    throw new Error(`Bạn đã thử sai quá nhiều lần. Vui lòng chờ ${remainingSeconds} giây trước khi thử lại.`);
  }

  const cleaned = (rawToken ?? '').trim();
  if (cleaned.length < 16) {
    throw new Error('Mã liên kết không đúng định dạng hoặc quá ngắn.');
  }

  const { data, error } = await supabase.rpc('claim_parent_invitation', {
    raw_token: cleaned,
  });

  const result = data as { ok?: boolean; message?: string; student_id?: string; code?: string } | null;

  if (result?.code === 'RATE_LIMITED') {
    throw new Error(result.message || 'Bạn đã thử sai quá nhiều lần. Vui lòng chờ trước khi thử lại.');
  }

  if (error || !result || result.ok !== true) {
    if (now - claimRateLimitState.firstFailedAt > CLAIM_RATE_LIMIT_WINDOW_MS) {
      claimRateLimitState.failedAttempts = 1;
      claimRateLimitState.firstFailedAt = now;
    } else {
      claimRateLimitState.failedAttempts += 1;
    }

    if (claimRateLimitState.failedAttempts >= CLAIM_RATE_LIMIT_MAX_ATTEMPTS) {
      claimRateLimitState.cooldownUntil = now + CLAIM_RATE_LIMIT_COOLDOWN_MS;
      const remainingSeconds = Math.ceil(CLAIM_RATE_LIMIT_COOLDOWN_MS / 1000);
      throw new Error(`Bạn đã thử sai liên tiếp ${CLAIM_RATE_LIMIT_MAX_ATTEMPTS} lần. Vui lòng chờ ${remainingSeconds} giây trước khi thử lại.`);
    }

    if (error) {
      throw new Error(error.message || 'Không thể xác minh mã liên kết.');
    }
    throw new Error(result?.message || 'Mã liên kết không hợp lệ hoặc đã hết hiệu lực.');
  }

  // Reset khi thành công
  claimRateLimitState = {
    failedAttempts: 0,
    firstFailedAt: 0,
    cooldownUntil: 0,
  };

  return {
    ok: true,
    message: result.message || 'Xác minh và liên kết học sinh thành công!',
    studentId: result.student_id,
  };
}

/**
 * Truy vấn dữ liệu Cổng Phụ Huynh (ParentPortal) cho tài khoản phụ huynh đang đăng nhập.
 * Chỉ trả về dữ liệu của các học sinh đã xác minh (public.parent_students.is_verified = true)
 * và chỉ trả về các nhận xét đã gửi (public.weekly_comments.status = 'sent').
 */
export async function fetchParentPortalData(): Promise<ParentPortalStudentData[]> {
  const ctx = await requireParentContext();
  if (!supabase) {
    throw new Error('Chưa cấu hình kết nối Supabase.');
  }

  const { data: parentLinks, error: linkErr } = await supabase
    .from('parent_students')
    .select('id, parent_id, student_id, relationship, is_verified, verified_at, created_at')
    .eq('parent_id', ctx.userId)
    .eq('is_verified', true)
    .order('created_at', { ascending: true });

  if (linkErr) {
    throw new Error(`Lỗi tải liên kết phụ huynh: ${linkErr.message}`);
  }

  const verifiedLinks = (parentLinks ?? []).filter(
    (l) => l.parent_id === ctx.userId && l.is_verified === true && isUUID(l.student_id as string),
  );

  if (verifiedLinks.length === 0) {
    return [];
  }

  const studentIds = Array.from(new Set(verifiedLinks.map((l) => l.student_id as string)));

  const { data: studentRows, error: stuErr } = await supabase
    .from('students')
    .select('id, code, full_name, birth_date, gender, avatar, status, created_at, updated_at')
    .in('id', studentIds);
  if (stuErr) {
    throw new Error(`Lỗi tải thông tin học sinh: ${stuErr.message}`);
  }

  const { data: membershipRows, error: memErr } = await supabase
    .from('class_memberships')
    .select('class_id, student_id, is_active')
    .in('student_id', studentIds)
    .eq('is_active', true);
  if (memErr) {
    throw new Error(`Lỗi tải liên kết lớp của học sinh: ${memErr.message}`);
  }

  const studentClassMap = new Map<string, string>();
  for (const m of membershipRows ?? []) {
    if (m.is_active) {
      studentClassMap.set(m.student_id as string, m.class_id as string);
    }
  }

  const classIds = Array.from(new Set(Array.from(studentClassMap.values())));
  const { data: classRows, error: clsErr } = classIds.length
    ? await supabase
        .from('classes')
        .select('id, name, school_year, subject, color')
        .in('id', classIds)
    : { data: [], error: null };
  if (clsErr) {
    throw new Error(`Lỗi tải thông tin lớp học: ${clsErr.message}`);
  }

  const classById = new Map<
    string,
    { id: string; name: string; schoolYear: string; subject?: string; color: string }
  >();
  for (const c of classRows ?? []) {
    classById.set(c.id as string, {
      id: c.id as string,
      name: c.name as string,
      schoolYear: c.school_year as string,
      subject: (c.subject as string | null) ?? undefined,
      color: (c.color as string) || '#F7A8C4',
    });
  }

  const { data: attRows, error: attErr } = await supabase
    .from('attendance')
    .select('id, class_id, student_id, date, session, status, note, updated_at')
    .in('student_id', studentIds)
    .order('date', { ascending: false });
  if (attErr) {
    throw new Error(`Lỗi tải chuyên cần: ${attErr.message}`);
  }

  const { data: ptRows, error: ptErr } = await supabase
    .from('student_points')
    .select('id, class_id, student_id, criterion_id, criterion_name, delta, note, batch_id, undone, created_at')
    .in('student_id', studentIds)
    .eq('undone', false)
    .order('created_at', { ascending: false });
  if (ptErr) {
    throw new Error(`Lỗi tải điểm thi đua: ${ptErr.message}`);
  }

  const { data: cmtRows, error: cmtErr } = await supabase
    .from('weekly_comments')
    .select(
      'id, class_id, student_id, week_number, school_year, date, content, status, sent_at, tags, created_at, updated_at',
    )
    .in('student_id', studentIds)
    .eq('status', 'sent')
    .order('date', { ascending: false });
  if (cmtErr) {
    throw new Error(`Lỗi tải nhận xét tuần: ${cmtErr.message}`);
  }

  const studentById = new Map<string, Record<string, unknown>>();
  for (const s of studentRows ?? []) {
    studentById.set(s.id as string, s as Record<string, unknown>);
  }

  const results: ParentPortalStudentData[] = [];

  for (const link of verifiedLinks) {
    const sid = link.student_id as string;
    const sRow = studentById.get(sid);
    if (!sRow) continue;

    const cId = studentClassMap.get(sid);
    const clsInfo = cId ? classById.get(cId) ?? null : null;

    const studentAttendance: AttendanceRecord[] = (attRows ?? [])
      .filter((a) => (a.student_id as string) === sid)
      .map((a) => {
        const sess = ((a.session as string) === 'afternoon' ? 'afternoon' : 'morning') as Session;
        return {
          id: attendanceId(a.class_id as string, a.date as string, sess, sid),
          classId: a.class_id as string,
          studentId: sid,
          date: a.date as string,
          session: sess,
          status: (a.status as AttendanceStatus) || 'present',
          note: (a.note as string | null) ?? undefined,
          updatedAt: a.updated_at ? new Date(a.updated_at as string).getTime() : Date.now(),
        };
      });

    const studentPoints: PointTransaction[] = (ptRows ?? [])
      .filter((p) => (p.student_id as string) === sid && !p.undone)
      .map((p) => ({
        id: p.id as string,
        classId: p.class_id as string,
        studentId: sid,
        criterionId: (p.criterion_id as string | null) ?? null,
        criterionName: p.criterion_name as string,
        delta: Number(p.delta),
        note: (p.note as string | null) ?? undefined,
        actor: 'Giáo viên lớp',
        batchId: p.batch_id as string,
        createdAt: p.created_at ? new Date(p.created_at as string).getTime() : Date.now(),
        undone: false,
      }));

    // Chỉ hiển thị nhận xét có status === 'sent' (defense-in-depth kết hợp cùng RLS)
    const studentSentComments: StudentComment[] = (cmtRows ?? [])
      .filter((c) => (c.student_id as string) === sid && (c.status as string) === 'sent')
      .map((c) => ({
        id: c.id as string,
        classId: c.class_id as string,
        studentId: sid,
        date: c.date as string,
        session: 'all',
        content: c.content as string,
        tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
        status: 'sent',
        sentAt: c.sent_at ? new Date(c.sent_at as string).getTime() : undefined,
        createdAt: c.created_at ? new Date(c.created_at as string).getTime() : Date.now(),
        updatedAt: c.updated_at ? new Date(c.updated_at as string).getTime() : Date.now(),
      }));

    results.push({
      student: {
        id: sid,
        code: sRow.code as string,
        fullName: sRow.full_name as string,
        birthDate: (sRow.birth_date as string | null) ?? undefined,
        gender: ((sRow.gender as Student['gender'] | null) ?? '') as Student['gender'],
        avatar: (sRow.avatar as string) || 'cat-pink',
        status: ((sRow.status as Student['status']) || 'active') as Student['status'],
      },
      relationship: (link.relationship as string) || 'Phụ huynh',
      verifiedAt: (link.verified_at as string | null) ?? null,
      classInfo: clsInfo,
      attendance: studentAttendance,
      points: studentPoints,
      sentComments: studentSentComments,
    });
  }

  return results;
}

/* ---------------- Tasks (hoạt động cần hoàn thành) ---------------- */

export async function addTask(classId: string, title: string, dueDate?: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  if (!title.trim()) throw new ValidationError({ title: 'Vui lòng nhập tên hoạt động' });
  if (title.trim().length > 120) throw new ValidationError({ title: 'Tối đa 120 ký tự' });
  const t: TodoTask = { id: uid('td_'), classId, title: title.trim(), dueDate: dueDate || undefined, done: false, createdAt: Date.now() };
  await scope.db.tasks.add(t);
}

export async function toggleTask(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const t = await scope.db.tasks.get(id);
  if (t) await scope.db.tasks.update(id, { done: !t.done });
}

export async function deleteTask(id: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  await scope.db.tasks.delete(id);
}

/* ---------------- Game picks ---------------- */

export async function saveGamePick(classId: string, student: Student, roundId: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  await scope.db.gamePicks.add({
    id: uid('g_'),
    classId,
    studentId: student.id,
    studentName: student.fullName,
    game: 'ufo-beam',
    roundId,
    createdAt: Date.now(),
  });
  await logActivity(classId, 'game', `UFO gắp học sinh ${student.fullName}`, scope.db);
}

export async function clearGamePicks(classId: string, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  await scope.db.gamePicks.where('classId').equals(classId).delete();
}

/* ---------------- Backup ---------------- */

export const BACKUP_FORMAT = 'pink-classroom-backup';

export async function exportBackup(targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const data: Record<string, unknown[]> = {};
  for (const t of ALL_TABLES) data[t] = await scope.db.table(t).toArray();
  return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), data };
}

export async function importBackup(json: unknown, targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  const obj = json as { format?: string; data?: Record<string, unknown[]> };
  if (!obj || obj.format !== BACKUP_FORMAT || !obj.data) throw new Error('File không phải bản sao lưu Pink Classroom');
  for (const t of ALL_TABLES) {
    if (obj.data[t] !== undefined && !Array.isArray(obj.data[t])) throw new Error(`Dữ liệu bảng ${t} bị hỏng`);
  }
  await scope.db.transaction('rw', ALL_TABLES.map((t) => scope.db.table(t)), async () => {
    for (const t of ALL_TABLES) {
      await scope.db.table(t).clear();
      const rows = obj.data![t];
      if (rows?.length) await scope.db.table(t).bulkAdd(rows);
    }
  });
}

export async function wipeAll(targetDb?: PinkDB) {
  const scope = getOperationScope(targetDb);
  await scope.db.transaction('rw', ALL_TABLES.map((t) => scope.db.table(t)), async () => {
    for (const t of ALL_TABLES) {
      if (t === 'kv') continue;
      await scope.db.table(t).clear();
    }
  });
}
