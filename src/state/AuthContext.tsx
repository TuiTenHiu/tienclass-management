import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import {
  clearSyncedCloudCacheFromLocal,
  getCurrentUserProfile,
  syncClassesAndStudentsFromSupabase,
} from '../data/repo';
import type { UserProfile } from '../types';

export interface AuthState {
  configured: boolean;
  loading: boolean;
  syncing: boolean;
  user: User | null;
  profile: UserProfile | null;
  isCloudTeacher: boolean;
  lastSyncedAt: number | null;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; message?: string; profile?: UserProfile | null }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
  ) => Promise<{ ok: boolean; message?: string; profile?: UserProfile | null }>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<{ synced: boolean; classesCount: number; criteriaCount: number; studentsCount: number }>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState<boolean>(isSupabaseConfigured);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await syncClassesAndStudentsFromSupabase();
      if (res.synced) {
        setLastSyncedAt(Date.now());
      }
      return res;
    } finally {
      setSyncing(false);
    }
  }, []);

  const refreshProfileAndSync = useCallback(
    async (sessionUser: User | null) => {
      if (!sessionUser) {
        setUser(null);
        setProfile(null);
        await clearSyncedCloudCacheFromLocal();
        return null;
      }

      setUser(sessionUser);
      const prof = await getCurrentUserProfile();
      setProfile(prof);

      if (prof && (prof.role === 'teacher' || prof.role === 'admin')) {
        try {
          await syncNow();
        } catch {
          // Không chặn hiển thị giao diện nếu đồng bộ nền gặp lỗi tạm thời
        }
      } else {
        await clearSyncedCloudCacheFromLocal();
      }
      return prof;
    },
    [syncNow],
  );

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    let active = true;

    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (!active) return;
        await refreshProfileAndSync(data.session?.user ?? null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      void refreshProfileAndSync(session?.user ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [refreshProfileAndSync]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) {
        return { ok: false, message: 'Chưa cấu hình kết nối Supabase.' };
      }
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error || !data.user) {
        return { ok: false, message: error?.message || 'Đăng nhập thất bại.' };
      }
      const prof = await refreshProfileAndSync(data.user);
      return { ok: true, profile: prof };
    },
    [refreshProfileAndSync],
  );

  const signUp = useCallback(
    async (email: string, password: string, fullName: string) => {
      if (!supabase) {
        return { ok: false, message: 'Chưa cấu hình kết nối Supabase.' };
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim() || 'Người dùng mới',
          },
        },
      });
      if (error || !data.user) {
        return { ok: false, message: error?.message || 'Đăng ký tài khoản thất bại.' };
      }
      const prof = await refreshProfileAndSync(data.user);
      return { ok: true, profile: prof };
    },
    [refreshProfileAndSync],
  );

  const signOut = useCallback(async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setProfile(null);
    setLastSyncedAt(null);
    await clearSyncedCloudCacheFromLocal();
  }, []);

  const isCloudTeacher = Boolean(profile && (profile.role === 'teacher' || profile.role === 'admin'));

  const value = useMemo<AuthState>(
    () => ({
      configured: isSupabaseConfigured,
      loading,
      syncing,
      user,
      profile,
      isCloudTeacher,
      lastSyncedAt,
      signIn,
      signUp,
      signOut,
      syncNow,
    }),
    [loading, syncing, user, profile, isCloudTeacher, lastSyncedAt, signIn, signUp, signOut, syncNow],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) {
    throw new Error('useAuth phải được sử dụng bên trong AuthProvider');
  }
  return ctx;
}
