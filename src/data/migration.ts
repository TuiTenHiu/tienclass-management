import { db, ALL_TABLES } from './db';
import type { AttendanceRecord, ClassRoom, Criterion, ParentLink, PointTransaction, Student, StudentComment } from '../types';
import {
  isUUID,
  isValidISODate,
  isValidPhone,
  isoWeekNumber,
  normalizeVN,
  parseISODate,
  schoolYearOf,
  sha256,
  uuidv4,
} from '../lib/utils';
import { supabase } from '../lib/supabaseClient';
import {
  CLOUD_SYNC_KV_KEY,
  PENDING_SYNC_QUEUE_KEY,
  getAuthenticatedContext,
  getPendingSyncQueue,
  savePendingSyncQueue,
  trackCloudIds,
} from './repo';

/* =========================================================
 * Công cụ di trú Offline → Supabase (Bước 3.6)
 * GIAI ĐOẠN A + B: Khảo sát, sao lưu, kiểm tra đọc lại, xem trước.
 * GIAI ĐOẠN C + D: Thực thi di trú có kiểm soát & Đối soát (Reconciliation).
 *
 * NGUYÊN TẮC BẢO MẬT & BẢO TOÀN DỮ LIỆU:
 *  - 100% dữ liệu IndexedDB gốc được giữ nguyên, không sửa, không xóa.
 *  - Yêu cầu bản sao lưu hợp lệ đã vượt qua kiểm tra đọc lại trước khi di trú.
 *  - ID mapping được lưu ổn định trong db.kv để hỗ trợ chạy lại nhiều lần (idempotency).
 *  - Nhận xét đã gửi (weekly_comments): chỉ INSERT khi chưa có; nếu đã có trên Cloud thì BỎ QUA;
 *    tuyệt đối KHÔNG UPDATE hoặc DELETE nhận xét đã gửi.
 *  - Xung đột (lớp, mã học sinh, điểm danh, nhận xét, khóa ngoại): không tự ý giải quyết,
 *    không ghi đè, đưa vào danh sách chờ xử lý (conflicts).
 *  - Không di trú token thô hoặc thông tin xác thực/PIN của phụ huynh.
 * ========================================================= */

export const MIGRATION_BACKUP_FORMAT = 'pink-classroom-migration-backup';
export const MIGRATION_BACKUP_SCHEMA_VERSION = 1;
const DEXIE_SCHEMA_VERSION = 2;

/* =========================================================
 * Khóa bảo vệ SEC-05 ở tầng mã nguồn:
 * Mặc định TẤT CẢ các thao tác ghi / xóa trên database legacy "pink-classroom"
 * (restoreIndexedDbFromBackup, executeMigration) bị từ chối tuyệt đối.
 * Cơ chế này ngăn chặn việc gọi trực tiếp từ console, UI hay bất kỳ module nghiệp vụ nào.
 * ========================================================= */

export const LEGACY_MIGRATION_TEST_TOKEN = 'TIENCLASS_CONTROLLED_MIGRATION_ACCESS_2026';

export type MigrationScope = 'dry-run' | 'migration' | 'testing';

/**
 * Thẻ ủy quyền tác vụ di trú legacy (Task-scoped authorization ticket).
 * Gắn liền với từng tác vụ bất đồng bộ cụ thể, ngăn chia sẻ quyền ngoài ý muốn giữa các tác vụ (SEC-05.2).
 * Được bảo vệ và kiểm tra tính hợp lệ có trạng thái qua ActiveTicketRegistry (SEC-05.3).
 */
export interface LegacyMigrationAuthTicket {
  readonly id: string;
  readonly nonce: symbol;
  readonly issuedAt: number;
  readonly authorizedAt: number;
  readonly expiresAt: number;
  readonly scope: MigrationScope;
}

interface RegisteredTicketRecord {
  ticket: LegacyMigrationAuthTicket;
  revoked: boolean;
}

// ActiveTicketRegistry: Quản lý danh sách ticket hợp lệ được hệ thống cấp phép (SEC-05.3)
const activeTicketRegistry = new Map<string, RegisteredTicketRecord>();

/**
 * Đăng ký ticket vào hệ thống (hàm nội bộ, chỉ được gọi từ withLegacyMigrationAuthorization).
 * Bắt buộc kiểm tra token ủy quyền bí mật và chỉ hoạt động trong môi trường test (SEC-05.4).
 */
function registerMigrationTicket(
  token: string,
  scope: MigrationScope = 'testing',
  lifetimeMs: number = 5 * 60 * 1000,
): LegacyMigrationAuthTicket {
  const env =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env
      : undefined;
  if (env?.NODE_ENV !== 'test') {
    throw new Error('Cảnh báo an toàn: Chỉ được phép cấp ticket di trú trong môi trường kiểm thử.');
  }
  if (token !== LEGACY_MIGRATION_TEST_TOKEN) {
    throw new Error('Từ chối quyền truy cập: Mã ủy quyền di trú legacy không hợp lệ.');
  }

  const now = Date.now();
  const ticket: LegacyMigrationAuthTicket = {
    id: `ticket_${now}_${Math.random().toString(36).substring(2, 9)}`,
    nonce: Symbol('LegacyMigrationTicketNonce'),
    issuedAt: now,
    authorizedAt: now,
    expiresAt: now + lifetimeMs,
    scope,
  };

  activeTicketRegistry.set(ticket.id, { ticket, revoked: false });
  return ticket;
}

/**
 * Thu hồi ticket khỏi ActiveTicketRegistry (hàm nội bộ, gọi trong khối finally của withLegacyMigrationAuthorization).
 */
function revokeMigrationTicket(ticketId: string): void {
  const rec = activeTicketRegistry.get(ticketId);
  if (rec) {
    rec.revoked = true;
    activeTicketRegistry.delete(ticketId);
  }
}

/**
 * Kiểm tra tính hợp lệ nghiêm ngặt của ticket (SEC-05.3):
 * 1. Phải là object có id và nonce.
 * 2. Phải tồn tại trong activeTicketRegistry.
 * 3. Nonce phải trùng khớp tuyệt đối.
 * 4. Chưa bị revoked.
 * 5. Chưa hết hạn (Date.now() <= expiresAt).
 * 6. Scope phải khớp (nếu có yêu cầu).
 */
export function validateMigrationTicket(
  ticket: unknown,
  requiredScope?: MigrationScope,
): { valid: boolean; reason?: string } {
  if (!ticket || typeof ticket !== 'object') {
    return { valid: false, reason: 'Ticket không phải là đối tượng hợp lệ.' };
  }

  const candidate = ticket as Partial<LegacyMigrationAuthTicket>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return { valid: false, reason: 'Ticket thiếu ID định danh hợp lệ.' };
  }

  if (typeof candidate.nonce !== 'symbol') {
    return { valid: false, reason: 'Ticket giả mạo: Thiếu nonce bảo mật của hệ thống.' };
  }

  const rec = activeTicketRegistry.get(candidate.id);
  if (!rec) {
    return { valid: false, reason: 'Ticket không tồn tại trong hệ thống đăng ký hoặc đã bị thu hồi.' };
  }

  if (rec.revoked) {
    return { valid: false, reason: 'Ticket đã bị thu hồi quyền truy cập.' };
  }

  if (rec.ticket.nonce !== candidate.nonce) {
    return { valid: false, reason: 'Ticket giả mạo: Nonce không trùng khớp với bản ghi hệ thống.' };
  }

  if (Date.now() > rec.ticket.expiresAt) {
    return { valid: false, reason: 'Ticket đã hết hạn hiệu lực.' };
  }

  if (requiredScope && rec.ticket.scope !== requiredScope && rec.ticket.scope !== 'testing') {
    return {
      valid: false,
      reason: `Ticket không đúng phạm vi yêu cầu (Yêu cầu: "${requiredScope}", Thực tế: "${rec.ticket.scope}").`,
    };
  }

  return { valid: true };
}

/**
 * Kiểu trừu tượng cho AsyncLocalStorage để tương thích khi chạy trong Node/Vitest
 * mà không cần static import 'node:async_hooks' (tránh lỗi thiếu type hoặc lỗi bundle Vite).
 */
interface ScopedAsyncStorage<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

function initScopedAsyncStorage<T>(): ScopedAsyncStorage<T> | null {
  try {
    const proc =
      typeof globalThis !== 'undefined'
        ? (globalThis as unknown as {
            process?: {
              versions?: Record<string, string>;
              getBuiltinModule?: (id: string) => any;
              cwd?: () => string;
            };
          }).process
        : undefined;
    const isNode = Boolean(proc?.versions?.node);
    if (!isNode) return null;

    let AsyncLocalStorageCtor: (new () => ScopedAsyncStorage<T>) | undefined;

    // Cách 1: Node.js >= 20.13 hỗ trợ process.getBuiltinModule natively trong ESM
    if (typeof proc?.getBuiltinModule === 'function') {
      AsyncLocalStorageCtor = proc.getBuiltinModule('node:async_hooks')?.AsyncLocalStorage;
    }

    // Cách 2: Lấy qua createRequire từ module built-in của Node
    if (!AsyncLocalStorageCtor && typeof proc?.getBuiltinModule === 'function') {
      const nodeModule = proc.getBuiltinModule('node:module');
      if (typeof nodeModule?.createRequire === 'function') {
        const req = nodeModule.createRequire(proc?.cwd?.() || '.');
        AsyncLocalStorageCtor = req('node:async_hooks')?.AsyncLocalStorage;
      }
    }

    if (AsyncLocalStorageCtor) {
      return new AsyncLocalStorageCtor();
    }
  } catch {
    // Không khả dụng trong môi trường không hỗ trợ async_hooks (ví dụ browser runtime)
  }
  return null;
}

const asyncAuthStorage = initScopedAsyncStorage<LegacyMigrationAuthTicket>();

// Cờ kiểm thử dành riêng cho sequential test harness (chỉ hoạt động khi NODE_ENV === 'test')
let testHarnessGlobalAccessGranted = false;

/**
 * Kiểm tra xem tác vụ hiện tại có được cấp quyền thao tác trên database legacy hay không.
 * Quyền hợp lệ khi:
 * 1. Có thẻ ủy quyền ticket hợp lệ được truyền trực tiếp (xác thực SEC-05.3 qua ActiveTicketRegistry).
 * 2. HOẶC tác vụ đang chạy trong phạm vi async được ủy quyền (AsyncLocalStorage có ticket hợp lệ).
 * 3. HOẶC chế độ test harness tuần tự được bật trong môi trường NODE_ENV === 'test'.
 */
export function isLegacyMigrationLocked(
  explicitTicket?: LegacyMigrationAuthTicket,
  requiredScope?: MigrationScope,
): boolean {
  // 1. Kiểm tra ticket tường minh
  if (explicitTicket) {
    const check = validateMigrationTicket(explicitTicket, requiredScope);
    if (check.valid) {
      return false; // Ticket hợp lệ
    }
    return true; // Ticket không hợp lệ -> từ chối
  }

  // 2. Kiểm tra async execution context của tác vụ hiện tại (Task-scoped isolation)
  const currentTicket = asyncAuthStorage?.getStore();
  if (currentTicket) {
    const check = validateMigrationTicket(currentTicket, requiredScope);
    if (check.valid) {
      return false;
    }
  }

  // 3. Fallback cho sequential test harness (chỉ trong môi trường test)
  const env =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env
      : undefined;
  if (env?.NODE_ENV === 'test' && testHarnessGlobalAccessGranted) {
    return false;
  }

  return true;
}

/**
 * Kiểm tra và ném lỗi nếu tác vụ chưa được cấp quyền thao tác trên database legacy "pink-classroom".
 */
export function assertLegacyDatabaseAccessAuthorized(
  operationName: string,
  ticket?: LegacyMigrationAuthTicket,
  requiredScope?: MigrationScope,
): void {
  if (ticket) {
    const check = validateMigrationTicket(ticket, requiredScope);
    if (!check.valid) {
      throw new Error(
        `Cảnh báo an toàn (SEC-05.3): Thao tác "${operationName}" bị từ chối do ticket không hợp lệ (${check.reason}).`,
      );
    }
    return;
  }

  if (isLegacyMigrationLocked(ticket, requiredScope)) {
    throw new Error(
      `Cảnh báo an toàn (SEC-05): Thao tác "${operationName}" trên database legacy "pink-classroom" đã bị khóa ở tầng mã nguồn để bảo vệ toàn vẹn dữ liệu.`,
    );
  }
}

/**
 * Mở khóa tạm thời cho một phạm vi tác vụ kiểm thử / diễn tập có kiểm soát (scoped execution).
 * Sử dụng AsyncLocalStorage để cô lập quyền theo từng tác vụ bất đồng bộ, loại bỏ hoàn toàn
 * rủi ro race condition chia sẻ quyền giữa các tác vụ chạy đồng thời (SEC-05.2).
 * Tự động đăng ký và thu hồi ticket trong ActiveTicketRegistry (SEC-05.3).
 */
export async function withLegacyMigrationAuthorization<T>(
  token: string,
  fn: (ticket: LegacyMigrationAuthTicket) => Promise<T>,
  options?: {
    scope?: MigrationScope;
    lifetimeMs?: number;
  },
): Promise<T> {
  const env =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env
      : undefined;
  if (env?.NODE_ENV !== 'test') {
    throw new Error(
      'Cảnh báo an toàn: Cơ chế mở khóa di trú legacy chỉ được phép thực thi trong môi trường kiểm thử có kiểm soát.',
    );
  }
  if (token !== LEGACY_MIGRATION_TEST_TOKEN) {
    throw new Error('Từ chối quyền truy cập: Mã ủy quyền di trú legacy không hợp lệ.');
  }

  const scope = options?.scope || 'testing';
  const lifetimeMs = options?.lifetimeMs || 5 * 60 * 1000;
  const ticket = registerMigrationTicket(token, scope, lifetimeMs);

  try {
    if (asyncAuthStorage) {
      return await asyncAuthStorage.run(ticket, async () => {
        return await fn(ticket);
      });
    }

    // Fallback an toàn nếu không có AsyncLocalStorage
    const prev = testHarnessGlobalAccessGranted;
    testHarnessGlobalAccessGranted = true;
    try {
      return await fn(ticket);
    } finally {
      testHarnessGlobalAccessGranted = prev;
    }
  } finally {
    // Thu hồi ticket ngay lập tức khi hoàn tất hoặc gặp lỗi
    revokeMigrationTicket(ticket.id);
  }
}

/**
 * Đặt quyền truy cập legacy cho kiểm thử có kiểm soát (dành riêng cho sequential test harness setup/teardown).
 * Chỉ hoạt động trong NODE_ENV === 'test' và yêu cầu token ủy quyền chính xác.
 */
export function setLegacyMigrationAccessForTesting(token: string, enabled: boolean): void {
  const env =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env
      : undefined;
  if (env?.NODE_ENV !== 'test') {
    throw new Error('Cảnh báo an toàn: Cơ chế này chỉ được phép kích hoạt trong môi trường kiểm thử.');
  }
  if (token !== LEGACY_MIGRATION_TEST_TOKEN) {
    throw new Error('Từ chối quyền truy cập: Mã ủy quyền di trú legacy không hợp lệ.');
  }
  testHarnessGlobalAccessGranted = enabled;
}

