import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDatabaseForUser, type PinkDB } from '../data/db';
import { DEFAULT_SETTINGS, getSettings, setActiveDatabase } from '../data/repo';
import { useAuth } from './AuthContext';
import type { AppSettings, ClassRoom } from '../types';

export interface AppState {
  ready: boolean;
  classes: ClassRoom[];
  currentClass: ClassRoom | null;
  setCurrentClassId: (id: string) => void;
  settings: AppSettings;
  /** "cô Tiên" / "thầy Nam" */
  teacherCall: string;
  /** Dexie instance riêng biệt của tài khoản giáo viên hiện hành */
  db: PinkDB;
  userId: string;
}

export const Ctx = createContext<AppState | null>(null);
export { Ctx as AppContext };

export function AppProvider({ children }: { children: ReactNode }) {
  const { user, profile, isCloudTeacher } = useAuth();

  // Phòng vệ theo chiều sâu: AppProvider chỉ hoạt động khi danh tính và quyền giáo viên đã được xác minh
  if (!user || !profile || !isCloudTeacher) {
    return null;
  }

  const userId = user.id;
  const userDb = useMemo(() => getDatabaseForUser(userId), [userId]);

  // Đăng ký active database cho repository trong suốt vòng đời của provider
  useEffect(() => {
    setActiveDatabase(userDb, userId);
    return () => {
      setActiveDatabase(null, null);
    };
  }, [userDb, userId]);

  // Khóa lưu trữ class đang chọn được cô lập theo user ID
  const lsKey = useMemo(() => `pink-classroom.currentClassId.${userId}`, [userId]);

  const classes = useLiveQuery(() => userDb.classes.orderBy('createdAt').toArray(), [userDb]);
  const settings = useLiveQuery(() => getSettings(userDb), [userDb]);
  const [currentId, setCurrentId] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(lsKey) : null,
  );

  const setCurrentClassId = useCallback(
    (id: string) => {
      setCurrentId(id);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(lsKey, id);
      }
    },
    [lsKey],
  );

  const currentClass = useMemo(() => {
    if (!classes?.length) return null;
    return classes.find((c) => c.id === currentId) ?? classes[0];
  }, [classes, currentId]);

  // Đồng bộ lại khi lớp đang chọn bị xóa hoặc không còn tồn tại
  useEffect(() => {
    if (currentClass && currentClass.id !== currentId) {
      setCurrentId(currentClass.id);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(lsKey, currentClass.id);
      }
    }
  }, [currentClass, currentId, lsKey]);

  const s = settings ?? DEFAULT_SETTINGS;
  const value: AppState = {
    ready: classes !== undefined && settings !== undefined,
    classes: classes ?? [],
    currentClass,
    setCurrentClassId,
    settings: s,
    teacherCall: `${s.teacherTitle} ${s.teacherName}`,
    db: userDb,
    userId,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp phải dùng trong AppProvider');
  return c;
}

export function useCurrentDb(): PinkDB {
  return useApp().db;
}
