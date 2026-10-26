import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import type { Student } from '../types';

const byName = (a: Student, b: Student) => {
  // Sắp xếp theo tên gọi rồi họ đệm, kiểu danh sách lớp Việt Nam
  const ga = a.fullName.trim().split(/\s+/).pop() ?? '';
  const gb = b.fullName.trim().split(/\s+/).pop() ?? '';
  return ga.localeCompare(gb, 'vi') || a.fullName.localeCompare(b.fullName, 'vi');
};

/** undefined = đang tải */
export function useStudents(classId: string | undefined, status: 'active' | 'archived' | 'all' = 'active') {
  return useLiveQuery(async () => {
    if (!classId) return [] as Student[];
    const list = await db.students.where('classId').equals(classId).toArray();
    return list.filter((s) => status === 'all' || s.status === status).sort(byName);
  }, [classId, status]);
}

export function useAllStudents() {
  return useLiveQuery(async () => (await db.students.toArray()).sort(byName), []);
}

export function useCriteria(classId: string | undefined) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    const list = await db.criteria.where('classId').equals(classId).toArray();
    return list.filter((c) => !c.archived).sort((a, b) => a.order - b.order);
  }, [classId]);
}

export function useTransactions(classId: string | undefined) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    return db.transactions.where('classId').equals(classId).reverse().sortBy('createdAt');
  }, [classId]);
}

export function useAttendance(classId: string | undefined) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    return db.attendance.where('classId').equals(classId).toArray();
  }, [classId]);
}

export function useComments(classId: string | undefined) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    const list = await db.comments.where('classId').equals(classId).toArray();
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }, [classId]);
}

export function useActivities(classId: string | undefined, limit = 8) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    const list = await db.activities.where('classId').equals(classId).toArray();
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }, [classId, limit]);
}

export function useTasks(classId: string | undefined) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    const list = await db.tasks.where('classId').equals(classId).toArray();
    return list.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  }, [classId]);
}

export function useGamePicks(classId: string | undefined) {
  return useLiveQuery(async () => {
    if (!classId) return [];
    const list = await db.gamePicks.where('classId').equals(classId).toArray();
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }, [classId]);
}
