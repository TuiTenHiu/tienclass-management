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

/**
 * Cơ sở dữ liệu cục bộ (IndexedDB) của Pink Classroom.
 * Toàn bộ thao tác ghi đi qua lớp repository (src/data/repo.ts),
 * nên có thể thay thế bằng Supabase/REST sau này mà không đổi UI.
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

  constructor(name = 'pink-classroom') {
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

export const db = new PinkDB();

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