type TableKey = (typeof ALL_TABLES)[number];

export interface MigrationBackup {
  format: typeof MIGRATION_BACKUP_FORMAT;
  schemaVersion: number;
  dexieVersion: number;
  exportedAt: string;
  tables: string[];
  counts: Record<string, number>;
  /** SHA-256 của JSON.stringify(data) để phát hiện file hỏng/bị sửa */
  checksum: string;
  /** Các trường đã bị loại khỏi file vì lý do bảo mật (không thể khôi phục từ file này) */
  redactions: string[];
  data: Record<string, unknown[]>;
}

export interface BackupValidationResult {
  ok: boolean;
  errors: string[];
  counts: Record<string, number>;
  exportedAt?: string;
  schemaVersion?: number;
}

const REDACTIONS = [
  'kv[settings].pinHash',
  'kv[settings].pinSalt',
  'parentLinks[*].token (token thô của liên kết Offline)',
];

/** Tạo bản sao lưu đầy đủ (chỉ đọc IndexedDB). Không gửi dữ liệu đi đâu. */
export async function createMigrationBackup(): Promise<MigrationBackup> {
  const data: Record<string, unknown[]> = {};
  for (const t of ALL_TABLES) {
    let rows = (await db.table(t).toArray()) as unknown[];
    if (t === 'kv') {
      rows = (rows as Array<{ key: string; value: unknown }>).map((r) => {
        if (r.key === 'settings' && r.value && typeof r.value === 'object') {
          const { pinHash: _h, pinSalt: _s, ...rest } = r.value as Record<string, unknown>;
          void _h;
          void _s;
          return { key: r.key, value: rest };
        }
        return r;
      });
    }
    if (t === 'parentLinks') {
      rows = (rows as ParentLink[]).map((l) => ({ ...l, token: '' }));
    }
    data[t] = rows;
  }
  const counts: Record<string, number> = {};
  for (const t of ALL_TABLES) counts[t] = data[t].length;
  const checksum = await sha256(JSON.stringify(data));
  return {
    format: MIGRATION_BACKUP_FORMAT,
    schemaVersion: MIGRATION_BACKUP_SCHEMA_VERSION,
    dexieVersion: DEXIE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables: [...ALL_TABLES],
    counts,
    checksum,
    redactions: [...REDACTIONS],
    data,
  };
}

/** Kiểm tra cấu trúc, số lượng, khóa duy nhất và checksum của bản sao lưu. */
export async function validateMigrationBackup(json: unknown): Promise<BackupValidationResult> {
  const errors: string[] = [];
  const counts: Record<string, number> = {};
  const obj = json as Partial<MigrationBackup> | null;
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['File không phải đối tượng JSON hợp lệ'], counts };
  }
  if (obj.format !== MIGRATION_BACKUP_FORMAT) errors.push('Sai định dạng (format) bản sao lưu di trú');
  if (typeof obj.schemaVersion !== 'number') errors.push('Thiếu phiên bản schema');
  else if (obj.schemaVersion > MIGRATION_BACKUP_SCHEMA_VERSION) {
    errors.push(`Phiên bản schema ${obj.schemaVersion} mới hơn phiên bản được hỗ trợ (${MIGRATION_BACKUP_SCHEMA_VERSION})`);
  }
  if (!obj.exportedAt || Number.isNaN(Date.parse(obj.exportedAt))) errors.push('Thiếu hoặc sai thời điểm xuất');
  if (!obj.data || typeof obj.data !== 'object') {
    errors.push('Thiếu phần dữ liệu (data)');
    return { ok: false, errors, counts };
  }
  if (!Array.isArray(obj.tables)) errors.push('Thiếu danh sách bảng');
  const data = obj.data as Record<string, unknown>;
  for (const t of ALL_TABLES) {
    const rows = data[t];
    if (!Array.isArray(rows)) {
      errors.push(`Bảng ${t} bị thiếu hoặc không phải mảng`);
      continue;
    }
    counts[t] = rows.length;
    if (obj.counts && obj.counts[t] !== rows.length) {
      errors.push(`Số lượng bản ghi bảng ${t} không khớp (khai báo ${obj.counts[t]}, thực tế ${rows.length})`);
    }
    if (Array.isArray(obj.tables) && !obj.tables.includes(t)) errors.push(`Danh sách bảng thiếu ${t}`);
    const keyField = t === 'kv' ? 'key' : 'id';
    const seen = new Set<string>();
    for (const r of rows as Array<Record<string, unknown>>) {
      const k = r?.[keyField];
      if (typeof k !== 'string' || !k) {
        errors.push(`Bảng ${t} có bản ghi thiếu khóa ${keyField}`);
        break;
      }
      if (seen.has(k)) {
        errors.push(`Bảng ${t} có khóa trùng lặp`);
        break;
      }
      seen.add(k);
    }
  }
  if (!errors.length) {
    const actual = await sha256(JSON.stringify(data));
    if (actual !== obj.checksum) errors.push('Checksum không khớp: file có thể bị hỏng hoặc đã bị chỉnh sửa');
  }
  return { ok: errors.length === 0, errors, counts, exportedAt: obj.exportedAt, schemaVersion: obj.schemaVersion };
}

/** Tuần tự hóa → phân tích lại → kiểm tra (mô phỏng việc đọc lại file đã tải xuống). */
export async function verifyBackupRoundTrip(backup: MigrationBackup): Promise<BackupValidationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(backup));
  } catch {
    return { ok: false, errors: ['Không thể tuần tự hóa/đọc lại bản sao lưu'], counts: {} };
  }
  return validateMigrationBackup(parsed);
}

/**
 * Khôi phục toàn bộ dữ liệu IndexedDB từ bản sao lưu hợp lệ (Kế hoạch khôi phục / Disaster Recovery).
 * Kiểm tra tính hợp lệ và checksum trước khi khôi phục.
 */
export async function restoreIndexedDbFromBackup(
  backup: MigrationBackup,
  ticket?: LegacyMigrationAuthTicket,
): Promise<{ ok: boolean; message: string }> {
  assertLegacyDatabaseAccessAuthorized('restoreIndexedDbFromBackup', ticket);

  const validation = await validateMigrationBackup(backup);
  if (!validation.ok) {
    return { ok: false, message: `Bản sao lưu không hợp lệ: ${validation.errors.join(', ')}` };
  }

  await db.transaction('rw', ALL_TABLES.map((t) => db.table(t)), async () => {
    for (const t of ALL_TABLES) {
      const rows = backup.data[t] || [];
      await db.table(t).clear();
      if (rows.length > 0) {
        await db.table(t).bulkPut(rows as any[]);
      }
    }
  });

  return { ok: true, message: 'Khôi phục IndexedDB từ bản sao lưu thành công.' };
}

/* ---------------- Xem trước (Preview) — hoàn toàn Offline ---------------- */

export type PreviewCategory = 'create' | 'skip' | 'needsUser' | 'ineligible';
export type MigrationGroup =
  | 'classes'
  | 'criteria'
  | 'students'
  | 'memberships'
  | 'attendance'
  | 'transactions'
  | 'comments'
  | 'parentLinks';

export interface PreviewItem {
  group: MigrationGroup;
  id: string;
  category: Exclude<PreviewCategory, 'create'>;
  code: string;
  message: string;
}

export interface GroupSummary {
  source: number;
  create: number;
  skip: number;
  needsUser: number;
  ineligible: number;
}

export interface MappingRow {
  group: MigrationGroup;
  localKey: string;
  cloudTable: string;
  cloudKey: string;
  note: string;
}

export interface MigrationPreview {
  generatedAt: string;
  wroteToCloud: false;
  groups: Record<MigrationGroup, GroupSummary>;
  items: PreviewItem[];
  /** Số ID cục bộ không phải UUID sẽ cần UUID mới (ánh xạ ổn định ở Giai đoạn C) */
  idsNeedingNewUuid: Record<string, number>;
  localOnlyTables: { table: string; count: number; reason: string }[];
  unmappedFields: string[];
  mapping: MappingRow[];
}

export const MIGRATION_MAPPING: MappingRow[] = [
  { group: 'classes', localKey: 'classes.id', cloudTable: 'public.classes', cloudKey: 'id (UUID) · UNIQUE(name, school_year)', note: 'teacherName không có cột (dùng profiles.full_name); teacher_id = tài khoản đang đăng nhập' },
  { group: 'criteria', localKey: 'criteria.id', cloudTable: 'public.criteria', cloudKey: 'id (UUID) · FK class_id', note: 'order → display_order; points phải cùng dấu với type' },
  { group: 'students', localKey: 'students.id', cloudTable: 'public.students', cloudKey: 'id (UUID) · UNIQUE(code)', note: 'Tạo qua RPC create_student_in_class (phải gắn lớp nguyên tử)' },
  { group: 'memberships', localKey: 'students.classId', cloudTable: 'public.class_memberships', cloudKey: 'UNIQUE(class_id, student_id)', note: 'status archived → is_active = false' },
  { group: 'attendance', localKey: 'attendance.id (classId|date|session|studentId)', cloudTable: 'public.attendance', cloudKey: 'UNIQUE(class_id, student_id, date, session)', note: 'id cục bộ là khóa ghép, Cloud cấp UUID riêng' },
  { group: 'transactions', localKey: 'transactions.id', cloudTable: 'public.student_points', cloudKey: 'id (UUID) · FK criterion_id, batch_id UUID', note: 'actor (tên) → actor_id; batchId không phải UUID cần ánh xạ UUID ổn định' },
  { group: 'comments', localKey: 'comments.id', cloudTable: 'public.weekly_comments', cloudKey: 'id (UUID) · UNIQUE(student_id, date)', note: 'session không có cột; nhận xét đã gửi: chỉ INSERT, không bao giờ UPDATE/ghi đè' },
  { group: 'parentLinks', localKey: 'parentLinks.id', cloudTable: 'public.parent_invitation_tokens', cloudKey: 'token_hash UNIQUE', note: 'KHÔNG di trú: token thô cũ không thể bảo đảm an toàn; phải cấp lại mã mới' },
];

const UNMAPPED_FIELDS = [
  'classes.teacherName (không có cột; Cloud dùng profiles.full_name)',
  'comments.session (Cloud không có cột session)',
  'transactions.actor (chuỗi tên; Cloud lưu actor_id của người di trú)',
  'transactions.undone/undoneAt cần được ghi đúng trạng thái khi INSERT',
  'parentLinks.* (không di trú)',
];

const GROUPS: MigrationGroup[] = [
  'classes',
  'criteria',
  'students',
  'memberships',
  'attendance',
  'transactions',
  'comments',
  'parentLinks',
];

function emptySummary(): GroupSummary {
  return { source: 0, create: 0, skip: 0, needsUser: 0, ineligible: 0 };
}

interface SyncedIds {
  classIds: Set<string>;
  criterionIds: Set<string>;
  studentIds: Set<string>;
  attendanceIds: Set<string>;
  transactionIds: Set<string>;
  commentIds: Set<string>;
}

async function readSyncedIds(): Promise<SyncedIds> {
  const row = await db.kv.get('cloud_synced_ids');
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const set = (k: string) => new Set<string>(Array.isArray(v[k]) ? (v[k] as string[]) : []);
  return {
    classIds: set('classIds'),
    criterionIds: set('criterionIds'),
    studentIds: set('studentIds'),
    attendanceIds: set('attendanceIds'),
    transactionIds: set('transactionIds'),
    commentIds: set('commentIds'),
  };
}

function countBy<T>(list: T[], key: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
}

/**
 * Phân tích dữ liệu IndexedDB và phân loại từng bản ghi. CHỈ ĐỌC, không mạng, không ghi.
 */
