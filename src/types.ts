// Kiểu dữ liệu cốt lõi của Pink Classroom.
// Mọi bản ghi gắn với lớp đều có classId để tách dữ liệu theo lớp.

export type ID = string;

export interface ClassRoom {
  id: ID;
  name: string;
  schoolYear: string; // ví dụ "2026-2027"
  teacherName: string;
  subject?: string;
  note?: string;
  color: string; // màu pastel nhận diện lớp
  createdAt: number;
  updatedAt: number;
}

export type Gender = 'male' | 'female' | 'other' | '';
export type StudentStatus = 'active' | 'archived';

export interface Student {
  id: ID;
  classId: ID;
  code: string; // Mã học sinh
  fullName: string;
  birthDate?: string; // YYYY-MM-DD
  gender: Gender;
  avatar: string; // khóa avatar hoạt hình, ví dụ "cat-pink"
  parentName?: string;
  parentPhone?: string;
  note?: string;
  status: StudentStatus;
  createdAt: number;
  updatedAt: number;
}

export type AttendanceStatus = 'present' | 'excused' | 'unexcused' | 'late';
export type Session = 'morning' | 'afternoon';

export interface AttendanceRecord {
  /** Khóa duy nhất: classId|date|session|studentId → không bao giờ trùng */
  id: string;
  classId: ID;
  studentId: ID;
  date: string; // YYYY-MM-DD
  session: Session;
  status: AttendanceStatus;
  note?: string;
  updatedAt: number;
}

export type CriterionType = 'reward' | 'penalty';

export interface Criterion {
  id: ID;
  classId: ID;
  name: string;
  points: number; // dương với thưởng, âm với trừ
  type: CriterionType;
  icon: string; // khóa icon
  order: number;
  archived?: boolean;
  createdAt: number;
}

export interface PointTransaction {
  id: ID;
  classId: ID;
  studentId: ID;
  criterionId: ID | null;
  criterionName: string; // lưu bản sao tên tiêu chí tại thời điểm chấm
  delta: number;
  note?: string;
  actor: string; // người thực hiện
  batchId: string; // gom các giao dịch được tạo cùng lúc (nhiều HS / cả lớp)
  createdAt: number;
  undone?: boolean;
  undoneAt?: number;
}

export interface StudentComment {
  id: ID;
  classId: ID;
  studentId: ID;
  date: string;
  session: Session | 'all';
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GamePick {
  id: ID;
  classId: ID;
  studentId: ID;
  studentName: string;
  game: string;
  roundId: string;
  createdAt: number;
}

export interface ActivityLog {
  id: ID;
  classId: ID | null;
  kind: 'class' | 'student' | 'attendance' | 'points' | 'comment' | 'game' | 'system';
  message: string;
  createdAt: number;
}

export interface TodoTask {
  id: ID;
  classId: ID;
  title: string;
  dueDate?: string;
  done: boolean;
  createdAt: number;
}

export interface KV {
  key: string;
  value: unknown;
}

export interface AppSettings {
  teacherName: string;
  teacherTitle: 'cô' | 'thầy';
  defaultSession: Session;
  soundEnabled: boolean;
  pinHash?: string; // SHA-256(salt + pin), không lưu PIN thuần
  pinSalt?: string;
}
