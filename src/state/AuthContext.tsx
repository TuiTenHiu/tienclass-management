import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import {
  clearSyncedCloudCacheFromLocal,
  getCurrentUserProfile,
  syncClassesAndStudentsFromSupabase,
  setActiveDatabase,
  invalidateAuthenticatedContextCache,
} from '../data/repo';
import { closeDatabaseForUser, getDatabaseForUser, PinkDB } from '../data/db';
import type { UserProfile } from '../types';

export interface AuthState {
  configured: boolean;
  loading: boolean;
  syncing: boolean;
  user: User | null;
  profile: UserProfile | null;
  isCloudTeacher: boolean;
  lastSyncedAt: number | null;
  authError: string | null;
  refreshAuth: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; message?: string; profile?: UserProfile | null }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
  ) => Promise<{ ok: boolean; message?: string; profile?: UserProfile | null }>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<{ synced: boolean; classesCount: number; criteriaCount: number; studentsCount: number }>;
}

export interface AuthTransitionDependencies {
  getCurrentSeq: () => number;
  getLastKnownUserId: () => string | null;
  setLastKnownUserId: (id: string | null) => void;
  setUser: (user: User | null) => void;
  setProfile: (prof: UserProfile | null) => void;
  setAuthError: (err: string | null) => void;
  getCurrentUserProfile: () => Promise<UserProfile | null>;
  syncNow: (targetDb?: PinkDB) => Promise<unknown>;
  clearSyncedCloudCacheFromLocal: (targetDb?: PinkDB) => Promise<void>;
}

/**
 * Đóng an toàn phiên làm việc của người dùng cũ:
 * 1. Ngắt tham chiếu database đang hoạt động (setActiveDatabase(null, null)).
 * 2. Lấy tham chiếu database của người dùng cũ (getDatabaseForUser(prevUserId)).
 * 3. Thực hiện dọn cache Cloud có thể tái tạo trực tiếp trên instance database của người dùng cũ.
 * 4. Đóng kết nối database của người dùng cũ và xóa khỏi registry (closeDatabaseForUser(prevUserId)).
 * 5. Bọc trong try/catch/finally để lỗi dọn cache không ngăn cản việc đóng DB hay làm ảnh hưởng phiên mới.
 */
