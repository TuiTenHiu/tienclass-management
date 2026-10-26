import type { AttendanceRecord, AttendanceStatus, PointTransaction, Student } from '../types';
import { inRange, tsToISODate } from './utils';

/** Tổng điểm thi đua theo học sinh (bỏ qua giao dịch đã hoàn tác) */
export function pointsByStudent(txs: PointTransaction[], range?: { from: string; to: string }): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of txs) {
    if (t.undone) continue;
    if (range && !inRange(tsToISODate(t.createdAt), range)) continue;
    m.set(t.studentId, (m.get(t.studentId) ?? 0) + t.delta);
  }
  return m;
}

export function totalPoints(txs: PointTransaction[], range?: { from: string; to: string }, studentIds?: Set<string>) {
  let s = 0;
  for (const t of txs) {
    if (t.undone) continue;
    if (studentIds && !studentIds.has(t.studentId)) continue;
    if (range && !inRange(tsToISODate(t.createdAt), range)) continue;
    s += t.delta;
  }
  return s;
}

export interface AttendanceSummary {
  present: number;
  late: number;
  excused: number;
  unexcused: number;
  total: number;
  /** Tỷ lệ chuyên cần (có mặt + đi muộn) / tổng lượt */
  rate: number | null;
}

export function summarizeAttendance(records: AttendanceRecord[]): AttendanceSummary {
  const s = { present: 0, late: 0, excused: 0, unexcused: 0, total: 0 };
  for (const r of records) {
    s[r.status] += 1;
    s.total += 1;
  }
  return { ...s, rate: s.total ? (s.present + s.late) / s.total : null };
}

export function attendanceByStudent(records: AttendanceRecord[]) {
  const m = new Map<string, Record<AttendanceStatus, number>>();
  for (const r of records) {
    const cur = m.get(r.studentId) ?? { present: 0, late: 0, excused: 0, unexcused: 0 };
    cur[r.status] += 1;
    m.set(r.studentId, cur);
  }
  return m;
}

export function rankStudents(students: Student[], points: Map<string, number>) {
  return students
    .map((s) => ({ student: s, points: points.get(s.id) ?? 0 }))
    .sort((a, b) => b.points - a.points || a.student.fullName.localeCompare(b.student.fullName, 'vi'));
}

export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = {
  present: 'Có mặt',
  late: 'Đi muộn',
  excused: 'Nghỉ có phép',
  unexcused: 'Nghỉ không phép',
};
