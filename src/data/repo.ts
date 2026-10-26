import { db, ALL_TABLES } from './db';
import type {
  ActivityLog,
  AppSettings,
  AttendanceRecord,
  AttendanceStatus,
  ClassRoom,
  Criterion,
  PointTransaction,
  Session,
  Student,
  StudentComment,
  TodoTask,
} from '../types';
import { isValidISODate, isValidPhone, normalizeVN, uid } from '../lib/utils';

/* =========================================================
 * Repository: lớp trung gian duy nhất ghi/đọc dữ liệu.
 * Thay thế file này bằng bản Supabase để đồng bộ nhiều thiết bị.
 * ========================================================= */

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

export async function getSettings(): Promise<AppSettings> {
  const row = await db.kv.get('settings');
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) || {}) };
}

export async function saveSettings(patch: Partial<AppSettings>) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  if (!next.teacherName.trim()) throw new ValidationError({ teacherName: 'Vui lòng nhập tên giáo viên' });
  await db.kv.put({ key: 'settings', value: next });
  return next;
}

export async function actorName(): Promise<string> {
  const s = await getSettings();
  return `${s.teacherTitle === 'cô' ? 'Cô' : 'Thầy'} ${s.teacherName}`;
}

/* ---------------- Activity log ---------------- */

export async function logActivity(classId: string | null, kind: ActivityLog['kind'], message: string) {
  await db.activities.add({ id: uid('a_'), classId, kind, message, createdAt: Date.now() });
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

export async function createClass(input: ClassInput): Promise<ClassRoom> {
  const errors = validateClass(input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const dup = await db.classes.filter((c) => normalizeVN(c.name) === normalizeVN(input.name) && c.schoolYear === input.schoolYear.trim()).first();
  if (dup) throw new ValidationError({ name: 'Đã có lớp cùng tên trong năm học này' });
  const count = await db.classes.count();
  const now = Date.now();
  const cls: ClassRoom = {
    id: uid('c_'),
    name: input.name.trim(),
    schoolYear: input.schoolYear.trim(),
    teacherName: input.teacherName.trim(),
    subject: input.subject?.trim(),
    note: input.note?.trim(),
    color: input.color || CLASS_COLORS[count % CLASS_COLORS.length],
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', db.classes, db.criteria, db.activities, async () => {
    await db.classes.add(cls);
    await db.criteria.bulkAdd(
      DEFAULT_CRITERIA.map((c, i) => ({ ...c, id: uid('cr_'), classId: cls.id, order: i, createdAt: now })),
    );
    await logActivity(cls.id, 'class', `Tạo lớp ${cls.name}`);
  });
  return cls;
}

export async function updateClass(id: string, input: ClassInput) {
  const errors = validateClass(input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const dup = await db.classes
    .filter((c) => c.id !== id && normalizeVN(c.name) === normalizeVN(input.name) && c.schoolYear === input.schoolYear.trim())
    .first();
  if (dup) throw new ValidationError({ name: 'Đã có lớp cùng tên trong năm học này' });
  await db.classes.update(id, {
    name: input.name.trim(),
    schoolYear: input.schoolYear.trim(),
    teacherName: input.teacherName.trim(),
    subject: input.subject?.trim(),
    note: input.note?.trim(),
    color: input.color,
    updatedAt: Date.now(),
  });
  await logActivity(id, 'class', `Cập nhật thông tin lớp ${input.name.trim()}`);
}

/** Xóa lớp và toàn bộ dữ liệu thuộc lớp (gọi sau khi giáo viên đã xác nhận & được gợi ý sao lưu) */
export async function deleteClass(id: string) {
  const cls = await db.classes.get(id);
  await db.transaction(
    'rw',
    [db.classes, db.students, db.attendance, db.criteria, db.transactions, db.comments, db.gamePicks, db.tasks, db.activities],
    async () => {
      await db.students.where('classId').equals(id).delete();
      await db.attendance.where('classId').equals(id).delete();
      await db.criteria.where('classId').equals(id).delete();
      await db.transactions.where('classId').equals(id).delete();
      await db.comments.where('classId').equals(id).delete();
      await db.gamePicks.where('classId').equals(id).delete();
      await db.tasks.where('classId').equals(id).delete();
      await db.activities.where('classId').equals(id).delete();
      await db.classes.delete(id);
      await logActivity(null, 'class', `Đã xóa lớp ${cls?.name ?? ''}`);
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
export async function isCodeTaken(code: string, exceptId?: string) {
  const c = code.trim().toUpperCase();
  const found = await db.students.filter((s) => s.code.toUpperCase() === c && s.id !== exceptId).first();
  return !!found;
}

export async function suggestNextCode(): Promise<string> {
  const all = await db.students.toArray();
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

export async function addStudent(classId: string, input: StudentInput): Promise<Student> {
  const errors = validateStudentInput(input);
  if (!errors.code && (await isCodeTaken(input.code))) errors.code = 'Mã học sinh đã tồn tại';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const now = Date.now();
  const s: Student = { id: uid('s_'), classId, ...cleanStudent(input), status: 'active', createdAt: now, updatedAt: now };
  await db.students.add(s);
  await logActivity(classId, 'student', `Thêm học sinh ${s.fullName}`);
  return s;
}

export async function updateStudent(id: string, input: StudentInput) {
  const errors = validateStudentInput(input);
  if (!errors.code && (await isCodeTaken(input.code, id))) errors.code = 'Mã học sinh đã tồn tại';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const cur = await db.students.get(id);
  if (!cur) throw new Error('Không tìm thấy học sinh');
  await db.students.update(id, { ...cleanStudent(input), updatedAt: Date.now() });
  await logActivity(cur.classId, 'student', `Cập nhật hồ sơ ${input.fullName.trim()}`);
}

export async function bulkAddStudents(classId: string, inputs: StudentInput[]) {
  const now = Date.now();
  const rows: Student[] = inputs.map((i, idx) => ({
    id: uid('s_'),
    classId,
    ...cleanStudent(i),
    status: 'active',
    createdAt: now + idx,
    updatedAt: now + idx,
  }));
  await db.transaction('rw', db.students, db.activities, async () => {
    // kiểm tra lại trùng mã ngay trong giao dịch để an toàn
    const existing = new Set((await db.students.toArray()).map((s) => s.code.toUpperCase()));
    for (const r of rows) {
      if (existing.has(r.code)) throw new Error(`Mã ${r.code} đã tồn tại`);
      existing.add(r.code);
    }
    await db.students.bulkAdd(rows);
    await logActivity(classId, 'student', `Nhập ${rows.length} học sinh từ Excel`);
  });
  return rows.length;
}

/** Lưu trữ (xóa mềm) – có thể khôi phục */
export async function archiveStudents(ids: string[]) {
  const list = await db.students.bulkGet(ids);
  await db.students.where('id').anyOf(ids).modify({ status: 'archived', updatedAt: Date.now() });
  const first = list.find(Boolean);
  if (first) await logActivity(first.classId, 'student', `Chuyển ${ids.length} học sinh vào mục lưu trữ`);
}

export async function restoreStudents(ids: string[]) {
  const list = await db.students.bulkGet(ids);
  await db.students.where('id').anyOf(ids).modify({ status: 'active', updatedAt: Date.now() });
  const first = list.find(Boolean);
  if (first) await logActivity(first.classId, 'student', `Khôi phục ${ids.length} học sinh`);
}

/** Xóa vĩnh viễn học sinh và dữ liệu liên quan */
export async function deleteStudentsPermanently(ids: string[]) {
  const list = (await db.students.bulkGet(ids)).filter(Boolean) as Student[];
  await db.transaction('rw', [db.students, db.attendance, db.transactions, db.comments, db.gamePicks, db.activities], async () => {
    await db.attendance.where('studentId').anyOf(ids).delete();
    await db.transactions.where('studentId').anyOf(ids).delete();
    await db.comments.where('studentId').anyOf(ids).delete();
    await db.gamePicks.filter((g) => ids.includes(g.studentId)).delete();
    await db.students.bulkDelete(ids);
    if (list[0]) await logActivity(list[0].classId, 'student', `Xóa vĩnh viễn ${list.length} học sinh`);
  });
}

/** Chuyển lớp: lịch sử cũ vẫn nằm ở lớp cũ, học sinh bắt đầu dữ liệu mới ở lớp mới */
export async function transferStudents(ids: string[], toClassId: string) {
  const target = await db.classes.get(toClassId);
  if (!target) throw new Error('Lớp đích không tồn tại');
  const list = (await db.students.bulkGet(ids)).filter(Boolean) as Student[];
  await db.students.where('id').anyOf(ids).modify({ classId: toClassId, updatedAt: Date.now() });
  if (list[0]) {
    await logActivity(list[0].classId, 'student', `Chuyển ${list.length} học sinh sang lớp ${target.name}`);
    await logActivity(toClassId, 'student', `Nhận ${list.length} học sinh chuyển đến`);
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
) {
  if (!isValidISODate(date)) throw new Error('Ngày điểm danh không hợp lệ');
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
  const existed = await db.attendance.where('[classId+date+session]').equals([classId, date, session]).count();
  await db.attendance.bulkPut(rows);
  const absent = rows.filter((r) => r.status === 'excused' || r.status === 'unexcused').length;
  await logActivity(
    classId,
    'attendance',
    `${existed ? 'Cập nhật' : 'Điểm danh'} buổi ${session === 'morning' ? 'sáng' : 'chiều'} ${date.split('-').reverse().join('/')}: vắng ${absent}`,
  );
}

export async function clearAttendance(classId: string, date: string, session: Session) {
  await db.attendance.where('[classId+date+session]').equals([classId, date, session]).delete();
  await logActivity(classId, 'attendance', `Xóa điểm danh ngày ${date.split('-').reverse().join('/')}`);
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

export async function saveCriterion(classId: string, input: CriterionInput, id?: string) {
  const e = validateCriterion(input);
  if (Object.keys(e).length) throw new ValidationError(e);
  if (id) {
    await db.criteria.update(id, { name: input.name.trim(), points: input.points, type: input.type, icon: input.icon });
  } else {
    const max = (await db.criteria.where('classId').equals(classId).toArray()).reduce((m, c) => Math.max(m, c.order), -1);
    await db.criteria.add({ id: uid('cr_'), classId, ...input, name: input.name.trim(), order: max + 1, createdAt: Date.now() });
  }
}

/** Tiêu chí đã dùng thì ẩn (archived) thay vì xóa để giữ lịch sử */
export async function removeCriterion(id: string) {
  const used = await db.transactions.filter((t) => t.criterionId === id).count();
  if (used > 0) await db.criteria.update(id, { archived: true });
  else await db.criteria.delete(id);
}

/* ---------------- Points ---------------- */

export async function awardPoints(opts: {
  classId: string;
  studentIds: string[];
  criterion?: Criterion | null;
  customName?: string;
  delta?: number;
  note?: string;
}) {
  const { classId, studentIds } = opts;
  if (!studentIds.length) throw new Error('Chưa chọn học sinh nào');
  const delta = opts.criterion ? opts.criterion.points : Number(opts.delta);
  const name = opts.criterion ? opts.criterion.name : (opts.customName || '').trim();
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) throw new Error('Số điểm phải là số nguyên khác 0 (tối đa ±100)');
  if (!name) throw new Error('Vui lòng nhập lý do');
  // chỉ cho phép học sinh đang học thuộc lớp hiện tại
  const valid = (await db.students.bulkGet(studentIds)).filter((s): s is Student => !!s && s.classId === classId && s.status === 'active');
  if (!valid.length) throw new Error('Không có học sinh hợp lệ trong lớp');
  const actor = await actorName();
  const batchId = uid('b_');
  const now = Date.now();
  const rows: PointTransaction[] = valid.map((s) => ({
    id: uid('t_'),
    classId,
    studentId: s.id,
    criterionId: opts.criterion?.id ?? null,
    criterionName: name,
    delta,
    note: opts.note?.trim() || undefined,
    actor,
    batchId,
    createdAt: now,
  }));
  await db.transactions.bulkAdd(rows);
  const who = valid.length === 1 ? valid[0].fullName : `${valid.length} học sinh`;
  await logActivity(classId, 'points', `${delta > 0 ? '+' : ''}${delta} điểm "${name}" cho ${who}`);
  return { batchId, count: rows.length };
}

export async function undoTransaction(id: string) {
  const t = await db.transactions.get(id);
  if (!t || t.undone) return;
  await db.transactions.update(id, { undone: true, undoneAt: Date.now() });
  await logActivity(t.classId, 'points', `Hoàn tác ${t.delta > 0 ? '+' : ''}${t.delta} điểm "${t.criterionName}"`);
}

export async function undoBatch(batchId: string) {
  const list = await db.transactions.where('batchId').equals(batchId).toArray();
  const live = list.filter((t) => !t.undone);
  if (!live.length) return;
  const now = Date.now();
  await db.transactions.bulkPut(live.map((t) => ({ ...t, undone: true, undoneAt: now })));
  await logActivity(live[0].classId, 'points', `Hoàn tác lượt chấm "${live[0].criterionName}" (${live.length} học sinh)`);
}

export async function redoTransaction(id: string) {
  const t = await db.transactions.get(id);
  if (!t || !t.undone) return;
  await db.transactions.update(id, { undone: false, undoneAt: undefined });
}

/* ---------------- Comments ---------------- */

export interface CommentInput {
  studentId: string;
  date: string;
  session: StudentComment['session'];
  content: string;
  tags: string[];
}

export async function saveComment(classId: string, input: CommentInput, id?: string) {
  const e: Record<string, string> = {};
  if (!input.studentId) e.studentId = 'Vui lòng chọn học sinh';
  if (!isValidISODate(input.date)) e.date = 'Ngày không hợp lệ';
  if (!input.content.trim()) e.content = 'Vui lòng nhập nội dung nhận xét';
  else if (input.content.length > 2000) e.content = 'Nhận xét tối đa 2000 ký tự';
  if (Object.keys(e).length) throw new ValidationError(e);
  const now = Date.now();
  const student = await db.students.get(input.studentId);
  if (id) {
    await db.comments.update(id, { ...input, content: input.content.trim(), updatedAt: now });
    await logActivity(classId, 'comment', `Sửa nhận xét cho ${student?.fullName ?? ''}`);
  } else {
    await db.comments.add({ id: uid('cm_'), classId, ...input, content: input.content.trim(), createdAt: now, updatedAt: now });
    await logActivity(classId, 'comment', `Ghi nhận xét cho ${student?.fullName ?? ''}`);
  }
}

export async function deleteComment(id: string) {
  await db.comments.delete(id);
}

/* ---------------- Tasks (hoạt động cần hoàn thành) ---------------- */

export async function addTask(classId: string, title: string, dueDate?: string) {
  if (!title.trim()) throw new ValidationError({ title: 'Vui lòng nhập tên hoạt động' });
  if (title.trim().length > 120) throw new ValidationError({ title: 'Tối đa 120 ký tự' });
  const t: TodoTask = { id: uid('td_'), classId, title: title.trim(), dueDate: dueDate || undefined, done: false, createdAt: Date.now() };
  await db.tasks.add(t);
}

export async function toggleTask(id: string) {
  const t = await db.tasks.get(id);
  if (t) await db.tasks.update(id, { done: !t.done });
}

export async function deleteTask(id: string) {
  await db.tasks.delete(id);
}

/* ---------------- Game picks ---------------- */

export async function saveGamePick(classId: string, student: Student, roundId: string) {
  await db.gamePicks.add({
    id: uid('g_'),
    classId,
    studentId: student.id,
    studentName: student.fullName,
    game: 'dog-chase',
    roundId,
    createdAt: Date.now(),
  });
  await logActivity(classId, 'game', `Chú chó tinh nghịch chọn ${student.fullName}`);
}

export async function clearGamePicks(classId: string) {
  await db.gamePicks.where('classId').equals(classId).delete();
}

/* ---------------- Backup ---------------- */

export const BACKUP_FORMAT = 'pink-classroom-backup';

export async function exportBackup() {
  const data: Record<string, unknown[]> = {};
  for (const t of ALL_TABLES) data[t] = await db.table(t).toArray();
  return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), data };
}

export async function importBackup(json: unknown) {
  const obj = json as { format?: string; data?: Record<string, unknown[]> };
  if (!obj || obj.format !== BACKUP_FORMAT || !obj.data) throw new Error('File không phải bản sao lưu Pink Classroom');
  for (const t of ALL_TABLES) {
    if (obj.data[t] !== undefined && !Array.isArray(obj.data[t])) throw new Error(`Dữ liệu bảng ${t} bị hỏng`);
  }
  await db.transaction('rw', ALL_TABLES.map((t) => db.table(t)), async () => {
    for (const t of ALL_TABLES) {
      await db.table(t).clear();
      const rows = obj.data![t];
      if (rows?.length) await db.table(t).bulkAdd(rows);
    }
  });
}

export async function wipeAll() {
  await db.transaction('rw', ALL_TABLES.map((t) => db.table(t)), async () => {
    for (const t of ALL_TABLES) {
      if (t === 'kv') continue;
      await db.table(t).clear();
    }
  });
}