export async function safelyCleanupAndClosePreviousUser(
  prevUserId: string,
  clearCacheFn: (targetDb: PinkDB) => Promise<void>,
): Promise<void> {
  let prevDb: PinkDB | null = null;
  try {
    prevDb = getDatabaseForUser(prevUserId);
  } catch {
    prevDb = null;
  }
  try {
    setActiveDatabase(null, null);
  } catch {
    // ignore
  }
  if (prevDb) {
    try {
      await clearCacheFn(prevDb);
    } catch (err) {
      console.warn('Lỗi trong quá trình dọn cache tài khoản cũ:', err);
    } finally {
      try {
        closeDatabaseForUser(prevUserId);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Xử lý chuyển đổi trạng thái xác thực an toàn:
 * - Dùng sequence generation counter chống race condition.
 * - Vô hiệu hóa yêu cầu lỗi thời sau mọi lệnh await.
 * - Chỉ dọn cache khi có chuyển đổi danh tính thực sự; không chạy khi khởi động ban đầu với session null.
 * - Reset quyền ngay khi bắt đầu nạp user mới để không giữ quyền của phiên cũ.
 */
export async function processAuthTransition(
  sessionUser: User | null,
  seq: number,
  deps: AuthTransitionDependencies,
): Promise<{ applied: boolean; profile: UserProfile | null }> {
  if (seq !== deps.getCurrentSeq()) {
    return { applied: false, profile: null };
  }

  // 1. Trường hợp không có session (sessionUser === null):
  if (!sessionUser) {
    const prevUserId = deps.getLastKnownUserId();
    deps.setLastKnownUserId(null);

    deps.setUser(null);
    deps.setProfile(null);
    deps.setAuthError(null);

    // CHỈ dọn cache khi chuyển đổi từ một user đã đăng nhập trước đó sang null.
    // Tuyệt đối không gọi khi khởi động ban đầu mà chưa có user (prevUserId === null).
    if (prevUserId !== null) {
      await safelyCleanupAndClosePreviousUser(prevUserId, (targetDb) =>
        deps.clearSyncedCloudCacheFromLocal(targetDb),
      );
      if (seq !== deps.getCurrentSeq()) {
        return { applied: false, profile: null };
      }
    }
    return { applied: true, profile: null };
  }

  // 2. Trường hợp có sessionUser:
  const prevUserId = deps.getLastKnownUserId();
  const isUserSwitch = prevUserId !== null && prevUserId !== sessionUser.id;
  deps.setLastKnownUserId(sessionUser.id);

  // Nếu chuyển đổi người dùng (User A -> User B), đóng kết nối cũ và dọn cache cũ của User A trước
  if (isUserSwitch) {
    await safelyCleanupAndClosePreviousUser(prevUserId, (targetDb) =>
      deps.clearSyncedCloudCacheFromLocal(targetDb),
    );
    if (seq !== deps.getCurrentSeq()) {
      return { applied: false, profile: null };
    }
  }

  // Đặt user mới và lập tức reset profile để không giữ quyền của phiên cũ trong lúc chờ tải
  deps.setUser(sessionUser);
  deps.setProfile(null);
  deps.setAuthError(null);

  let prof: UserProfile | null = null;
  let fetchError: string | null = null;
  try {
    prof = await deps.getCurrentUserProfile();
    if (!prof) {
      fetchError = 'Không tìm thấy hồ sơ người dùng trong hệ thống (public.profiles).';
    }
  } catch (err) {
    prof = null;
    fetchError = err instanceof Error ? err.message : 'Lỗi khi tải hồ sơ người dùng.';
  }

  // KIỂM TRA LỖI THỜI SAU KHI TẢI PROFILE: Vô hiệu hóa ngay nếu có request mới hơn
  if (seq !== deps.getCurrentSeq()) {
    return { applied: false, profile: null };
  }

  deps.setProfile(prof);
  deps.setAuthError(fetchError);

  // Chỉ kích hoạt syncNow khi profile hợp lệ, vai trò là teacher/admin và ID khớp với session đã xác minh
  if (
    prof &&
    (prof.role === 'teacher' || prof.role === 'admin') &&
    prof.id === sessionUser.id
  ) {
    if (seq === deps.getCurrentSeq()) {
      let userDb: PinkDB | null = null;
      try {
        userDb = getDatabaseForUser(sessionUser.id);
        setActiveDatabase(userDb, sessionUser.id);
      } catch {
        // ignore
      }

      // Kiểm tra số lớp học hiện có trong cơ sở dữ liệu cục bộ:
      // - Nếu chưa có lớp nào (vừa đăng nhập lại hoặc trên thiết bị mới), BẮT BUỘC await syncNow
      //   để tải toàn bộ lớp học từ Supabase về Dexie trước khi hoàn tất chuyển đổi.
      //   Ngăn chặn triệt để tình trạng lớp học bị biến mất hoặc nháy trạng thái "Chưa có lớp học nào".
      // - Nếu đã có lớp sẵn trong Dexie (đang hoạt động bình thường), tiếp tục chạy sync nền (non-blocking)
      //   để tối ưu hóa tốc độ tải trang.
      try {
        const localClassesCount = userDb ? await userDb.classes.count() : 0;
        if (localClassesCount === 0) {
          await deps.syncNow(userDb ?? undefined);
        } else {
          void deps.syncNow(userDb ?? undefined).catch((err) => {
            console.warn('[AuthContext] Lỗi đồng bộ nền không nghiêm trọng:', err);
          });
        }
      } catch (err) {
        console.warn('[AuthContext] Lỗi đồng bộ khi đăng nhập:', err);
      }

      if (seq !== deps.getCurrentSeq()) {
        return { applied: false, profile: prof };
      }
    }
  } else {
    // Nếu vai trò không phải giáo viên/admin (ví dụ: parent), đóng database và dọn dẹp cache nếu trước đó có user
    if (prevUserId !== null) {
      await safelyCleanupAndClosePreviousUser(prevUserId, (targetDb) =>
        deps.clearSyncedCloudCacheFromLocal(targetDb),
      );
      if (seq !== deps.getCurrentSeq()) {
        return { applied: false, profile: prof };
      }
    }
  }

  return { applied: true, profile: prof };
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState<boolean>(isSupabaseConfigured);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Biến đếm thế hệ yêu cầu (Request generation/sequence counter) chống race condition
  const currentSeqRef = useRef<number>(0);
  // Theo dõi ID người dùng đã đăng nhập gần nhất để chỉ dọn cache khi chuyển đổi danh tính thực sự
  const lastKnownUserIdRef = useRef<string | null>(null);
  // Bộ lưu tạm yêu cầu chuyển đổi đang thực thi (In-flight promise deduplication)
  const inFlightTransitionRef = useRef<{
    userId: string | null;
    seq: number;
    promise: Promise<UserProfile | null>;
  } | null>(null);

  const syncNow = useCallback(async (targetDb?: PinkDB) => {
    setSyncing(true);
    try {
      const res = await syncClassesAndStudentsFromSupabase(undefined, targetDb);
      if (res.synced) {
        setLastSyncedAt(Date.now());
      }
      return res;
    } finally {
      setSyncing(false);
    }
  }, []);

  const refreshProfileAndSync = useCallback(
    async (sessionUser: User | null, targetSeq?: number) => {
      const targetUserId = sessionUser?.id ?? null;
      if (inFlightTransitionRef.current && inFlightTransitionRef.current.userId === targetUserId) {
        return inFlightTransitionRef.current.promise;
      }

      const seq = targetSeq ?? ++currentSeqRef.current;
      const transitionPromise = (async () => {
        try {
          const res = await processAuthTransition(sessionUser, seq, {
            getCurrentSeq: () => currentSeqRef.current,
            getLastKnownUserId: () => lastKnownUserIdRef.current,
            setLastKnownUserId: (id) => {
              lastKnownUserIdRef.current = id;
            },
            setUser,
            setProfile,
            setAuthError,
            getCurrentUserProfile: () => getCurrentUserProfile(sessionUser),
            syncNow,
            clearSyncedCloudCacheFromLocal,
          });
          return res.profile;
        } finally {
          if (inFlightTransitionRef.current?.seq === seq) {
            inFlightTransitionRef.current = null;
          }
        }
      })();

      inFlightTransitionRef.current = {
        userId: targetUserId,
        seq,
        promise: transitionPromise,
      };

      return transitionPromise;
    },
    [syncNow],
  );

  const refreshAuth = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const seq = ++currentSeqRef.current;
    setLoading(true);
    setAuthError(null);

    const safetyTimeout = setTimeout(() => {
      setLoading(false);
    }, 5000);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (seq !== currentSeqRef.current) return;
      if (error) {
        setAuthError(error.message);
        setUser(null);
        setProfile(null);
        return;
      }
      await refreshProfileAndSync(data.session?.user ?? null, seq);
    } catch (err) {
      if (seq !== currentSeqRef.current) return;
      setAuthError(err instanceof Error ? err.message : 'Lỗi kết nối Supabase.');
      setUser(null);
      setProfile(null);
    } finally {
      clearTimeout(safetyTimeout);
      if (seq === currentSeqRef.current) {
        setLoading(false);
      }
    }
  }, [refreshProfileAndSync]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    const seq = ++currentSeqRef.current;
    let isSubscribed = true;

    // Timeout an toàn phòng vệ (5 giây): Bắt buộc hoàn tất trạng thái loading
    // ngay cả khi kết nối mạng Supabase bị treo, timeout hoặc gặp lỗi mạng.
    const safetyTimeout = setTimeout(() => {
      if (isSubscribed) {
        setLoading((prevLoading) => {
          if (prevLoading) {
            console.warn('[AuthContext] Hết thời gian chờ xác thực ban đầu (5s timeout). Thoát trạng thái loading.');
            return false;
          }
          return false;
        });
      }
    }, 5000);

    const finishLoading = (targetSeq: number) => {
      if (isSubscribed && targetSeq === currentSeqRef.current) {
        setLoading(false);
        clearTimeout(safetyTimeout);
      }
    };

    supabase.auth
      .getSession()
      .then(async ({ data, error }) => {
        if (!isSubscribed || seq !== currentSeqRef.current) return;
        if (error) {
          setAuthError(error.message);
          setUser(null);
          setProfile(null);
          return;
        }
        await refreshProfileAndSync(data.session?.user ?? null, seq);
      })
      .catch((err) => {
        if (!isSubscribed || seq !== currentSeqRef.current) return;
        setAuthError(err instanceof Error ? err.message : 'Lỗi kết nối Supabase.');
        setUser(null);
        setProfile(null);
      })
      .finally(() => {
        finishLoading(seq);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!isSubscribed) return;

      // Khi Supabase tự động gia hạn token (TOKEN_REFRESHED), nếu danh tính không đổi,
      // chỉ cập nhật user state mà không gửi lặp các truy vấn profile hay sync database
      if (event === 'TOKEN_REFRESHED') {
        if (session?.user && session.user.id === lastKnownUserIdRef.current) {
          setUser(session.user);
          return;
        }
      }

      const changeSeq = ++currentSeqRef.current;
      try {
        await refreshProfileAndSync(session?.user ?? null, changeSeq);
      } catch (err) {
        if (isSubscribed && changeSeq === currentSeqRef.current) {
          setAuthError(err instanceof Error ? err.message : 'Lỗi cập nhật phiên.');
        }
      } finally {
        finishLoading(changeSeq);
      }
    });

    return () => {
      isSubscribed = false;
      clearTimeout(safetyTimeout);
      ++currentSeqRef.current;
      subscription.unsubscribe();
    };
  }, [refreshProfileAndSync]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) {
        return { ok: false, message: 'Chưa cấu hình kết nối Supabase.' };
      }
      setAuthError(null);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error || !data.user) {
        const msg = error?.message || 'Đăng nhập thất bại.';
        setAuthError(msg);
        return { ok: false, message: msg };
      }
      const seq = ++currentSeqRef.current;
      const prof = await refreshProfileAndSync(data.user, seq);
      return { ok: true, profile: prof };
    },
    [refreshProfileAndSync],
  );

  const signUp = useCallback(
    async (email: string, password: string, fullName: string) => {
      if (!supabase) {
        return { ok: false, message: 'Chưa cấu hình kết nối Supabase.' };
      }
      const seq = ++currentSeqRef.current;
      setAuthError(null);
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim() || 'Người dùng mới',
          },
        },
      });
      if (seq !== currentSeqRef.current) {
        return { ok: false, message: 'Yêu cầu đăng ký đã bị hủy bởi thao tác mới hơn.' };
      }
      if (error || !data.user) {
        const msg = error?.message || 'Đăng ký tài khoản thất bại.';
        setAuthError(msg);
        return { ok: false, message: msg };
      }
      const prof = await refreshProfileAndSync(data.user, seq);
      return { ok: true, profile: prof };
    },
    [refreshProfileAndSync],
  );

  const signOut = useCallback(async () => {
    const seq = ++currentSeqRef.current;
    const prevUserId = lastKnownUserIdRef.current;
    lastKnownUserIdRef.current = null;

    setUser(null);
    setProfile(null);
    setAuthError(null);
    setLastSyncedAt(null);
    invalidateAuthenticatedContextCache();

    if (supabase) {
      try {
        await supabase.auth.signOut();
      } catch {
        // ignore
      }
    }

    if (seq !== currentSeqRef.current) return;

    if (prevUserId !== null) {
      await safelyCleanupAndClosePreviousUser(prevUserId, (targetDb) =>
        clearSyncedCloudCacheFromLocal(targetDb),
      );
    }
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
      authError,
      refreshAuth,
      signIn,
      signUp,
      signOut,
      syncNow,
    }),
    [loading, syncing, user, profile, isCloudTeacher, lastSyncedAt, authError, refreshAuth, signIn, signUp, signOut, syncNow],
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
