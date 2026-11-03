import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock supabaseClient
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn().mockImplementation(() => {
  return {
    data: {
      subscription: {
        unsubscribe: vi.fn(),
      },
    },
  };
});

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: (...args: any[]) => mockGetSession(...args),
      onAuthStateChange: (...args: any[]) => mockOnAuthStateChange(...args),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
  },
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

vi.mock('../data/repo', () => ({
  getCurrentUserProfile: vi.fn().mockResolvedValue(null),
  syncClassesAndStudentsFromSupabase: vi.fn().mockResolvedValue({ synced: true, classesCount: 0, criteriaCount: 0, studentsCount: 0 }),
  clearSyncedCloudCacheFromLocal: vi.fn().mockResolvedValue(undefined),
  setActiveDatabase: vi.fn(),
}));

import { processAuthTransition, type AuthTransitionDependencies } from './AuthContext';

describe('AuthContext: Loading State & Lifecycle Termination Tests', () => {
  let seqCounter = 0;
  let lastKnownUserId: string | null = null;
  let currentUserState: any = null;
  let currentProfileState: any = null;

  beforeEach(() => {
    vi.clearAllMocks();
    seqCounter = 0;
    lastKnownUserId = null;
    currentUserState = null;
    currentProfileState = null;
  });

  const createDeps = (): AuthTransitionDependencies => ({
    getCurrentSeq: () => seqCounter,
    getLastKnownUserId: () => lastKnownUserId,
    setLastKnownUserId: (id) => {
      lastKnownUserId = id;
    },
    setUser: (u) => {
      currentUserState = u;
    },
    setProfile: (p) => {
      currentProfileState = p;
    },
    setAuthError: () => {},
    getCurrentUserProfile: vi.fn().mockResolvedValue(null),
    syncNow: vi.fn().mockResolvedValue({ synced: true }),
    clearSyncedCloudCacheFromLocal: vi.fn().mockResolvedValue(undefined),
  });

  it('1. processAuthTransition với null session: Áp dụng thành công và trả về profile null', async () => {
    seqCounter = 1;
    const deps = createDeps();

    const res = await processAuthTransition(null, 1, deps);
    expect(res.applied).toBe(true);
    expect(res.profile).toBeNull();
    expect(currentUserState).toBeNull();
    expect(currentProfileState).toBeNull();
  });

  it('2. Quá trình xử lý không bị chặn khi request bị supersede bởi sequence mới hơn', async () => {
    seqCounter = 1;
    const deps = createDeps();

    const mockUser: any = { id: 'teacher-1', email: 'teacher@pink.edu.vn' };
    const transitionPromise = processAuthTransition(mockUser, 1, deps);
    seqCounter = 2; // Superseded by onAuthStateChange while loading profile

    const res = await transitionPromise;
    expect(res.applied).toBe(false);
  });
});