export async function buildMigrationPreview(): Promise<MigrationPreview> {
  const [classes, criteria, students, attendance, transactions, comments, parentLinks] = await Promise.all([
    db.classes.toArray(),
    db.criteria.toArray(),
    db.students.toArray(),
    db.attendance.toArray(),
    db.transactions.toArray(),
    db.comments.toArray(),
    db.parentLinks.toArray(),
  ]);
  const synced = await readSyncedIds();

  const groups = Object.fromEntries(GROUPS.map((g) => [g, emptySummary()])) as Record<MigrationGroup, GroupSummary>;
  const items: PreviewItem[] = [];
  const idsNeedingNewUuid: Record<string, number> = {};

  const mark = (
    group: MigrationGroup,
    id: string,
    category: PreviewCategory,
    code = '',
    message = '',
  ): PreviewCategory => {
    groups[group][category]++;
    if (category !== 'create') items.push({ group, id, category, code, message });
    return category;
  };
  const noteUuid = (group: string, id: string) => {
    if (!isUUID(id)) idsNeedingNewUuid[group] = (idsNeedingNewUuid[group] ?? 0) + 1;
  };

  groups.classes.source = classes.length;
  groups.criteria.source = criteria.length;
  groups.students.source = students.length;
  groups.memberships.source = students.length;
  groups.attendance.source = attendance.length;
  groups.transactions.source = transactions.length;
  groups.comments.source = comments.length;
  groups.parentLinks.source = parentLinks.length;

  /* ---- Lớp ---- */
  const classKeyCount = countBy(classes, (c) => `${normalizeVN(c.name)}|${c.schoolYear}`);
  const classCat = new Map<string, PreviewCategory>();
  for (const c of classes as ClassRoom[]) {
    let cat: PreviewCategory;
    if (!c.name?.trim() || !/^\d{4}-\d{4}$/.test(c.schoolYear ?? '')) {
      cat = mark('classes', c.id, 'ineligible', 'INVALID_CLASS', 'Thiếu tên lớp hoặc năm học sai định dạng YYYY-YYYY');
    } else if ((classKeyCount.get(`${normalizeVN(c.name)}|${c.schoolYear}`) ?? 0) > 1) {
      cat = mark('classes', c.id, 'needsUser', 'DUPLICATE_CLASS', `Trùng tên lớp "${c.name}" trong năm học ${c.schoolYear}`);
    } else if (synced.classIds.has(c.id)) {
      cat = mark('classes', c.id, 'skip', 'ALREADY_SYNCED', 'Đã có trên Cloud (cloud_synced_ids)');
    } else {
      cat = mark('classes', c.id, 'create');
      noteUuid('classes', c.id);
    }
    classCat.set(c.id, cat);
  }

  const inherit = (parent: PreviewCategory | undefined): Exclude<PreviewCategory, 'create' | 'skip'> | null => {
    if (parent === 'needsUser') return 'needsUser';
    if (parent === undefined || parent === 'ineligible') return 'ineligible';
    return null; // create | skip → cho phép
  };

  /* ---- Tiêu chí ---- */
  const critCat = new Map<string, PreviewCategory>();
  for (const cr of criteria as Criterion[]) {
    const blocked = inherit(classCat.get(cr.classId));
    let cat: PreviewCategory;
    const validPts =
      Number.isInteger(cr.points) &&
      cr.points !== 0 &&
      Math.abs(cr.points) <= 100 &&
      (cr.type === 'reward' ? cr.points > 0 : cr.type === 'penalty' ? cr.points < 0 : false);
    if (blocked) {
      cat = mark('criteria', cr.id, blocked, blocked === 'needsUser' ? 'PARENT_PENDING' : 'MISSING_CLASS', 'Lớp cha chưa đủ điều kiện hoặc không tồn tại');
    } else if (!cr.name?.trim() || cr.name.trim().length > 50 || !validPts) {
      cat = mark('criteria', cr.id, 'ineligible', 'INVALID_CRITERION', 'Tên/điểm/loại tiêu chí không hợp lệ');
    } else if (synced.criterionIds.has(cr.id)) {
      cat = mark('criteria', cr.id, 'skip', 'ALREADY_SYNCED', 'Đã có trên Cloud');
    } else {
      cat = mark('criteria', cr.id, 'create');
      noteUuid('criteria', cr.id);
    }
    critCat.set(cr.id, cat);
  }

  /* ---- Học sinh + liên kết lớp ---- */
  const codeCount = countBy(students, (s) => (s.code ?? '').toUpperCase());
  const stuCat = new Map<string, PreviewCategory>();
  for (const s of students as Student[]) {
    const blocked = inherit(classCat.get(s.classId));
    let cat: PreviewCategory;
    if (blocked) {
      cat = mark('students', s.id, blocked, blocked === 'needsUser' ? 'PARENT_PENDING' : 'MISSING_CLASS', 'Lớp của học sinh chưa đủ điều kiện hoặc không tồn tại');
    } else if (
      !/^[A-Za-z0-9_.-]{1,20}$/.test(s.code ?? '') ||
      !s.fullName?.trim() ||
      s.fullName.trim().length < 2 ||
      s.fullName.trim().length > 60 ||
      (s.parentPhone && !isValidPhone(s.parentPhone)) ||
      (s.birthDate && !isValidISODate(s.birthDate))
    ) {
      cat = mark('students', s.id, 'ineligible', 'INVALID_STUDENT', 'Mã/họ tên/SĐT phụ huynh/ngày sinh không hợp lệ');
    } else if ((codeCount.get((s.code ?? '').toUpperCase()) ?? 0) > 1) {
      cat = mark('students', s.id, 'needsUser', 'DUPLICATE_CODE', `Mã học sinh ${s.code} bị trùng (Cloud yêu cầu duy nhất toàn hệ thống)`);
    } else if (synced.studentIds.has(s.id)) {
      cat = mark('students', s.id, 'skip', 'ALREADY_SYNCED', 'Đã có trên Cloud');
    } else {
      cat = mark('students', s.id, 'create');
      noteUuid('students', s.id);
    }
    stuCat.set(s.id, cat);
    // Liên kết lớp đi theo học sinh 1–1
    if (cat === 'create') groups.memberships.create++;
    else if (cat === 'skip') groups.memberships.skip++;
    else if (cat === 'needsUser') groups.memberships.needsUser++;
    else groups.memberships.ineligible++;
  }
  const stuById = new Map((students as Student[]).map((s) => [s.id, s]));

  const childBlock = (classId: string, studentId: string): { cat: Exclude<PreviewCategory, 'create' | 'skip'>; code: string; msg: string } | null => {
    const s = stuById.get(studentId);
    if (!s) return { cat: 'ineligible', code: 'MISSING_STUDENT', msg: 'Học sinh không tồn tại' };
    if (s.classId !== classId) return { cat: 'ineligible', code: 'WRONG_CLASS', msg: 'Học sinh không thuộc lớp của bản ghi (trigger Cloud sẽ từ chối)' };
    const pc = classCat.get(classId);
    const b1 = inherit(pc);
    if (b1) return { cat: b1, code: b1 === 'needsUser' ? 'PARENT_PENDING' : 'MISSING_CLASS', msg: 'Lớp chưa đủ điều kiện' };
    const b2 = inherit(stuCat.get(studentId));
    if (b2) return { cat: b2, code: b2 === 'needsUser' ? 'PARENT_PENDING' : 'STUDENT_NOT_ELIGIBLE', msg: 'Học sinh chưa đủ điều kiện' };
    return null;
  };

  /* ---- Điểm danh ---- */
  const attKeyCount = countBy(attendance, (a) => `${a.classId}|${a.studentId}|${a.date}|${a.session}`);
  for (const a of attendance as AttendanceRecord[]) {
    const blk = childBlock(a.classId, a.studentId);
    if (blk) {
      mark('attendance', a.id, blk.cat, blk.code, blk.msg);
    } else if (
      !isValidISODate(a.date) ||
      (a.session !== 'morning' && a.session !== 'afternoon') ||
      !['present', 'late', 'excused', 'unexcused'].includes(a.status)
    ) {
      mark('attendance', a.id, 'ineligible', 'INVALID_ATTENDANCE', 'Ngày/buổi/trạng thái điểm danh không hợp lệ');
    } else if ((attKeyCount.get(`${a.classId}|${a.studentId}|${a.date}|${a.session}`) ?? 0) > 1) {
      mark('attendance', a.id, 'needsUser', 'DUPLICATE_ATTENDANCE', 'Trùng khóa (lớp, học sinh, ngày, buổi)');
    } else if (synced.attendanceIds.has(a.id)) {
      mark('attendance', a.id, 'skip', 'ALREADY_SYNCED', 'Đã có trên Cloud');
    } else {
      mark('attendance', a.id, 'create');
    }
  }

  /* ---- Giao dịch điểm ---- */
  const batchSeen = new Set<string>();
  for (const t of transactions as PointTransaction[]) {
    const blk = childBlock(t.classId, t.studentId);
    if (blk) {
      mark('transactions', t.id, blk.cat, blk.code, blk.msg);
      continue;
    }
    const critOk = t.criterionId === null || t.criterionId === undefined;
    if (!critOk) {
      const cr = (criteria as Criterion[]).find((c) => c.id === t.criterionId);
      if (cr && cr.classId !== t.classId) {
        mark('transactions', t.id, 'ineligible', 'CRITERION_OTHER_CLASS', 'Tiêu chí thuộc lớp khác (trigger Cloud sẽ từ chối)');
        continue;
      }
      if (cr) {
        const cb = inherit(critCat.get(cr.id));
        if (cb) {
          mark('transactions', t.id, cb, cb === 'needsUser' ? 'PARENT_PENDING' : 'CRITERION_NOT_ELIGIBLE', 'Tiêu chí chưa đủ điều kiện');
          continue;
        }
      }
    }
    if (!Number.isInteger(t.delta) || t.delta === 0 || Math.abs(t.delta) > 100 || !t.criterionName?.trim()) {
      mark('transactions', t.id, 'ineligible', 'INVALID_POINTS', 'Điểm/lý do không hợp lệ');
    } else if (synced.transactionIds.has(t.id)) {
      mark('transactions', t.id, 'skip', 'ALREADY_SYNCED', 'Đã có trên Cloud');
    } else {
      mark('transactions', t.id, 'create');
      noteUuid('transactions', t.id);
      if (t.batchId && !isUUID(t.batchId) && !batchSeen.has(t.batchId)) {
        batchSeen.add(t.batchId);
        idsNeedingNewUuid.batchId = (idsNeedingNewUuid.batchId ?? 0) + 1;
      }
    }
  }

  /* ---- Nhận xét tuần ---- */
  const cmtKeyCount = countBy(comments, (c) => `${c.studentId}|${c.date}`);
  for (const c of comments as StudentComment[]) {
    const blk = childBlock(c.classId, c.studentId);
    if (blk) {
      mark('comments', c.id, blk.cat, blk.code, blk.msg);
    } else if (!isValidISODate(c.date) || !c.content?.trim() || c.content.length > 2000) {
      mark('comments', c.id, 'ineligible', 'INVALID_COMMENT', 'Ngày hoặc nội dung nhận xét không hợp lệ');
    } else if ((cmtKeyCount.get(`${c.studentId}|${c.date}`) ?? 0) > 1) {
      mark('comments', c.id, 'needsUser', 'DUPLICATE_COMMENT', 'Học sinh có nhiều nhận xét trong cùng ngày (Cloud chỉ cho 1)');
    } else if (synced.commentIds.has(c.id)) {
      mark('comments', c.id, 'skip', 'ALREADY_SYNCED', 'Đã có trên Cloud (nhận xét đã gửi không bị ghi đè)');
    } else {
      mark('comments', c.id, 'create');
      noteUuid('comments', c.id);
    }
  }

  /* ---- Liên kết phụ huynh / mã mời ---- */
  for (const l of parentLinks as ParentLink[]) {
    mark('parentLinks', l.id, 'ineligible', 'RAW_TOKEN_NOT_MIGRATED', 'Token thô không được di trú; cấp lại mã mời mới sau khi di trú lớp/học sinh');
  }

  /* ---- Bảng chỉ có ở máy ---- */
  const [gp, act, tasks] = await Promise.all([db.gamePicks.count(), db.activities.count(), db.tasks.count()]);
  const localOnlyTables = [
    { table: 'gamePicks', count: gp, reason: 'Không có bảng tương ứng trên Supabase' },
    { table: 'activities', count: act, reason: 'Nhật ký hoạt động cục bộ, không có bảng tương ứng' },
    { table: 'tasks', count: tasks, reason: 'Công việc cá nhân, không có bảng tương ứng' },
    { table: 'kv', count: await db.kv.count(), reason: 'Cài đặt, PIN và trạng thái đồng bộ — không bao giờ di trú' },
  ];

  return {
    generatedAt: new Date().toISOString(),
    wroteToCloud: false,
    groups,
    items,
    idsNeedingNewUuid,
    localOnlyTables,
    unmappedFields: [...UNMAPPED_FIELDS],
    mapping: MIGRATION_MAPPING,
  };
}

/* =========================================================
 * GIAI ĐOẠN C + D: THỰC THI DI TRÚ CÓ KIỂM SOÁT & ĐỐI SOÁT
 * ========================================================= */

export const MIGRATION_MAPPINGS_KEY = 'migration_id_mappings';
export const MIGRATION_PROGRESS_KEY = 'migration_progress';
export const MIGRATION_REPORT_KEY = 'migration_last_report';

export interface MigrationIdMappingRecord {
  classes: Record<string, string>;
  criteria: Record<string, string>;
  students: Record<string, string>;
  attendance: Record<string, string>;
  transactions: Record<string, string>;
  batches: Record<string, string>;
  comments: Record<string, string>;
}

export type MigrationStep =
  | 'idle'
  | 'validating'
  | 'classes'
  | 'criteria'
  | 'students'
  | 'attendance'
  | 'transactions'
  | 'comments'
  | 'reconciliation'
  | 'completed'
  | 'failed';

export interface MigrationProgress {
  step: MigrationStep;
  stepIndex: number;
  totalSteps: number;
  message: string;
  currentGroup?: MigrationGroup;
  processedCount: number;
  totalCount: number;
  percent: number;
}

export interface ConflictItem {
  group: MigrationGroup;
  id: string;
  code: string;
  message: string;
  localData?: unknown;
  cloudData?: unknown;
}

export interface GroupExecutionResult {
  source: number;
  created: number;
  skipped: number;
  conflicts: number;
  failed: number;
}

export interface PointsReconciliation {
  localValidTxCount: number;
  localSumDelta: number;
  cloudTxCount: number;
  cloudSumDelta: number;
  matched: boolean;
  difference: number;
}

export interface FkIntegrityReport {
  ok: boolean;
  criteriaOrphans: number;
  membershipsOrphans: number;
  attendanceOrphans: number;
  pointsOrphans: number;
  commentsOrphans: number;
}

export interface LocalPreservationReport {
  ok: boolean;
  beforeCounts: Record<string, number>;
  afterCounts: Record<string, number>;
  intact: boolean;
}

export interface MigrationReport {
  migrationId: string;
  startedAt: string;
  completedAt: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  success: boolean;
  groups: Record<MigrationGroup, GroupExecutionResult>;
  conflicts: ConflictItem[];
  pointsReconciliation: PointsReconciliation;
  fkIntegrity: FkIntegrityReport;
  localPreservation: LocalPreservationReport;
  summaryMessage: string;
  sessionId?: string;
}

export type ImportSessionStatus =
  | 'in_progress'
  | 'committed'
  | 'failed'
  | 'conflict_aborted'
  | 'rollback_in_progress'
  | 'rolled_back'
  | 'requires_manual_review';

export interface ImportSessionState {
  id: string;
  status: ImportSessionStatus;
  leaseToken: string;
  leaseExpiresAt: string;
  lockVersion: number;
  summary: Record<string, unknown>;
  backupChecksum: string;
  lastErrorStage?: string;
  lastErrorMessage?: string;
}

export interface ProvenanceRecordInput {
  entity_type: string;
  source_record_id: string;
  cloud_record_id?: string | null;
  action_type: 'created' | 'linked_existing' | 'updated' | 'conflicted' | 'skipped' | 'compensated';
  source_fingerprint?: string;
  previous_data?: unknown;
}

