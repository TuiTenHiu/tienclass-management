import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from './AppContext';
import type { Student } from '../types';

const byName = (a: Student, b: Student) => {
  // Sắp xếp theo tên gọi rồi họ đệm, kiểu danh sách lớp Việt Nam
  const ga = a.fullName.trim().split(/\s+/).pop() ?? '';
  const gb = b.fullName.trim().split(/\s+/).pop() ?? '';
  return ga.localeCompare(gb, 'vi') || a.fullName.localeCompare(b.fullName, 'vi');
};

/** undefined = đang tải */
export function useStudents(classId: string | undefined, status: 'active' | 'archived' | 'all' = 'active') {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [] as Student[];
      const list = await db.students.where('classId').equals(classId).toArray();
      return list.filter((s) => status === 'all' || s.status === status).sort(byName);
    },
    [classId, status, db],
  );
}

export function useAllStudents() {
  const { db } = useApp();
  return useLiveQuery(async () => (await db.students.toArray()).sort(byName), [db]);
}

export function useCriteria(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      const list = await db.criteria.where('classId').equals(classId).toArray();
      return list.filter((c) => !c.archived).sort((a, b) => a.order - b.order);
    },
    [classId, db],
  );
}

export function useTransactions(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      return db.transactions.where('classId').equals(classId).reverse().sortBy('createdAt');
    },
    [classId, db],
  );
}

export function useAttendance(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      return db.attendance.where('classId').equals(classId).toArray();
    },
    [classId, db],
  );
}

export function useComments(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      const list = await db.comments.where('classId').equals(classId).toArray();
      return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    },
    [classId, db],
  );
}

export function useActivities(classId: string | undefined, limit = 8) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      const list = await db.activities.where('classId').equals(classId).toArray();
      return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
    [classId, limit, db],
  );
}

export function useTasks(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      const list = await db.tasks.where('classId').equals(classId).toArray();
      return list.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
    },
    [classId, db],
  );
}

export function useGamePicks(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      const list = await db.gamePicks.where('classId').equals(classId).toArray();
      return list.sort((a, b) => b.createdAt - a.createdAt);
    },
    [classId, db],
  );
}

export function useParentLinks(classId: string | undefined) {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      if (!classId) return [];
      return db.parentLinks.where('classId').equals(classId).toArray();
    },
    [classId, db],
  );
}

export function useAttendanceToday(classId: string | undefined, today: string) {
  const { db } = useApp();
  return useLiveQuery(
    async () => (classId ? db.attendance.where('[classId+date]').equals([classId, today]).count() : 0),
    [classId, today, db],
  );
}

export function useActiveStudentCountsByClass() {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      const all = await db.students.where('status').equals('active').toArray();
      const m = new Map<string, number>();
      all.forEach((s) => m.set(s.classId, (m.get(s.classId) ?? 0) + 1));
      return m;
    },
    [db],
  );
}

export function useStudentStatusCountsByClass() {
  const { db } = useApp();
  return useLiveQuery(
    async () => {
      const all = await db.students.toArray();
      const m = new Map<string, { active: number; archived: number }>();
      all.forEach((s) => {
        const c = m.get(s.classId) ?? { active: 0, archived: 0 };
        c[s.status] += 1;
        m.set(s.classId, c);
      });
      return m;
    },
    [db],
  );
}
