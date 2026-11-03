import Dexie, { type Table } from 'dexie';
import type {
  ActivityLog,
  AttendanceRecord,
  ClassRoom,
  Criterion,
  GamePick,
  KV,
  ParentLink,
  PointTransaction,
  Student,
  StudentComment,
  TodoTask,
} from '../types';

export const LEGACY_DB_NAME = 'pink-classroom';
export const USER_DB_PREFIX = 'pink-classroom-user-';

const VALID_USER_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

/**
 * Kiểm tra và chuẩn hóa user ID đã được xác thực từ Supabase:
 * - Không cho phép rỗng hoặc chỉ có khoảng trắng.
 * - Không cho phép chứa ký tự nhạy cảm, email, khoảng trắng.
 * - Không cho phép trùng với tên database legacy ('pink-classroom').
 */
export function validateAndSanitizeUserId(userId: unknown): string {
  if (typeof userId !== 'string') {
    throw new Error('User ID không hợp lệ: Định danh phải là chuỗi ký tự.');
  }

  const trimmed = userId.trim();
  if (!trimmed) {
    throw new Error('User ID không hợp lệ: Thiếu định danh người dùng đã xác thực.');
  }

  if (trimmed.includes('@') || trimmed.includes('.') || trimmed.includes(' ')) {
    throw new Error(
      'User ID không hợp lệ: Không được sử dụng email, tên hoặc ký tự đặc biệt để định danh cơ sở dữ liệu.',
    );
  }

  if (trimmed === LEGACY_DB_NAME) {
    throw new Error('User ID không hợp lệ: Không được sử dụng tên định danh dành riêng của hệ thống.');
  }

  if (!VALID_USER_ID_REGEX.test(trimmed)) {
    throw new Error(
      'User ID không hợp lệ: Định danh chỉ được chứa chữ cái, số, dấu gạch nối và dấu gạch dưới (độ dài 3-128 ký tự).',
    );
  }

  return trimmed;
}

/**
 * Sinh tên IndexedDB an toàn cho từng tài khoản giáo viên:
 * Luôn bắt đầu bằng tiền tố 'pink-classroom-user-' và không bao giờ trùng với legacy database.
 */
export function getUserDatabaseName(userId: string): string {
  const cleanId = validateAndSanitizeUserId(userId);
  return `${USER_DB_PREFIX}${cleanId}`;
}

/**
 * Cơ sở dữ liệu cục bộ (IndexedDB) của Pink Classroom.
 * Hỗ trợ tạo instance độc lập theo từng tài khoản giáo viên.
 */
export class PinkDB extends Dexie {
  classes!: Table<ClassRoom, string>;
  students!: Table<Student, string>;
  attendance!: Table<AttendanceRecord, string>;
  criteria!: Table<Criterion, string>;
  transactions!: Table<PointTransaction, string>;
  comments!: Table<StudentComment, string>;
  parentLinks!: Table<ParentLink, string>;
  gamePicks!: Table<GamePick, string>;
  activities!: Table<ActivityLog, string>;
  tasks!: Table<TodoTask, string>;
  kv!: Table<KV, string>;

  constructor(name: string = LEGACY_DB_NAME) {
    super(name);
    this.version(1).stores({
      classes: 'id, name, createdAt',
      students: 'id, classId, code, fullName, status, [classId+status]',
      attendance: 'id, classId, studentId, date, [classId+date], [classId+date+session]',
      criteria: 'id, classId, order',
      transactions: 'id, classId, studentId, batchId, createdAt, [classId+createdAt]',
      comments: 'id, classId, studentId, date, [classId+date]',
      gamePicks: 'id, classId, roundId, createdAt',
      activities: 'id, classId, createdAt',
      tasks: 'id, classId, done, createdAt',
      kv: 'key',
    });
    this.version(2).stores({
      parentLinks: 'id, classId, studentId, token, [classId+studentId]',
    });
  }
}

/**
 * Registry quản lý các instance kết nối Dexie theo tài khoản trong cùng runtime.
 * Tái sử dụng instance để tránh mở nhiều kết nối trùng lặp.
 */
const userDbRegistry = new Map<string, PinkDB>();

/**
 * Database Factory: Tạo hoặc lấy lại instance Dexie riêng biệt cho tài khoản đã xác thực.
 * - Kiểm tra tính hợp lệ của user ID.
 * - Đảm bảo database name luôn có prefix riêng và không bao giờ mở database legacy.
 * - Tái sử dụng kết nối trong cùng runtime.
 */
export function getDatabaseForUser(userId: string): PinkDB {
  const cleanId = validateAndSanitizeUserId(userId);
  const dbName = getUserDatabaseName(cleanId);

  if (dbName === LEGACY_DB_NAME) {
    throw new Error('Cảnh báo an toàn: Factory không được phép mở database legacy "pink-classroom".');
  }

  const existing = userDbRegistry.get(cleanId);
  if (existing) {
    return existing;
  }

  const instance = new PinkDB(dbName);
  userDbRegistry.set(cleanId, instance);
  return instance;
}

/**
 * Đóng kết nối cơ sở dữ liệu của một tài khoản cụ thể (dùng khi đăng xuất hoặc dọn dẹp)
 */
export function closeDatabaseForUser(userId: string): void {
  try {
    const cleanId = validateAndSanitizeUserId(userId);
    const existing = userDbRegistry.get(cleanId);
    if (existing) {
      if (existing.isOpen()) {
        existing.close();
      }
      userDbRegistry.delete(cleanId);
    }
  } catch {
    // ignore
  }
}

/**
 * Đóng toàn bộ kết nối trong registry (dùng cho kiểm thử hoặc teardown)
 */
export function clearUserDatabaseRegistry(): void {
  for (const [, instance] of userDbRegistry.entries()) {
    if (instance.isOpen()) {
      instance.close();
    }
  }
  userDbRegistry.clear();
}

/**
 * Database legacy tĩnh hiện tại (giữ nguyên để không phá vỡ code hiện có trước Bước 2.2)
 */
export const db = new PinkDB(LEGACY_DB_NAME);

export const ALL_TABLES = [
  'classes',
  'students',
  'attendance',
  'criteria',
  'transactions',
  'comments',
  'parentLinks',
  'gamePicks',
  'activities',
  'tasks',
  'kv',
] as const;
export type TableName = (typeof ALL_TABLES)[number];