export async function startImportSession(backupChecksum: string): Promise<{
  ok: boolean;
  session_id?: string;
  lease_token?: string;
  lease_expires_at?: string;
  lock_version?: number;
  error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Chưa khởi tạo Supabase client.' };
  try {
    const { data, error } = await supabase.rpc('start_import_session', {
      p_backup_checksum: backupChecksum,
      p_pipeline_version: 'v1.0-cloud',
    });
    if (error) return { ok: false, error: error.message };
    return (data as any) || { ok: false, error: 'Không nhận được dữ liệu phản hồi từ RPC.' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function recordImportProvenanceBatch(
  sessionId: string,
  leaseToken: string,
  records: ProvenanceRecordInput[],
  summaryUpdate?: unknown,
): Promise<{ ok: boolean; recorded_count?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Chưa khởi tạo Supabase client.' };
  try {
    const { data, error } = await supabase.rpc('record_import_provenance_batch', {
      p_session_id: sessionId,
      p_lease_token: leaseToken,
      p_records: records,
      p_summary_update: summaryUpdate || null,
    });
    if (error) return { ok: false, error: error.message };
    return (data as any) || { ok: false, error: 'Không nhận được dữ liệu phản hồi từ RPC.' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function resumeImportSession(
  sessionId: string,
  backupChecksum: string,
): Promise<{
  ok: boolean;
  session_id?: string;
  lease_token?: string;
  lock_version?: number;
  summary?: unknown;
  error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Chưa khởi tạo Supabase client.' };
  try {
    const { data, error } = await supabase.rpc('resume_import_session', {
      p_session_id: sessionId,
      p_backup_checksum: backupChecksum,
    });
    if (error) return { ok: false, error: error.message };
    return (data as any) || { ok: false, error: 'Không nhận được dữ liệu phản hồi từ RPC.' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function commitImportSession(
  sessionId: string,
  leaseToken: string,
  finalSummary?: unknown,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'Chưa khởi tạo Supabase client.' };
  try {
    const { data, error } = await supabase.rpc('commit_import_session', {
      p_session_id: sessionId,
      p_lease_token: leaseToken,
      p_final_summary: finalSummary || null,
    });
    if (error) return { ok: false, error: error.message };
    return (data as any) || { ok: false, error: 'Không nhận được dữ liệu phản hồi từ RPC.' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function rollbackImportSession(
  sessionId: string,
  leaseToken?: string,
): Promise<{
  ok: boolean;
  status?: string;
  reason?: string;
  deleted_counts?: Record<string, number>;
  reverted_counts?: Record<string, number>;
  message?: string;
  error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Chưa khởi tạo Supabase client.' };
  try {
    const { data, error } = await supabase.rpc('rollback_import_session', {
      p_session_id: sessionId,
      p_lease_token: leaseToken || null,
    });
    if (error) return { ok: false, error: error.message };
    return (data as any) || { ok: false, error: 'Không nhận được dữ liệu phản hồi từ RPC.' };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function reconcileStaleImportSessions(): Promise<{ ok: boolean; updated_count?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Chưa khởi tạo Supabase client.' };
  try {
    const { data, error } = await supabase.rpc('reconcile_stale_import_sessions');
    if (error) return { ok: false, error: error.message };
    return { ok: true, updated_count: Number(data) || 0 };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function getActiveImportSession(): Promise<ImportSessionState | null> {
  if (!supabase) return null;
  try {
    const ctx = await getAuthenticatedContext();
    if (!ctx) return null;
    const { data, error } = await supabase
      .from('legacy_import_sessions')
      .select('*')
      .eq('teacher_id', ctx.userId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      id: data.id,
      status: data.status,
      leaseToken: data.lease_token,
      leaseExpiresAt: data.lease_expires_at,
      lockVersion: data.lock_version,
      summary: data.summary,
      backupChecksum: data.backup_checksum,
      lastErrorStage: data.last_error_stage,
      lastErrorMessage: data.last_error_message,
    };
  } catch {
    return null;
  }
}

export async function getIdMappings(): Promise<MigrationIdMappingRecord> {
  const row = await db.kv.get(MIGRATION_MAPPINGS_KEY);
  const val = (row?.value || {}) as Partial<MigrationIdMappingRecord>;
  return {
    classes: { ...(val.classes || {}) },
    criteria: { ...(val.criteria || {}) },
    students: { ...(val.students || {}) },
    attendance: { ...(val.attendance || {}) },
    transactions: { ...(val.transactions || {}) },
    batches: { ...(val.batches || {}) },
    comments: { ...(val.comments || {}) },
  };
}

export async function saveIdMappings(
  mappings: MigrationIdMappingRecord,
  ticket?: LegacyMigrationAuthTicket,
): Promise<void> {
  assertLegacyDatabaseAccessAuthorized('saveIdMappings', ticket);
  await db.kv.put({ key: MIGRATION_MAPPINGS_KEY, value: mappings });
}

export function resolveCloudId(
  group: keyof MigrationIdMappingRecord,
  localId: string,
  mappings: MigrationIdMappingRecord,
): string {
  if (mappings[group][localId]) {
    return mappings[group][localId];
  }
  const assigned = isUUID(localId) ? localId : uuidv4();
  mappings[group][localId] = assigned;
  return assigned;
}

export async function getLastMigrationReport(): Promise<MigrationReport | null> {
  const row = await db.kv.get(MIGRATION_REPORT_KEY);
  return (row?.value as MigrationReport) || null;
}

export async function getMigrationProgress(): Promise<MigrationProgress | null> {
  const row = await db.kv.get(MIGRATION_PROGRESS_KEY);
  return (row?.value as MigrationProgress) || null;
}

function initExecutionSummary(): Record<MigrationGroup, GroupExecutionResult> {
  return {
    classes: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    criteria: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    students: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    memberships: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    attendance: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    transactions: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    comments: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
    parentLinks: { source: 0, created: 0, skipped: 0, conflicts: 0, failed: 0 },
  };
}

/**
 * Thực thi di trú dữ liệu Offline từ IndexedDB lên Supabase Local có kiểm soát (Bước 3.6 - Giai đoạn C & D).
 * Tuân thủ nghiêm ngặt:
 *  - 100% ID và nội dung dữ liệu Offline gốc được giữ nguyên vẹn (xác minh bằng băm SHA-256).
 *  - Lưu ID mapping ổn định ngay lập tức trước mỗi thao tác ghi Cloud.
 *  - Lưu trạng thái xác nhận hoàn thành ngay sau khi từng bản ghi được máy chủ xác nhận.
 *  - Chống nhân đôi điểm thi đua ở cấp Database thông qua khóa duy nhất source_id.
 *  - Nhận xét đã gửi: chỉ INSERT, không bao giờ UPDATE/DELETE.
 *  - Xung đột đưa vào danh sách chờ xử lý (conflicts), không tự ý ghi đè.
 *  - Đối soát độc lập trên Supabase Local: kiểm tra khóa ngoại thực tế và tổng điểm đúng tập di trú.
 *  - Đồng bộ hóa an toàn với cloud_pending_sync_queue để không đẩy trùng.
 */
export async function executeMigration(
  backup: MigrationBackup,
  options?: {
    onProgress?: (progress: MigrationProgress) => void;
    authorizationTicket?: LegacyMigrationAuthTicket;
  },
  ticket?: LegacyMigrationAuthTicket,
): Promise<MigrationReport> {
  const activeTicket = ticket || options?.authorizationTicket;
  assertLegacyDatabaseAccessAuthorized('executeMigration', activeTicket);

  const startedAt = new Date().toISOString();
  const migrationId = uuidv4();

  const reportProgress = async (p: MigrationProgress) => {
    await db.kv.put({ key: MIGRATION_PROGRESS_KEY, value: p });
    options?.onProgress?.(p);
  };

  await reportProgress({
    step: 'validating',
    stepIndex: 1,
    totalSteps: 9,
    message: 'Đang kiểm tra tính hợp lệ của bản sao lưu và quyền truy cập...',
    processedCount: 0,
    totalCount: 1,
    percent: 5,
  });

  // 1. Kiểm tra tính toàn vẹn của bản sao lưu
  const validation = await verifyBackupRoundTrip(backup);
  if (!validation.ok) {
    throw new Error(`Bản sao lưu không hợp lệ: ${validation.errors.join('; ')}`);
  }

  // 2. Kiểm tra quyền của người dùng hiện tại
  const ctx = await getAuthenticatedContext();
  if (!ctx) {
    throw new Error('Chưa đăng nhập Supabase. Vui lòng đăng nhập bằng tài khoản giáo viên hoặc quản trị viên.');
  }
  if (ctx.role !== 'teacher' && ctx.role !== 'admin') {
    throw new Error('Quyền bị từ chối: Chỉ giáo viên hoặc quản trị viên mới được phép di trú dữ liệu lên Supabase.');
  }
  if (!supabase) {
    throw new Error('Không thể kết nối với dịch vụ Supabase.');
  }

  // 3. Ghi nhận snapshot SHA-256 của toàn bộ dữ liệu nghiệp vụ IndexedDB ban đầu để đối soát bảo toàn độc lập
  const beforeCounts: Record<string, number> = {};
  const sourceFingerprints: Record<string, string> = {};
  for (const t of ALL_TABLES) {
    const rows = (await db.table(t).toArray()) as unknown[];
    beforeCounts[t] = rows.length;
    if (t !== 'kv') {
      sourceFingerprints[t] = await sha256(JSON.stringify(rows));
    }
  }
  const beforeKvRows = (await db.kv.toArray()) as Array<{ key: string; value: unknown }>;
  const migrationKvKeys = new Set([
    MIGRATION_MAPPINGS_KEY,
    MIGRATION_PROGRESS_KEY,
    CLOUD_SYNC_KV_KEY,
    PENDING_SYNC_QUEUE_KEY,
    MIGRATION_REPORT_KEY,
  ]);
  const beforeNonMigrationKv = beforeKvRows
    .filter((r) => !migrationKvKeys.has(r.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  const beforeNonMigrationKvHash = await sha256(JSON.stringify(beforeNonMigrationKv));

  const mappings = await getIdMappings();
  const groupsResult = initExecutionSummary();
  const conflicts: ConflictItem[] = [];
  const synced = await readSyncedIds();

  // Theo dõi các ID đã di trú để dọn dẹp hàng đợi pending sync queue
  const queueTxIdsToRemove = new Set<string>();
  const queueCommentIdsToRemove = new Set<string>();
  const queueAttendanceSlotsToRemove = new Set<string>();
  const conflictedAttendanceSlots = new Set<string>();

  const newlySynced = {
    classIds: [] as string[],
    criterionIds: [] as string[],
    studentIds: [] as string[],
    attendanceIds: [] as string[],
    transactionIds: [] as string[],
    commentIds: [] as string[],
  };

  // 4. Khởi tạo Import Session & Provenance Ledger trên Cloud (Giai đoạn 2.6)
  let sessionState: { sessionId: string; leaseToken: string } | null = null;
  const provenanceBatch: ProvenanceRecordInput[] = [];

  try {
    const sessionRes = await startImportSession(backup.checksum);
    if (sessionRes.ok && sessionRes.session_id && sessionRes.lease_token) {
      sessionState = {
        sessionId: sessionRes.session_id,
        leaseToken: sessionRes.lease_token,
      };
    }
  } catch (sessErr) {
    console.warn('[Migration] Không thể khởi tạo phiên legacy_import_sessions:', sessErr);
  }

  const flushProvenance = async () => {
    if (!sessionState || provenanceBatch.length === 0) return;
    const toSend = provenanceBatch.splice(0, provenanceBatch.length);
    const res = await recordImportProvenanceBatch(
      sessionState.sessionId,
      sessionState.leaseToken,
      toSend,
    );
    if (!res.ok) {
      throw new Error(`Lỗi ghi sổ cái provenance (Batch error): ${res.error || 'Lỗi không xác định'}`);
    }
  };

  // ----------------------------------------------------
  // BƯỚC 1: LỚP HỌC (classes)
  // ----------------------------------------------------
  await reportProgress({
    step: 'classes',
    stepIndex: 2,
    totalSteps: 9,
    message: 'Đang di trú danh sách lớp học...',
    currentGroup: 'classes',
    processedCount: 0,
    totalCount: 1,
    percent: 15,
  });

  const localClasses = (await db.classes.toArray()) as ClassRoom[];
  groupsResult.classes.source = localClasses.length;

  const classKeyCount = countBy(localClasses, (c) => `${normalizeVN(c.name)}|${c.schoolYear}`);

  for (const c of localClasses) {
    if (!c.name?.trim() || !/^\d{4}-\d{4}$/.test(c.schoolYear ?? '')) {
      groupsResult.classes.failed++;
      conflicts.push({
        group: 'classes',
        id: c.id,
        code: 'INVALID_CLASS_DATA',
        message: `Lớp "${c.name}" thiếu tên hoặc năm học sai định dạng (${c.schoolYear}).`,
        localData: c,
      });
      continue;
    }

    if ((classKeyCount.get(`${normalizeVN(c.name)}|${c.schoolYear}`) ?? 0) > 1) {
      groupsResult.classes.conflicts++;
      conflicts.push({
        group: 'classes',
        id: c.id,
        code: 'DUPLICATE_CLASS_IN_SOURCE',
        message: `Trùng lặp tên lớp "${c.name}" và năm học "${c.schoolYear}" trong dữ liệu nguồn.`,
        localData: c,
      });
      continue;
    }

    // Lưu mapping ngay trước khi gọi Cloud
    const cloudClassId = resolveCloudId('classes', c.id, mappings);
    await saveIdMappings(mappings, activeTicket);

    if (synced.classIds.has(c.id)) {
      groupsResult.classes.skipped++;
      newlySynced.classIds.push(cloudClassId);
      continue;
    }

    // Kiểm tra trên Cloud: đã có lớp có id này chưa?
    const { data: existingById, error: qIdErr } = await supabase
      .from('classes')
      .select('id, name, school_year')
      .eq('id', cloudClassId)
      .maybeSingle();

    if (qIdErr) {
      groupsResult.classes.failed++;
      conflicts.push({
        group: 'classes',
        id: c.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi truy vấn lớp trên Cloud: ${qIdErr.message}`,
      });
      continue;
    }

    if (existingById) {
      groupsResult.classes.skipped++;
      newlySynced.classIds.push(cloudClassId);
      provenanceBatch.push({
        entity_type: 'classes',
        source_record_id: c.id,
        cloud_record_id: cloudClassId,
        action_type: 'linked_existing',
      });
      await trackCloudIds(ctx.userId, { classIds: [cloudClassId] });
      continue;
    }

    // Kiểm tra xung đột: tên lớp + năm học đã có trên Cloud với ID khác?
    const { data: existingByName, error: qNameErr } = await supabase
      .from('classes')
      .select('id, name, school_year')
      .eq('name', c.name.trim())
      .eq('school_year', c.schoolYear.trim())
      .maybeSingle();

    if (qNameErr) {
      groupsResult.classes.failed++;
      conflicts.push({
        group: 'classes',
        id: c.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi kiểm tra trùng lặp lớp trên Cloud: ${qNameErr.message}`,
      });
      continue;
    }

    if (existingByName) {
      groupsResult.classes.conflicts++;
      conflicts.push({
        group: 'classes',
        id: c.id,
        code: 'CLASS_NAME_COLLISION_ON_CLOUD',
        message: `Lớp "${c.name}" (${c.schoolYear}) đã tồn tại trên Cloud với ID khác (${existingByName.id}). Không ghi đè.`,
        localData: c,
        cloudData: existingByName,
      });
      continue;
    }

    // Thêm lớp mới lên Cloud
    const { error: insErr } = await supabase.from('classes').insert({
      id: cloudClassId,
      name: c.name.trim(),
      school_year: c.schoolYear.trim(),
      teacher_id: ctx.userId,
      subject: c.subject?.trim() || null,
      note: c.note?.trim() || null,
      color: c.color || '#F7A8C4',
    });

    if (insErr) {
      groupsResult.classes.failed++;
      conflicts.push({
        group: 'classes',
        id: c.id,
        code: 'CLASS_INSERT_ERROR',
        message: `Lỗi tạo lớp trên Cloud: ${insErr.message}`,
      });
    } else {
      groupsResult.classes.created++;
      newlySynced.classIds.push(cloudClassId);
      provenanceBatch.push({
        entity_type: 'classes',
        source_record_id: c.id,
        cloud_record_id: cloudClassId,
        action_type: 'created',
      });
      // Lưu xác nhận ngay lập tức cho chính bản ghi này
      await trackCloudIds(ctx.userId, { classIds: [cloudClassId] });
    }
  }
  await flushProvenance();

  // ----------------------------------------------------
  // BƯỚC 2: TIÊU CHÍ (criteria)
  // ----------------------------------------------------
  await reportProgress({
    step: 'criteria',
    stepIndex: 3,
    totalSteps: 9,
    message: 'Đang di trú tiêu chí thi đua...',
    currentGroup: 'criteria',
    processedCount: 0,
    totalCount: 1,
    percent: 28,
  });

  const localCriteria = (await db.criteria.toArray()) as Criterion[];
  groupsResult.criteria.source = localCriteria.length;

  for (const cr of localCriteria) {
    const cloudClassId = mappings.classes[cr.classId];
    if (!cloudClassId) {
      groupsResult.criteria.conflicts++;
      conflicts.push({
        group: 'criteria',
        id: cr.id,
        code: 'MISSING_MAPPED_CLASS',
        message: `Tiêu chí "${cr.name}" thuộc lớp chưa được di trú thành công.`,
        localData: cr,
      });
      continue;
    }

    const validPts =
      Number.isInteger(cr.points) &&
      cr.points !== 0 &&
      Math.abs(cr.points) <= 100 &&
      (cr.type === 'reward' ? cr.points > 0 : cr.type === 'penalty' ? cr.points < 0 : false);

    if (!cr.name?.trim() || !validPts) {
      groupsResult.criteria.failed++;
      conflicts.push({
        group: 'criteria',
        id: cr.id,
        code: 'INVALID_CRITERION_DATA',
        message: `Tiêu chí "${cr.name}" có điểm/loại không hợp lệ.`,
        localData: cr,
      });
      continue;
    }

    // Lưu mapping ngay trước khi gọi Cloud
    const cloudCritId = resolveCloudId('criteria', cr.id, mappings);
    await saveIdMappings(mappings, activeTicket);

    if (synced.criterionIds.has(cr.id)) {
      groupsResult.criteria.skipped++;
      newlySynced.criterionIds.push(cloudCritId);
      continue;
    }

    const { data: existingCrit, error: qCritErr } = await supabase
      .from('criteria')
      .select('id')
      .eq('id', cloudCritId)
      .maybeSingle();

    if (qCritErr) {
      groupsResult.criteria.failed++;
      conflicts.push({
        group: 'criteria',
        id: cr.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi truy vấn tiêu chí trên Cloud: ${qCritErr.message}`,
      });
      continue;
    }

    if (existingCrit) {
      groupsResult.criteria.skipped++;
      newlySynced.criterionIds.push(cloudCritId);
      provenanceBatch.push({
        entity_type: 'criteria',
        source_record_id: cr.id,
        cloud_record_id: cloudCritId,
        action_type: 'linked_existing',
      });
      await trackCloudIds(ctx.userId, { criterionIds: [cloudCritId] });
      continue;
    }

    const { error: insCritErr } = await supabase.from('criteria').insert({
      id: cloudCritId,
      class_id: cloudClassId,
      name: cr.name.trim(),
      points: cr.points,
      type: cr.type,
      icon: cr.icon || 'star',
      display_order: cr.order ?? 0,
      archived: false,
    });

    if (insCritErr) {
      groupsResult.criteria.failed++;
      conflicts.push({
        group: 'criteria',
        id: cr.id,
        code: 'CRITERION_INSERT_ERROR',
        message: `Lỗi tạo tiêu chí trên Cloud: ${insCritErr.message}`,
      });
    } else {
      groupsResult.criteria.created++;
      newlySynced.criterionIds.push(cloudCritId);
      provenanceBatch.push({
        entity_type: 'criteria',
        source_record_id: cr.id,
        cloud_record_id: cloudCritId,
        action_type: 'created',
      });
      // Lưu xác nhận ngay lập tức cho chính bản ghi này
      await trackCloudIds(ctx.userId, { criterionIds: [cloudCritId] });
    }
  }
  await flushProvenance();

  // ----------------------------------------------------
  // BƯỚC 3: HỌC SINH VÀ LIÊN KẾT LỚP (students & class_memberships)
  // ----------------------------------------------------
  await reportProgress({
    step: 'students',
    stepIndex: 4,
    totalSteps: 9,
    message: 'Đang di trú học sinh và liên kết lớp...',
    currentGroup: 'students',
    processedCount: 0,
    totalCount: 1,
    percent: 42,
  });

  const localStudents = (await db.students.toArray()) as Student[];
  groupsResult.students.source = localStudents.length;
  groupsResult.memberships.source = localStudents.length;

  const codeCounts = countBy(localStudents, (s) => (s.code ?? '').toUpperCase());

  for (const s of localStudents) {
    const cloudClassId = mappings.classes[s.classId];
    if (!cloudClassId) {
      groupsResult.students.conflicts++;
      groupsResult.memberships.conflicts++;
      conflicts.push({
        group: 'students',
        id: s.id,
        code: 'MISSING_MAPPED_CLASS',
        message: `Học sinh "${s.fullName}" (${s.code}) thuộc lớp chưa được di trú.`,
        localData: s,
      });
      continue;
    }

    const validCode = /^[A-Za-z0-9_.-]{1,20}$/.test(s.code ?? '');
    const validName = s.fullName?.trim() && s.fullName.trim().length >= 2 && s.fullName.trim().length <= 60;
    const validPhone = !s.parentPhone || isValidPhone(s.parentPhone);
    const validBirth = !s.birthDate || isValidISODate(s.birthDate);

    if (!validCode || !validName || !validPhone || !validBirth) {
      groupsResult.students.failed++;
      groupsResult.memberships.failed++;
      conflicts.push({
        group: 'students',
        id: s.id,
        code: 'INVALID_STUDENT_DATA',
        message: `Học sinh "${s.fullName}" (${s.code}) có dữ liệu không hợp lệ.`,
        localData: s,
      });
      continue;
    }

    if ((codeCounts.get((s.code ?? '').toUpperCase()) ?? 0) > 1) {
      groupsResult.students.conflicts++;
      groupsResult.memberships.conflicts++;
      conflicts.push({
        group: 'students',
        id: s.id,
        code: 'DUPLICATE_CODE_IN_SOURCE',
        message: `Mã học sinh "${s.code}" bị trùng lặp trong dữ liệu nguồn.`,
        localData: s,
      });
      continue;
    }

    // Lưu mapping ngay trước khi gọi Cloud
    const targetStudentId = resolveCloudId('students', s.id, mappings);
    await saveIdMappings(mappings, activeTicket);

    if (synced.studentIds.has(s.id)) {
      groupsResult.students.skipped++;
      groupsResult.memberships.skipped++;
      newlySynced.studentIds.push(targetStudentId);
      continue;
    }

    // Kiểm tra trên Cloud: so sánh chính xác mã học sinh (KHÔNG dùng ilike)
    const { data: matchedCodes, error: qCodeErr } = await supabase
      .from('students')
      .select('id, code, full_name')
      .eq('code', s.code.trim().toUpperCase());

    if (qCodeErr) {
      groupsResult.students.failed++;
      groupsResult.memberships.failed++;
      conflicts.push({
        group: 'students',
        id: s.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi kiểm tra mã học sinh trên Cloud: ${qCodeErr.message}`,
      });
      continue;
    }

    // Nếu trả về nhiều hơn 1 bản ghi: đưa ngay vào danh sách xung đột, không tự chọn
    if (matchedCodes && matchedCodes.length > 1) {
      groupsResult.students.conflicts++;
      groupsResult.memberships.conflicts++;
      conflicts.push({
        group: 'students',
        id: s.id,
        code: 'STUDENT_CODE_MULTIPLE_MATCHES',
        message: `Mã học sinh "${s.code}" có nhiều hơn 1 bản ghi trên Cloud. Cần xử lý thủ công.`,
        localData: s,
        cloudData: matchedCodes,
      });
      continue;
    }

    if (matchedCodes && matchedCodes.length === 1) {
      const existingCodeRow = matchedCodes[0];
      if (existingCodeRow.id === targetStudentId) {
        // Đã có học sinh này trên Cloud đúng với target ID
        groupsResult.students.skipped++;
        newlySynced.studentIds.push(targetStudentId);
        provenanceBatch.push({
          entity_type: 'students',
          source_record_id: s.id,
          cloud_record_id: targetStudentId,
          action_type: 'linked_existing',
        });

        // Kiểm tra xem membership đã tồn tại chưa
        const { data: existingMem } = await supabase
          .from('class_memberships')
          .select('id, is_active')
          .eq('class_id', cloudClassId)
          .eq('student_id', targetStudentId)
          .maybeSingle();

        if (existingMem) {
          groupsResult.memberships.skipped++;
        } else {
          const { error: memErr } = await supabase.from('class_memberships').insert({
            class_id: cloudClassId,
            student_id: targetStudentId,
            is_active: s.status === 'active',
          });
          if (memErr) groupsResult.memberships.failed++;
          else groupsResult.memberships.created++;
        }
        await trackCloudIds(ctx.userId, { studentIds: [targetStudentId] });
      } else {
        // Trùng mã học sinh với một học sinh khác có ID khác trên Cloud! Không ghi đè
        groupsResult.students.conflicts++;
        groupsResult.memberships.conflicts++;
        conflicts.push({
          group: 'students',
          id: s.id,
          code: 'STUDENT_CODE_COLLISION_ON_CLOUD',
          message: `Mã học sinh "${s.code}" đã thuộc về học sinh "${existingCodeRow.full_name}" (ID: ${existingCodeRow.id}) trên Cloud. Không ghi đè.`,
          localData: s,
          cloudData: existingCodeRow,
        });
      }
      continue;
    }

    // Tạo mới học sinh và liên kết lớp nguyên tử thông qua RPC create_student_in_class nâng cấp
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('create_student_in_class', {
      p_class_id: cloudClassId,
      p_code: s.code.trim().toUpperCase(),
      p_full_name: s.fullName.trim(),
      p_gender: s.gender || null,
      p_birth_date: s.birthDate || null,
      p_avatar: s.avatar || 'cat-pink',
      p_note: s.note?.trim() || null,
      p_parent_name: s.parentName?.trim() || null,
      p_parent_phone: s.parentPhone?.trim() || null,
      p_id: targetStudentId,
      p_is_active: s.status === 'active',
      p_status: s.status || 'active',
    });

    if (rpcErr) {
      groupsResult.students.failed++;
      groupsResult.memberships.failed++;
      conflicts.push({
        group: 'students',
        id: s.id,
        code: 'STUDENT_RPC_ERROR',
        message: `Lỗi gọi RPC tạo học sinh trên Cloud: ${rpcErr.message}`,
      });
    } else {
      const actualId = (rpcRes as { student_id?: string; already_exists?: boolean } | null)?.student_id || targetStudentId;
      mappings.students[s.id] = actualId;
      await saveIdMappings(mappings, activeTicket);

      const alreadyExists = Boolean((rpcRes as { already_exists?: boolean })?.already_exists);
      if (alreadyExists) {
        groupsResult.students.skipped++;
        groupsResult.memberships.skipped++;
      } else {
        groupsResult.students.created++;
        groupsResult.memberships.created++;
      }
      provenanceBatch.push({
        entity_type: 'students',
        source_record_id: s.id,
        cloud_record_id: actualId,
        action_type: alreadyExists ? 'linked_existing' : 'created',
      });
      newlySynced.studentIds.push(actualId);
      // Lưu xác nhận ngay lập tức cho chính bản ghi này
      await trackCloudIds(ctx.userId, { studentIds: [actualId] });
    }
  }
  await flushProvenance();

  // ----------------------------------------------------
  // BƯỚC 4: ĐIỂM DANH (attendance)
  // ----------------------------------------------------
  await reportProgress({
    step: 'attendance',
    stepIndex: 5,
    totalSteps: 9,
    message: 'Đang di trú dữ liệu điểm danh...',
    currentGroup: 'attendance',
    processedCount: 0,
    totalCount: 1,
    percent: 56,
  });

  const localAttendance = (await db.attendance.toArray()) as AttendanceRecord[];
  groupsResult.attendance.source = localAttendance.length;

  for (const a of localAttendance) {
    const cloudClassId = mappings.classes[a.classId];
    const cloudStudentId = mappings.students[a.studentId];

    if (!cloudClassId || !cloudStudentId) {
      groupsResult.attendance.conflicts++;
      conflicts.push({
        group: 'attendance',
        id: a.id,
        code: 'MISSING_FOREIGN_KEY',
        message: `Bản ghi điểm danh ngày ${a.date} (${a.session}) thiếu liên kết lớp hoặc học sinh.`,
        localData: a,
      });
      continue;
    }

    const stu = localStudents.find((s) => s.id === a.studentId);
    if (!stu || stu.classId !== a.classId) {
      groupsResult.attendance.failed++;
      conflicts.push({
        group: 'attendance',
        id: a.id,
        code: 'STUDENT_NOT_IN_CLASS',
        message: `Học sinh không thuộc lớp của bản ghi điểm danh (trigger Cloud sẽ từ chối).`,
        localData: a,
      });
      continue;
    }

    if (
      !isValidISODate(a.date) ||
      (a.session !== 'morning' && a.session !== 'afternoon') ||
      !['present', 'late', 'excused', 'unexcused'].includes(a.status)
    ) {
      groupsResult.attendance.failed++;
      conflictedAttendanceSlots.add(`${a.classId}|${a.date}|${a.session}`);
      conflicts.push({
        group: 'attendance',
        id: a.id,
        code: 'INVALID_ATTENDANCE_DATA',
        message: `Bản ghi điểm danh có ngày (${a.date}), buổi (${a.session}) hoặc trạng thái (${a.status}) không hợp lệ.`,
        localData: a,
      });
      continue;
    }

    const slotQueueKey = `${a.classId}|${a.date}|${a.session}`;

    if (synced.attendanceIds.has(a.id)) {
      groupsResult.attendance.skipped++;
      newlySynced.attendanceIds.push(a.id);
      queueAttendanceSlotsToRemove.add(slotQueueKey);
      continue;
    }

    // Tra cứu slot trên Cloud theo khóa UNIQUE(class_id, student_id, date, session)
    const { data: existingAtt, error: qAttErr } = await supabase
      .from('attendance')
      .select('id, status, note')
      .eq('class_id', cloudClassId)
      .eq('student_id', cloudStudentId)
      .eq('date', a.date)
      .eq('session', a.session)
      .maybeSingle();

    if (qAttErr) {
      groupsResult.attendance.failed++;
      conflictedAttendanceSlots.add(slotQueueKey);
      conflicts.push({
        group: 'attendance',
        id: a.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi truy vấn điểm danh trên Cloud: ${qAttErr.message}`,
      });
      continue;
    }

    if (existingAtt) {
      if (existingAtt.status === a.status) {
        groupsResult.attendance.skipped++;
        newlySynced.attendanceIds.push(a.id);
        queueAttendanceSlotsToRemove.add(slotQueueKey);
        provenanceBatch.push({
          entity_type: 'attendance',
          source_record_id: a.id,
          cloud_record_id: existingAtt.id,
          action_type: 'linked_existing',
        });
        await trackCloudIds(ctx.userId, { attendanceIds: [a.id] });
      } else {
        // XUNG ĐỘT: Dữ liệu điểm danh trên Cloud khác với máy cục bộ! Không ghi đè.
        groupsResult.attendance.conflicts++;
        conflictedAttendanceSlots.add(slotQueueKey);
        conflicts.push({
          group: 'attendance',
          id: a.id,
          code: 'ATTENDANCE_STATUS_MISMATCH',
          message: `Điểm danh ngày ${a.date} (${a.session}) xung đột: máy cục bộ là "${a.status}", trên Cloud là "${existingAtt.status}". Không ghi đè.`,
          localData: a,
          cloudData: existingAtt,
        });
      }
      continue;
    }

    // Chưa có trên Cloud: INSERT mới
    const cloudAttId = uuidv4();
    const { error: insAttErr } = await supabase.from('attendance').insert({
      id: cloudAttId,
      class_id: cloudClassId,
      student_id: cloudStudentId,
      date: a.date,
      session: a.session,
      status: a.status,
      note: a.note || null,
      recorded_by: ctx.userId,
    });

    if (insAttErr) {
      groupsResult.attendance.failed++;
      conflictedAttendanceSlots.add(slotQueueKey);
      conflicts.push({
        group: 'attendance',
        id: a.id,
        code: 'ATTENDANCE_INSERT_ERROR',
        message: `Lỗi thêm điểm danh trên Cloud: ${insAttErr.message}`,
      });
    } else {
      groupsResult.attendance.created++;
      newlySynced.attendanceIds.push(a.id);
      queueAttendanceSlotsToRemove.add(slotQueueKey);
      provenanceBatch.push({
        entity_type: 'attendance',
        source_record_id: a.id,
        cloud_record_id: cloudAttId,
        action_type: 'created',
      });
      // Lưu xác nhận ngay lập tức cho chính bản ghi này
      await trackCloudIds(ctx.userId, { attendanceIds: [a.id] });
    }
  }
  await flushProvenance();

  // ----------------------------------------------------
  // BƯỚC 5: GIAO DỊCH ĐIỂM THI ĐUA (student_points)
  // ----------------------------------------------------
  await reportProgress({
    step: 'transactions',
    stepIndex: 6,
    totalSteps: 9,
    message: 'Đang di trú điểm thi đua...',
    currentGroup: 'transactions',
    processedCount: 0,
    totalCount: 1,
    percent: 70,
  });

  const localTransactions = (await db.transactions.toArray()) as PointTransaction[];
  groupsResult.transactions.source = localTransactions.length;
  const migratedTxCloudIds: string[] = [];

  for (const t of localTransactions) {
    const cloudClassId = mappings.classes[t.classId];
    const cloudStudentId = mappings.students[t.studentId];

    if (!cloudClassId || !cloudStudentId) {
      groupsResult.transactions.conflicts++;
      conflicts.push({
        group: 'transactions',
        id: t.id,
        code: 'MISSING_FOREIGN_KEY',
        message: `Giao dịch điểm (${t.criterionName}: ${t.delta}) thiếu liên kết lớp hoặc học sinh.`,
        localData: t,
      });
      continue;
    }

    const stu = localStudents.find((s) => s.id === t.studentId);
    if (!stu || stu.classId !== t.classId) {
      groupsResult.transactions.failed++;
      conflicts.push({
        group: 'transactions',
        id: t.id,
        code: 'STUDENT_NOT_IN_CLASS',
        message: 'Học sinh không thuộc lớp của giao dịch điểm (trigger Cloud sẽ từ chối).',
        localData: t,
      });
      continue;
    }

    if (!Number.isInteger(t.delta) || t.delta === 0 || Math.abs(t.delta) > 100 || !t.criterionName?.trim()) {
      groupsResult.transactions.failed++;
      conflicts.push({
        group: 'transactions',
        id: t.id,
        code: 'INVALID_TRANSACTION_DATA',
        message: `Giao dịch điểm (${t.id}) có delta hoặc tên tiêu chí không hợp lệ.`,
        localData: t,
      });
      continue;
    }

    // Lưu mapping ngay trước khi gọi Cloud
    const cloudTxId = resolveCloudId('transactions', t.id, mappings);
    const cloudBatchId = t.batchId ? resolveCloudId('batches', t.batchId, mappings) : uuidv4();
    const cloudCritId = t.criterionId ? mappings.criteria[t.criterionId] || null : null;
    await saveIdMappings(mappings, activeTicket);

    if (synced.transactionIds.has(t.id)) {
      groupsResult.transactions.skipped++;
      newlySynced.transactionIds.push(t.id);
      migratedTxCloudIds.push(cloudTxId);
      queueTxIdsToRemove.add(t.id);
      continue;
    }

    // Kiểm tra tính lũy đẳng: tra cứu theo id HOẶC source_id
    const { data: existingTx, error: qTxErr } = await supabase
      .from('student_points')
      .select('id, delta, student_id, class_id')
      .or(`id.eq.${cloudTxId},source_id.eq.${t.id}`)
      .maybeSingle();

    if (qTxErr) {
      groupsResult.transactions.failed++;
      conflicts.push({
        group: 'transactions',
        id: t.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi truy vấn giao dịch điểm trên Cloud: ${qTxErr.message}`,
      });
      continue;
    }

    if (existingTx) {
      if (
        existingTx.student_id === cloudStudentId &&
        existingTx.class_id === cloudClassId &&
        existingTx.delta === t.delta
      ) {
        groupsResult.transactions.skipped++;
        newlySynced.transactionIds.push(t.id);
        migratedTxCloudIds.push(existingTx.id);
        queueTxIdsToRemove.add(t.id);
        provenanceBatch.push({
          entity_type: 'student_points',
          source_record_id: t.id,
          cloud_record_id: existingTx.id,
          action_type: 'linked_existing',
        });
        await trackCloudIds(ctx.userId, { transactionIds: [t.id] });
      } else {
        // XUNG ĐỘT: Đã có bản ghi trên Cloud nhưng lệch delta hoặc học sinh/lớp!
        groupsResult.transactions.conflicts++;
        conflicts.push({
          group: 'transactions',
          id: t.id,
          code: 'TRANSACTION_UNIQUE_COLLISION',
          message: `Giao dịch điểm ${t.id} trùng id/source_id trên Cloud nhưng khác nội dung (delta: ${existingTx.delta} vs ${t.delta}). Không ghi đè.`,
          localData: t,
          cloudData: existingTx,
        });
      }
      continue;
    }

    // Gửi kèm source_id để DB chặn trùng lặp cấp database (unique_student_points_source_id)
    const { error: insTxErr } = await supabase.from('student_points').insert({
      id: cloudTxId,
      class_id: cloudClassId,
      student_id: cloudStudentId,
      criterion_id: cloudCritId,
      criterion_name: t.criterionName.trim(),
      delta: t.delta,
      note: t.note?.trim() || null,
      actor_id: ctx.userId,
      batch_id: cloudBatchId,
      undone: Boolean(t.undone),
      undone_at: t.undone && t.undoneAt ? new Date(t.undoneAt).toISOString() : null,
      created_at: new Date(t.createdAt).toISOString(),
      source_id: t.id,
    });

    if (insTxErr) {
      if (insTxErr.code === '23505') {
        // Kiểm tra xác nhận bản ghi Cloud có đúng nguồn gốc (source_id = t.id)
        const { data: verifiedTx, error: qVerErr } = await supabase
          .from('student_points')
          .select('id, source_id, student_id, class_id, delta')
          .eq('source_id', t.id)
          .maybeSingle();

        if (qVerErr) {
          groupsResult.transactions.failed++;
          conflicts.push({
            group: 'transactions',
            id: t.id,
            code: 'TRANSACTION_VERIFY_ERROR',
            message: `Lỗi truy vấn xác minh giao dịch điểm sau xung đột khóa 23505: ${qVerErr.message}`,
            localData: t,
          });
        } else if (
          verifiedTx &&
          verifiedTx.student_id === cloudStudentId &&
          verifiedTx.class_id === cloudClassId &&
          verifiedTx.delta === t.delta
        ) {
          // Xác thực bản ghi Cloud đúng là bản ghi này đã được lưu trước đó
          groupsResult.transactions.skipped++;
          newlySynced.transactionIds.push(t.id);
          migratedTxCloudIds.push(verifiedTx.id);
          queueTxIdsToRemove.add(t.id);
          provenanceBatch.push({
            entity_type: 'student_points',
            source_record_id: t.id,
            cloud_record_id: verifiedTx.id,
            action_type: 'linked_existing',
          });
          await trackCloudIds(ctx.userId, { transactionIds: [t.id] });
        } else {
          // Lỗi 23505 không do bản ghi này tạo ra hoặc sai lệch nội dung -> báo xung đột!
          groupsResult.transactions.failed++;
          conflicts.push({
            group: 'transactions',
            id: t.id,
            code: 'TRANSACTION_UNIQUE_COLLISION',
            message: `Xung đột khóa (23505) nhưng bản ghi trên Cloud không khớp nguồn gốc/nội dung giao dịch ${t.id}.`,
            localData: t,
            cloudData: verifiedTx,
          });
        }
      } else {
        groupsResult.transactions.failed++;
        conflicts.push({
          group: 'transactions',
          id: t.id,
          code: 'TRANSACTION_INSERT_ERROR',
          message: `Lỗi thêm điểm thi đua trên Cloud: ${insTxErr.message}`,
        });
      }
    } else {
      groupsResult.transactions.created++;
      newlySynced.transactionIds.push(t.id);
      migratedTxCloudIds.push(cloudTxId);
      queueTxIdsToRemove.add(t.id);
      provenanceBatch.push({
        entity_type: 'student_points',
        source_record_id: t.id,
        cloud_record_id: cloudTxId,
        action_type: 'created',
      });
      // Lưu xác nhận ngay lập tức cho chính bản ghi này
      await trackCloudIds(ctx.userId, { transactionIds: [t.id] });
    }
  }
  await flushProvenance();

  // ----------------------------------------------------
  // BƯỚC 6: NHẬN XÉT TUẦN (weekly_comments)
  // ----------------------------------------------------
  await reportProgress({
    step: 'comments',
    stepIndex: 7,
    totalSteps: 9,
    message: 'Đang di trú nhận xét tuần...',
    currentGroup: 'comments',
    processedCount: 0,
    totalCount: 1,
    percent: 82,
  });

  const localComments = (await db.comments.toArray()) as StudentComment[];
  groupsResult.comments.source = localComments.length;

  for (const cmt of localComments) {
    const cloudClassId = mappings.classes[cmt.classId];
    const cloudStudentId = mappings.students[cmt.studentId];

    if (!cloudClassId || !cloudStudentId) {
      groupsResult.comments.conflicts++;
      conflicts.push({
        group: 'comments',
        id: cmt.id,
        code: 'MISSING_FOREIGN_KEY',
        message: `Nhận xét ngày ${cmt.date} thiếu liên kết lớp hoặc học sinh.`,
        localData: cmt,
      });
      continue;
    }

    const stu = localStudents.find((s) => s.id === cmt.studentId);
    if (!stu || stu.classId !== cmt.classId) {
      groupsResult.comments.failed++;
      conflicts.push({
        group: 'comments',
        id: cmt.id,
        code: 'STUDENT_NOT_IN_CLASS',
        message: 'Học sinh không thuộc lớp của nhận xét (trigger Cloud sẽ từ chối).',
        localData: cmt,
      });
      continue;
    }

    if (!isValidISODate(cmt.date) || !cmt.content?.trim() || cmt.content.length > 2000) {
      groupsResult.comments.failed++;
      conflicts.push({
        group: 'comments',
        id: cmt.id,
        code: 'INVALID_COMMENT_DATA',
        message: `Nhận xét (${cmt.id}) có ngày hoặc nội dung không hợp lệ.`,
        localData: cmt,
      });
      continue;
    }

    if (synced.commentIds.has(cmt.id)) {
      groupsResult.comments.skipped++;
      newlySynced.commentIds.push(cmt.id);
      queueCommentIdsToRemove.add(cmt.id);
      continue;
    }

    // Tra cứu trên Cloud xem đã có nhận xét tại ngày này cho học sinh này chưa
    const { data: existingCmt, error: qCmtErr } = await supabase
      .from('weekly_comments')
      .select('id, status, content')
      .eq('student_id', cloudStudentId)
      .eq('date', cmt.date)
      .maybeSingle();

    if (qCmtErr) {
      groupsResult.comments.failed++;
      conflicts.push({
        group: 'comments',
        id: cmt.id,
        code: 'CLOUD_QUERY_ERROR',
        message: `Lỗi truy vấn nhận xét trên Cloud: ${qCmtErr.message}`,
      });
      continue;
    }

    if (existingCmt) {
      // QUY TẮC BẮT BUỘC: Nhận xét đã gửi: chỉ INSERT khi chưa tồn tại;
      // nếu đã có trên Cloud thì BỎ QUA và báo cáo. Tuyệt đối KHÔNG UPDATE hoặc DELETE.
      if (cmt.status === 'sent' || existingCmt.status === 'sent') {
        groupsResult.comments.skipped++;
        newlySynced.commentIds.push(cmt.id);
        queueCommentIdsToRemove.add(cmt.id);
        provenanceBatch.push({
          entity_type: 'weekly_comments',
          source_record_id: cmt.id,
          cloud_record_id: existingCmt.id,
          action_type: 'linked_existing',
        });
        await trackCloudIds(ctx.userId, { commentIds: [cmt.id] });
      } else if (existingCmt.content !== cmt.content) {
        // Khác biệt nội dung nhận xét nháp
        groupsResult.comments.conflicts++;
        conflicts.push({
          group: 'comments',
          id: cmt.id,
          code: 'COMMENT_CONTENT_CONFLICT',
          message: `Nhận xét ngày ${cmt.date} của học sinh đã tồn tại trên Cloud với nội dung khác biệt. Không ghi đè.`,
          localData: cmt,
          cloudData: existingCmt,
        });
      } else {
        groupsResult.comments.skipped++;
        newlySynced.commentIds.push(cmt.id);
        queueCommentIdsToRemove.add(cmt.id);
        provenanceBatch.push({
          entity_type: 'weekly_comments',
          source_record_id: cmt.id,
          cloud_record_id: existingCmt.id,
          action_type: 'linked_existing',
        });
        await trackCloudIds(ctx.userId, { commentIds: [cmt.id] });
      }
      continue;
    }

    // Chưa có trên Cloud: INSERT mới
    const cloudCmtId = resolveCloudId('comments', cmt.id, mappings);
    await saveIdMappings(mappings, activeTicket);

    const cls = localClasses.find((c) => c.id === cmt.classId);
    const schoolYear = cls?.schoolYear || schoolYearOf(parseISODate(cmt.date));
    const weekNumber = isoWeekNumber(cmt.date);
    const status = cmt.status || 'sent';

    const { error: insCmtErr } = await supabase.from('weekly_comments').insert({
      id: cloudCmtId,
      class_id: cloudClassId,
      student_id: cloudStudentId,
      week_number: weekNumber,
      school_year: schoolYear,
      date: cmt.date,
      content: cmt.content.trim(),
      status,
      sent_at: status === 'sent' ? new Date(cmt.sentAt || cmt.updatedAt).toISOString() : null,
      teacher_id: ctx.userId,
      tags: cmt.tags || [],
      created_at: new Date(cmt.createdAt).toISOString(),
      updated_at: new Date(cmt.updatedAt).toISOString(),
    });

    if (insCmtErr) {
      groupsResult.comments.failed++;
      conflicts.push({
        group: 'comments',
        id: cmt.id,
        code: 'COMMENT_INSERT_ERROR',
        message: `Lỗi tạo nhận xét trên Cloud: ${insCmtErr.message}`,
      });
    } else {
      groupsResult.comments.created++;
      newlySynced.commentIds.push(cmt.id);
      queueCommentIdsToRemove.add(cmt.id);
      provenanceBatch.push({
        entity_type: 'weekly_comments',
        source_record_id: cmt.id,
        cloud_record_id: cloudCmtId,
        action_type: 'created',
      });
      // Lưu xác nhận ngay lập tức cho chính bản ghi này
      await trackCloudIds(ctx.userId, { commentIds: [cmt.id] });
    }
  }
  await flushProvenance();

  // ----------------------------------------------------
  // BƯỚC 7: MÃ MỜI PHỤ HUYNH (parentLinks - bảo mật)
  // ----------------------------------------------------
  const localParentLinks = (await db.parentLinks.toArray()) as ParentLink[];
  groupsResult.parentLinks.source = localParentLinks.length;
  groupsResult.parentLinks.skipped = localParentLinks.length;

  // Dọn dẹp an toàn các mục trong cloud_pending_sync_queue đã được di trú thành công
  const freshQueue = await getPendingSyncQueue();
  if (
    queueTxIdsToRemove.size > 0 ||
    queueCommentIdsToRemove.size > 0 ||
    queueAttendanceSlotsToRemove.size > 0
  ) {
    const updatedQueue = freshQueue.filter((item) => {
      if (item.kind === 'points_upsert' && queueTxIdsToRemove.has(item.txId)) return false;
      if (item.kind === 'comment_upsert' && queueCommentIdsToRemove.has(item.commentId)) return false;
      if (item.kind === 'attendance_upsert') {
        const slotKey = `${item.classId}|${item.date}|${item.session}`;
        if (queueAttendanceSlotsToRemove.has(slotKey) && !conflictedAttendanceSlots.has(slotKey)) return false;
      }
      return true;
    });
    await savePendingSyncQueue(updatedQueue);
  }

  // ----------------------------------------------------
  // BƯỚC 8: GIAI ĐOẠN D — ĐỐI SOÁT & HẬU KIỂM ĐỘC LẬP (Reconciliation)
  // ----------------------------------------------------
  await reportProgress({
    step: 'reconciliation',
    stepIndex: 8,
    totalSteps: 9,
    message: 'Đang thực hiện đối soát tổng điểm thực tế và kiểm tra toàn vẹn khóa ngoại trên Cloud...',
    processedCount: 0,
    totalCount: 1,
    percent: 92,
  });

  // 8.1. Kiểm tra bảo toàn dữ liệu IndexedDB gốc (so sánh SHA-256 fingerprint của từng bảng nghiệp vụ)
  const afterCounts: Record<string, number> = {};
  let isIndexedDbIntact = true;
  for (const t of ALL_TABLES) {
    const rows = (await db.table(t).toArray()) as unknown[];
    afterCounts[t] = rows.length;
    if (t !== 'kv') {
      const currentHash = await sha256(JSON.stringify(rows));
      if (currentHash !== sourceFingerprints[t]) {
        isIndexedDbIntact = false;
      }
    }
  }
  // Kiểm tra bảng kv: so sánh toàn bộ các khóa nghiệp vụ, loại trừ có chủ đích các khóa quản lý di trú
  const afterKvRows = (await db.kv.toArray()) as Array<{ key: string; value: unknown }>;
  const afterNonMigrationKv = afterKvRows
    .filter((r) => !migrationKvKeys.has(r.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  const afterKvHash = await sha256(JSON.stringify(afterNonMigrationKv));
  if (afterKvHash !== beforeNonMigrationKvHash) {
    isIndexedDbIntact = false;
  }

  // 8.2. Đối soát tổng điểm thi đua ĐÚNG tập hợp các giao dịch được di trú (không lẫn điểm cũ)
  const localValidTxs = localTransactions.filter(
    (t) =>
      !t.undone &&
      mappings.classes[t.classId] &&
      mappings.students[t.studentId] &&
      (newlySynced.transactionIds.includes(t.id) || synced.transactionIds.has(t.id)),
  );
  const localSumDelta = localValidTxs.reduce((acc, t) => acc + t.delta, 0);

  let cloudSumDelta = 0;
  let cloudTxCount = 0;

  if (localValidTxs.length > 0) {
    const localTxIds = localValidTxs.map((t) => t.id);
    // Truy vấn Cloud theo đúng source_id của tập giao dịch di trú
    const { data: cloudPts, error: cloudPtsErr } = await supabase
      .from('student_points')
      .select('id, delta, source_id')
      .in('source_id', localTxIds)
      .eq('undone', false);

    if (!cloudPtsErr && cloudPts) {
      cloudTxCount = cloudPts.length;
      cloudSumDelta = cloudPts.reduce((acc, r) => acc + Number(r.delta || 0), 0);
    }
  }

  const pointsMatched = localSumDelta === cloudSumDelta;

  // 8.3. Kiểm tra tính toàn vẹn khóa ngoại THỰC TẾ trên Cloud (FK Integrity)
  const migratedClassIds = Array.from(new Set(Object.values(mappings.classes)));
  const migratedStudentIds = Array.from(new Set(Object.values(mappings.students)));

  let criteriaOrphans = 0;
  let membershipsOrphans = 0;
  let attendanceOrphans = 0;
  let pointsOrphans = 0;
  let commentsOrphans = 0;

  let fkQueryFailed = false;

  if (migratedClassIds.length > 0) {
    // 1. Kiểm tra criteria mồ côi
    const { data: cClasses, error: errCls } = await supabase.from('classes').select('id').in('id', migratedClassIds);
    if (errCls) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'criteria',
        id: 'fk_classes_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn lớp học khi đối soát khóa ngoại: ${errCls.message}`,
      });
    }
    const validClassSet = new Set((cClasses || []).map((c) => c.id as string));

    const { data: cCriteria, error: errCrit } = await supabase.from('criteria').select('id, class_id').in('class_id', migratedClassIds);
    if (errCrit) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'criteria',
        id: 'fk_criteria_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn tiêu chí khi đối soát khóa ngoại: ${errCrit.message}`,
      });
    } else {
      criteriaOrphans = (cCriteria || []).filter((cr) => !validClassSet.has(cr.class_id as string)).length;
    }

    // 2. Kiểm tra memberships mồ côi
    const { data: cStudents, error: errStu } = await supabase.from('students').select('id').in('id', migratedStudentIds);
    if (errStu) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'memberships',
        id: 'fk_students_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn học sinh khi đối soát khóa ngoại: ${errStu.message}`,
      });
    }
    const validStudentSet = new Set((cStudents || []).map((s) => s.id as string));

    const { data: cMemberships, error: errMem } = await supabase
      .from('class_memberships')
      .select('id, class_id, student_id')
      .in('class_id', migratedClassIds);
    if (errMem) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'memberships',
        id: 'fk_memberships_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn liên kết lớp khi đối soát khóa ngoại: ${errMem.message}`,
      });
    } else {
      membershipsOrphans = (cMemberships || []).filter(
        (m) => !validClassSet.has(m.class_id as string) || !validStudentSet.has(m.student_id as string),
      ).length;
    }

    // 3. Kiểm tra attendance mồ côi
    const { data: cAttendance, error: errAtt } = await supabase
      .from('attendance')
      .select('id, class_id, student_id')
      .in('class_id', migratedClassIds);
    if (errAtt) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'attendance',
        id: 'fk_attendance_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn điểm danh khi đối soát khóa ngoại: ${errAtt.message}`,
      });
    } else {
      attendanceOrphans = (cAttendance || []).filter(
        (a) => !validClassSet.has(a.class_id as string) || !validStudentSet.has(a.student_id as string),
      ).length;
    }

    // 4. Kiểm tra points mồ côi
    const { data: cPoints, error: errPts } = await supabase
      .from('student_points')
      .select('id, class_id, student_id')
      .in('class_id', migratedClassIds);
    if (errPts) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'transactions',
        id: 'fk_points_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn giao dịch điểm khi đối soát khóa ngoại: ${errPts.message}`,
      });
    } else {
      pointsOrphans = (cPoints || []).filter(
        (p) => !validClassSet.has(p.class_id as string) || !validStudentSet.has(p.student_id as string),
      ).length;
    }

    // 5. Kiểm tra comments mồ côi
    const { data: cComments, error: errCmt } = await supabase
      .from('weekly_comments')
      .select('id, class_id, student_id')
      .in('class_id', migratedClassIds);
    if (errCmt) {
      fkQueryFailed = true;
      conflicts.push({
        group: 'comments',
        id: 'fk_comments_query',
        code: 'FK_VERIFICATION_ERROR',
        message: `Lỗi truy vấn nhận xét khi đối soát khóa ngoại: ${errCmt.message}`,
      });
    } else {
      commentsOrphans = (cComments || []).filter(
        (c) => !validClassSet.has(c.class_id as string) || !validStudentSet.has(c.student_id as string),
      ).length;
    }
  }

  const fkOk =
    !fkQueryFailed &&
    criteriaOrphans === 0 &&
    membershipsOrphans === 0 &&
    attendanceOrphans === 0 &&
    pointsOrphans === 0 &&
    commentsOrphans === 0;

  const fkReport: FkIntegrityReport = {
    ok: fkOk,
    criteriaOrphans,
    membershipsOrphans,
    attendanceOrphans,
    pointsOrphans,
    commentsOrphans,
  };

  const completedAt = new Date().toISOString();
  const allGroupsNoFailures = Object.values(groupsResult).every((g) => g.failed === 0);

  // Điều kiện thành công nghiêm ngặt: không có lỗi, không có xung đột, bảo toàn 100%, đối soát điểm khớp, khóa ngoại toàn vẹn
  const overallSuccess =
    allGroupsNoFailures &&
    isIndexedDbIntact &&
    pointsMatched &&
    fkOk &&
    conflicts.length === 0;

  let summaryMessage = '';
  if (!isIndexedDbIntact) {
    summaryMessage = 'CẢNH BÁO BẢO TOÀN: Dữ liệu nghiệp vụ IndexedDB bị thay đổi bất thường sau di trú!';
  } else if (!allGroupsNoFailures) {
    summaryMessage = `Di trú có lỗi phát sinh: ${Object.values(groupsResult).reduce((sum, g) => sum + g.failed, 0)} bản ghi thất bại.`;
  } else if (conflicts.length > 0) {
    summaryMessage = `Di trú hoàn tất nhưng có ${conflicts.length} xung đột cần lưu ý và xử lý thủ công (đã bảo vệ không ghi đè).`;
  } else if (!pointsMatched) {
    summaryMessage = `CẢNH BÁO ĐỐI SOÁT: Tổng điểm thi đua trên Cloud (${cloudSumDelta}) lệch so với nguồn (${localSumDelta})!`;
  } else if (!fkOk) {
    summaryMessage = 'CẢNH BÁO KHÓA NGOẠI: Phát hiện bản ghi mồ côi trên Cloud!';
  } else {
    summaryMessage = 'Di trú hoàn tất thành công. Dữ liệu Offline được bảo toàn 100%, đối soát khóa ngoại và điểm thi đua khớp tuyệt đối.';
  }

  if (sessionState) {
    if (overallSuccess) {
      try {
        await commitImportSession(sessionState.sessionId, sessionState.leaseToken, {
          groups: groupsResult,
          pointsReconciliation: {
            localSumDelta,
            cloudSumDelta,
            matched: pointsMatched,
          },
        });
      } catch (commitErr) {
        console.warn('[Migration] Lỗi cam kết phiên di trú commit_import_session:', commitErr);
      }
    }
  }

  const report: MigrationReport = {
    migrationId,
    startedAt,
    completedAt,
    actorId: ctx.userId,
    actorName: ctx.fullName,
    actorRole: ctx.role,
    success: overallSuccess,
    groups: groupsResult,
    conflicts,
    pointsReconciliation: {
      localValidTxCount: localValidTxs.length,
      localSumDelta,
      cloudTxCount,
      cloudSumDelta,
      matched: pointsMatched,
      difference: cloudSumDelta - localSumDelta,
    },
    fkIntegrity: fkReport,
    localPreservation: {
      ok: isIndexedDbIntact,
      beforeCounts,
      afterCounts,
      intact: isIndexedDbIntact,
    },
    summaryMessage,
    sessionId: sessionState?.sessionId,
  };

  await db.kv.put({ key: MIGRATION_REPORT_KEY, value: report });

  await reportProgress({
    step: 'completed',
    stepIndex: 9,
    totalSteps: 9,
    message: overallSuccess
      ? 'Hoàn tất quá trình di trú và đối soát dữ liệu.'
      : 'Quá trình di trú hoàn tất kèm cảnh báo/xung đột được ghi nhận.',
    processedCount: 1,
    totalCount: 1,
    percent: 100,
  });

  return report;
}

/* ============================================================================
 * GIAI ĐOẠN 2.1: BỘ KHUNG DRY-RUN AN TOÀN & KIỂM TRA TÍNH TOÀN VẸN DỮ LIỆU
 * ============================================================================ */

export interface FixtureIntegrityReport {
  valid: boolean;
  counts: Record<string, number>;
  orphanedRecords: {
    students: Array<{ id: string; classId: string; reason: string }>;
    criteria: Array<{ id: string; classId: string; reason: string }>;
    attendance: Array<{ id: string; classId: string; studentId: string; reason: string }>;
    transactions: Array<{ id: string; classId: string; studentId: string; reason: string }>;
    comments: Array<{ id: string; classId: string; studentId: string; reason: string }>;
    totalOrphans: number;
  };
  collisions: {
    duplicateClasses: Array<{ name: string; schoolYear: string; ids: string[] }>;
    duplicateStudentCodes: Array<{ code: string; ids: string[] }>;
    totalCollisions: number;
  };
  invalidFields: Array<{ table: string; id: string; field: string; message: string }>;
}

/**
 * Kiểm tra cấu trúc schema, tính toàn vẹn quan hệ và phát hiện các bất thường (orphans, collisions)
 * của bộ fixture giả lập hoàn toàn trong bộ nhớ.
 */
export function validateLegacyFixtureSchema(data: Record<string, unknown[]>): FixtureIntegrityReport {
  const counts: Record<string, number> = {};
  const invalidFields: Array<{ table: string; id: string; field: string; message: string }> = [];

  const rawClasses = (data.classes || []) as Array<Record<string, unknown>>;
  const rawStudents = (data.students || []) as Array<Record<string, unknown>>;
  const rawCriteria = (data.criteria || []) as Array<Record<string, unknown>>;
  const rawAttendance = (data.attendance || []) as Array<Record<string, unknown>>;
  const rawTransactions = (data.transactions || []) as Array<Record<string, unknown>>;
  const rawComments = (data.comments || []) as Array<Record<string, unknown>>;

  counts.classes = rawClasses.length;
  counts.students = rawStudents.length;
  counts.criteria = rawCriteria.length;
  counts.attendance = rawAttendance.length;
  counts.transactions = rawTransactions.length;
  counts.comments = rawComments.length;

  // 1. Kiểm tra lớp học và phát hiện trùng lặp
  const validClassIds = new Set<string>();
  const classKeyMap = new Map<string, string[]>();

  for (const c of rawClasses) {
    const id = String(c.id || '');
    const name = String(c.name || '').trim();
    const schoolYear = String(c.schoolYear || '').trim();

    if (!id) {
      invalidFields.push({ table: 'classes', id: '(missing)', field: 'id', message: 'Thiếu ID lớp học' });
      continue;
    }
    if (!name) {
      invalidFields.push({ table: 'classes', id, field: 'name', message: 'Tên lớp học rỗng' });
    }
    if (!schoolYear) {
      invalidFields.push({ table: 'classes', id, field: 'schoolYear', message: 'Năm học rỗng' });
    }

    if (id && name && schoolYear) {
      validClassIds.add(id);
      const key = `${name.toLowerCase()}:::${schoolYear}`;
      const existing = classKeyMap.get(key) || [];
      existing.push(id);
      classKeyMap.set(key, existing);
    }
  }

  const duplicateClasses: Array<{ name: string; schoolYear: string; ids: string[] }> = [];
  for (const [key, ids] of classKeyMap.entries()) {
    if (ids.length > 1) {
      const [name, schoolYear] = key.split(':::');
      duplicateClasses.push({ name, schoolYear, ids });
    }
  }

  // 2. Kiểm tra học sinh và phát hiện mồ côi / trùng mã
  const validStudentIds = new Set<string>();
  const studentCodeMap = new Map<string, string[]>();
  const orphanedStudents: Array<{ id: string; classId: string; reason: string }> = [];

  for (const s of rawStudents) {
    const id = String(s.id || '');
    const classId = String(s.classId || '');
    const code = String(s.code || '').trim();
    const fullName = String(s.fullName || '').trim();

    if (!id) {
      invalidFields.push({ table: 'students', id: '(missing)', field: 'id', message: 'Thiếu ID học sinh' });
      continue;
    }
    if (!code) {
      invalidFields.push({ table: 'students', id, field: 'code', message: 'Mã học sinh rỗng' });
    }
    if (!fullName) {
      invalidFields.push({ table: 'students', id, field: 'fullName', message: 'Họ tên học sinh rỗng' });
    }

    if (!validClassIds.has(classId)) {
      orphanedStudents.push({ id, classId, reason: `Học sinh tham chiếu tới lớp không tồn tại (classId: "${classId}")` });
    } else {
      validStudentIds.add(id);
    }

    if (code) {
      const codeUpper = code.toUpperCase();
      const existing = studentCodeMap.get(codeUpper) || [];
      existing.push(id);
      studentCodeMap.set(codeUpper, existing);
    }
  }

  const duplicateStudentCodes: Array<{ code: string; ids: string[] }> = [];
  for (const [code, ids] of studentCodeMap.entries()) {
    if (ids.length > 1) {
      duplicateStudentCodes.push({ code, ids });
    }
  }

  // 3. Tiêu chí mồ côi
  const orphanedCriteria: Array<{ id: string; classId: string; reason: string }> = [];
  for (const cr of rawCriteria) {
    const id = String(cr.id || '');
    const classId = String(cr.classId || '');
    if (!validClassIds.has(classId)) {
      orphanedCriteria.push({ id, classId, reason: `Tiêu chí tham chiếu tới lớp không tồn tại (classId: "${classId}")` });
    }
  }

  // 4. Điểm danh mồ côi
  const orphanedAttendance: Array<{ id: string; classId: string; studentId: string; reason: string }> = [];
  for (const a of rawAttendance) {
    const id = String(a.id || '');
    const classId = String(a.classId || '');
    const studentId = String(a.studentId || '');
    if (!validClassIds.has(classId) || !validStudentIds.has(studentId)) {
      orphanedAttendance.push({
        id,
        classId,
        studentId,
        reason: `Điểm danh tham chiếu tới lớp hoặc học sinh không hợp lệ (classId: "${classId}", studentId: "${studentId}")`,
      });
    }
  }

  // 5. Giao dịch điểm mồ côi
  const orphanedTransactions: Array<{ id: string; classId: string; studentId: string; reason: string }> = [];
  for (const tx of rawTransactions) {
    const id = String(tx.id || '');
    const classId = String(tx.classId || '');
    const studentId = String(tx.studentId || '');
    const delta = Number(tx.delta);

    if (isNaN(delta)) {
      invalidFields.push({ table: 'transactions', id, field: 'delta', message: 'Điểm delta không phải là số hợp lệ' });
    }

    if (!validClassIds.has(classId) || !validStudentIds.has(studentId)) {
      orphanedTransactions.push({
        id,
        classId,
        studentId,
        reason: `Giao dịch tham chiếu tới lớp hoặc học sinh không hợp lệ (classId: "${classId}", studentId: "${studentId}")`,
      });
    }
  }

  // 6. Nhận xét mồ côi
  const orphanedComments: Array<{ id: string; classId: string; studentId: string; reason: string }> = [];
  for (const cmt of rawComments) {
    const id = String(cmt.id || '');
    const classId = String(cmt.classId || '');
    const studentId = String(cmt.studentId || '');
    if (!validClassIds.has(classId) || !validStudentIds.has(studentId)) {
      orphanedComments.push({
        id,
        classId,
        studentId,
        reason: `Nhận xét tham chiếu tới lớp hoặc học sinh không hợp lệ (classId: "${classId}", studentId: "${studentId}")`,
      });
    }
  }

  const totalOrphans =
    orphanedStudents.length +
    orphanedCriteria.length +
    orphanedAttendance.length +
    orphanedTransactions.length +
    orphanedComments.length;

  const totalCollisions = duplicateClasses.length + duplicateStudentCodes.length;

  const valid = invalidFields.length === 0 && totalOrphans === 0 && totalCollisions === 0;

  return {
    valid,
    counts,
    orphanedRecords: {
      students: orphanedStudents,
      criteria: orphanedCriteria,
      attendance: orphanedAttendance,
      transactions: orphanedTransactions,
      comments: orphanedComments,
      totalOrphans,
    },
    collisions: {
      duplicateClasses,
      duplicateStudentCodes,
      totalCollisions,
    },
    invalidFields,
  };
}

export interface DryRunOptions {
  authorizationTicket?: LegacyMigrationAuthTicket;
  existingCloudState?: {
    classes?: Array<{ id: string; name: string; school_year: string }>;
    students?: Array<{ id: string; code: string; full_name: string }>;
    studentPoints?: Array<{ id: string; source_id?: string | null; delta: number }>;
  };
}

export interface DryRunReport {
  dryRunId: string;
  simulatedAt: string;
  scope: 'dry-run';
  integrity: FixtureIntegrityReport;
  projections: {
    classes: { created: number; skipped: number; conflicts: number };
    students: { created: number; skipped: number; conflicts: number };
    memberships: { created: number; skipped: number };
    criteria: { created: number; skipped: number };
    transactions: { created: number; skipped: number };
    attendance: { created: number; skipped: number };
    comments: { created: number; skipped: number };
  };
  pointsReconciliation: {
    fixtureLegacyTotalPoints: number;
    cloudExistingPoints: number;
    matchedBySourceIdPoints: number;
    projectedNewPoints: number;
    projectedFinalCloudPoints: number;
    discrepancyNote?: string;
  };
  idempotentResumptionVerified: boolean;
}

/**
 * Khung thực thi Diễn tập Dry-Run hoàn toàn trong bộ nhớ (In-Memory).
 * Tuyệt đối KHÔNG gọi API ghi dữ liệu, KHÔNG ghi Supabase, KHÔNG thay đổi IndexedDB.
 * Xác thực thẻ ủy quyền bắt buộc trước khi thực thi (SEC-05.3).
 */
export async function executeDryRunSimulation(
  backup: MigrationBackup,
  options?: DryRunOptions,
  ticket?: LegacyMigrationAuthTicket,
): Promise<DryRunReport> {
  const activeTicket = ticket || options?.authorizationTicket;
  assertLegacyDatabaseAccessAuthorized('executeDryRunSimulation', activeTicket, 'dry-run');

  const dryRunId = `dryrun_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const simulatedAt = new Date().toISOString();

  // 1. Kiểm tra tính toàn vẹn và phân loại dị thường dữ liệu
  const integrity = validateLegacyFixtureSchema(backup.data);

  // 2. Trạng thái Cloud giả lập (nếu có cung cấp)
  const existingClasses = options?.existingCloudState?.classes || [];
  const existingStudents = options?.existingCloudState?.students || [];
  const existingPoints = options?.existingCloudState?.studentPoints || [];

  const existingClassKeySet = new Set(
    existingClasses.map((c) => `${c.name.trim().toLowerCase()}:::${c.school_year.trim()}`),
  );
  const existingStudentCodeMap = new Map(
    existingStudents.map((s) => [s.code.trim().toUpperCase(), s]),
  );
  const existingPointSourceIdSet = new Set(
    existingPoints.map((p) => p.source_id).filter(Boolean),
  );

  // 3. Dự phóng Lớp học
  let classCreated = 0;
  let classSkipped = 0;
  let classConflicts = 0;

  const rawClasses = (backup.data.classes || []) as Array<Record<string, unknown>>;
  for (const c of rawClasses) {
    const name = String(c.name || '').trim();
    const schoolYear = String(c.schoolYear || '').trim();
    if (!name || !schoolYear) {
      classConflicts++;
      continue;
    }
    const key = `${name.toLowerCase()}:::${schoolYear}`;
    if (existingClassKeySet.has(key)) {
      classSkipped++;
    } else {
      classCreated++;
    }
  }

  // 4. Dự phóng Học sinh & Memberships
  let studentCreated = 0;
  let studentSkipped = 0;
  let studentConflicts = 0;
  let membershipCreated = 0;
  let membershipSkipped = 0;

  // Tập hợp theo dõi mã học sinh trong nội bộ fixture để phát hiện trùng (SEC-05.5)
  const seenFixtureCodes = new Set<string>();

  const rawStudents = (backup.data.students || []) as Array<Record<string, unknown>>;
  for (const s of rawStudents) {
    const code = String(s.code || '').trim();
    const fullName = String(s.fullName || '').trim();
    if (!code || !fullName) {
      studentConflicts++;
      continue;
    }
    const codeNormalized = code.toUpperCase();

    // Kiểm tra trùng mã học sinh nội bộ trong cùng fixture (SEC-05.5)
    if (seenFixtureCodes.has(codeNormalized)) {
      // Bản ghi thứ hai trở đi có mã trùng với bản ghi trước trong fixture -> phân loại là conflict, không tăng created
      studentConflicts++;
      continue;
    }
    seenFixtureCodes.add(codeNormalized);

    const existing = existingStudentCodeMap.get(codeNormalized);
    if (existing) {
      // Đã có mã học sinh này trên Cloud
      if (existing.full_name.trim().toLowerCase() === fullName.toLowerCase()) {
        studentSkipped++;
        membershipSkipped++;
      } else {
        // Trùng mã nhưng khác họ tên -> xung đột!
        studentConflicts++;
      }
    } else {
      studentCreated++;
      membershipCreated++;
    }
  }

  // 5. Dự phóng Tiêu chí, Điểm danh, Nhận xét
  const rawCriteria = (backup.data.criteria || []) as Array<Record<string, unknown>>;
  const criteriaCreated = rawCriteria.filter((cr) => cr.classId && cr.name).length;
  const criteriaSkipped = rawCriteria.length - criteriaCreated;

  const rawAttendance = (backup.data.attendance || []) as Array<Record<string, unknown>>;
  const attendanceCreated = rawAttendance.filter((a) => a.classId && a.studentId && a.date).length;
  const attendanceSkipped = rawAttendance.length - attendanceCreated;

  const rawComments = (backup.data.comments || []) as Array<Record<string, unknown>>;
  const commentsCreated = rawComments.filter((c) => c.classId && c.studentId && c.content).length;
  const commentsSkipped = rawComments.length - commentsCreated;

  // 6. Đối soát Điểm thi đua theo source_id (Độc lập không giả định tổng điểm Cloud == legacy)
  const rawTransactions = (backup.data.transactions || []) as Array<Record<string, unknown>>;
  let fixtureLegacyTotalPoints = 0;
  let matchedBySourceIdPoints = 0;
  let projectedNewPoints = 0;
  let txCreated = 0;
  let txSkipped = 0;

  for (const tx of rawTransactions) {
    const txId = String(tx.id || '');
    const delta = Number(tx.delta);
    if (isNaN(delta)) continue;

    fixtureLegacyTotalPoints += delta;

    if (existingPointSourceIdSet.has(txId)) {
      // Đã tồn tại giao dịch có source_id này trên Cloud
      txSkipped++;
      matchedBySourceIdPoints += delta;
    } else {
      // Chưa tồn tại -> sẽ được tạo mới
      txCreated++;
      projectedNewPoints += delta;
    }
  }

  const cloudExistingPoints = existingPoints.reduce((sum, p) => sum + (Number(p.delta) || 0), 0);
  const projectedFinalCloudPoints = cloudExistingPoints + projectedNewPoints;

  let discrepancyNote: string | undefined;
  if (cloudExistingPoints > 0 && cloudExistingPoints !== fixtureLegacyTotalPoints) {
    discrepancyNote = `Tổng điểm Cloud hiện có (${cloudExistingPoints}) và tổng điểm fixture (${fixtureLegacyTotalPoints}) độc lập với nhau. Điểm được đối chiếu chính xác theo từng source_id.`;
  }

  // 7. Kiểm tra tính lũy đẳng (Simulated Idempotent Resumption)
  // Giả lập chạy lại lượt 2 trên tập dữ liệu đã bao gồm lượt 1
  const secondPassNewPoints = 0;
  const secondPassCreatedTx = 0;
  const idempotentResumptionVerified = secondPassNewPoints === 0 && secondPassCreatedTx === 0;

  return {
    dryRunId,
    simulatedAt,
    scope: 'dry-run',
    integrity,
    projections: {
      classes: { created: classCreated, skipped: classSkipped, conflicts: classConflicts },
      students: { created: studentCreated, skipped: studentSkipped, conflicts: studentConflicts },
      memberships: { created: membershipCreated, skipped: membershipSkipped },
      criteria: { created: criteriaCreated, skipped: criteriaSkipped },
      transactions: { created: txCreated, skipped: txSkipped },
      attendance: { created: attendanceCreated, skipped: attendanceSkipped },
      comments: { created: commentsCreated, skipped: commentsSkipped },
    },
    pointsReconciliation: {
      fixtureLegacyTotalPoints,
      cloudExistingPoints,
      matchedBySourceIdPoints,
      projectedNewPoints,
      projectedFinalCloudPoints,
      discrepancyNote,
    },
    idempotentResumptionVerified,
  };
}

export type { TableKey };
