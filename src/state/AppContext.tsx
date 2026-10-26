import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { DEFAULT_SETTINGS, getSettings } from '../data/repo';
import type { AppSettings, ClassRoom } from '../types';

interface AppState {
  ready: boolean;
  classes: ClassRoom[];
  currentClass: ClassRoom | null;
  setCurrentClassId: (id: string) => void;
  settings: AppSettings;
  /** "cô Tiên" / "thầy Nam" */
  teacherCall: string;
}

const Ctx = createContext<AppState | null>(null);
const LS_KEY = 'pink-classroom.currentClassId';

export function AppProvider({ children }: { children: ReactNode }) {
  const classes = useLiveQuery(() => db.classes.orderBy('createdAt').toArray(), []);
  const settings = useLiveQuery(getSettings, []);
  const [currentId, setCurrentId] = useState<string | null>(() => localStorage.getItem(LS_KEY));

  const setCurrentClassId = useCallback((id: string) => {
    setCurrentId(id);
    localStorage.setItem(LS_KEY, id);
  }, []);

  const currentClass = useMemo(() => {
    if (!classes?.length) return null;
    return classes.find((c) => c.id === currentId) ?? classes[0];
  }, [classes, currentId]);

  // Đồng bộ lại khi lớp đang chọn bị xóa
  useEffect(() => {
    if (currentClass && currentClass.id !== currentId) {
      setCurrentId(currentClass.id);
      localStorage.setItem(LS_KEY, currentClass.id);
    }
  }, [currentClass, currentId]);

  const s = settings ?? DEFAULT_SETTINGS;
  const value: AppState = {
    ready: classes !== undefined && settings !== undefined,
    classes: classes ?? [],
    currentClass,
    setCurrentClassId,
    settings: s,
    teacherCall: `${s.teacherTitle} ${s.teacherName}`,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp phải dùng trong AppProvider');
  return c;
}
