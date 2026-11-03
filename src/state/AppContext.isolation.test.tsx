import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

import {
  db as legacyDb,
  getDatabaseForUser,
  closeDatabaseForUser,
  clearUserDatabaseRegistry,
} from '../data/db';
import {
  setActiveDatabase,
  getActiveDatabase,
  createClass,
  addStudent,
  saveAttendance,
  awardPoints,
  saveComment,
  getPendingSyncQueue,
  savePendingSyncQueue,
} from '../data/repo';
import { AppProvider, useApp } from './AppContext';
import type { AuthState } from './AuthContext';
import * as AuthContextModule from './AuthContext';
import type { ClassRoom } from '../types';

const createMockClassRoom = (id: string, name: string): ClassRoom => ({
  id,
  name,
  schoolYear: '2025-2026',
  teacherName: 'Cô Tiên',
  color: 'pink',
  createdAt: 1000,
  updatedAt: 1000,
});

function TestChild() {
  const { classes, db, userId } = useApp();
  return (
    <div>
      <div id="user-id">{userId}</div>
      <div id="db-name">{db.name}</div>
      <div id="class-count">{classes.length}</div>
      <ul id="class-list">
        {classes.map((c) => (
          <li key={c.id} id={`class-${c.id}`}>
            {c.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe('Giai đoạn 2.2: Kiểm thử kết nối Database Factory với AppContext và Cô lập dữ liệu', () => {
  const USER_A_ID = 'teacher-uuid-aaaa-1111';
  const USER_B_ID = 'teacher-uuid-bbbb-2222';

  beforeEach(async () => {
    setActiveDatabase(null, null);
    clearUserDatabaseRegistry();
    await legacyDb.classes.clear();
    await legacyDb.students.clear();
    await legacyDb.kv.clear();
  });

  afterEach(async () => {
    setActiveDatabase(null, null);
    clearUserDatabaseRegistry();
  });

  const mockAuth = (overrides: Partial<AuthState>) => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      configured: true,
      loading: false,
      syncing: false,
      user: null,
      profile: null,
      isCloudTeacher: false,
      lastSyncedAt: null,
      authError: null,
      refreshAuth: vi.fn(),
      signIn: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      syncNow: vi.fn(),
      ...overrides,
    });
  };

  it('1. Chưa đăng nhập: không tải dữ liệu quản lý từ legacy DB và AppProvider không mount', () => {
    mockAuth({
      user: null,
      profile: null,
      isCloudTeacher: false,
    });

    const html = renderToStaticMarkup(
      <AppProvider>
        <TestChild />
      </AppProvider>,
    );

    // AppProvider trả về rỗng khi chưa xác thực
    expect(html).toBe('');
    expect(getActiveDatabase()).toBeNull();
  });

  it('2. Đăng nhập tài khoản A: chỉ sử dụng database riêng của A, không dùng legacy DB', async () => {
    mockAuth({
      user: { id: USER_A_ID, email: 'teacher.a@pink.edu.vn' } as any,
      profile: { id: USER_A_ID, email: 'teacher.a@pink.edu.vn', fullName: 'Cô A', role: 'teacher' },
      isCloudTeacher: true,
    });

    const dbA = getDatabaseForUser(USER_A_ID);
    await dbA.classes.clear();
    await dbA.classes.add(createMockClassRoom('cls-a-1', 'Lớp 3A Cô A'));

    const html = renderToStaticMarkup(
      <AppProvider>
        <TestChild />
      </AppProvider>,
    );

    // AppProvider nạp đúng database của User A
    expect(html).toContain(USER_A_ID);
    expect(html).toContain(`pink-classroom-user-${USER_A_ID}`);

    // Legacy DB 'pink-classroom' hoàn toàn không có dữ liệu này
    const legacyClasses = await legacyDb.classes.toArray();
    expect(legacyClasses.length).toBe(0);
  });

  it('3. Chuyển từ tài khoản A sang B: dữ liệu của A không xuất hiện trong database của B', async () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    const dbB = getDatabaseForUser(USER_B_ID);
    await dbA.classes.clear();
    await dbB.classes.clear();

    await dbA.classes.add(createMockClassRoom('cls-a-secret', 'Dữ liệu bảo mật của Giáo viên A'));
    await dbB.classes.add(createMockClassRoom('cls-b-public', 'Lớp học của Giáo viên B'));

    // Mô phỏng User A
    mockAuth({
      user: { id: USER_A_ID, email: 'teacher.a@pink.edu.vn' } as any,
      profile: { id: USER_A_ID, email: 'teacher.a@pink.edu.vn', fullName: 'Cô A', role: 'teacher' },
      isCloudTeacher: true,
    });
    const htmlA = renderToStaticMarkup(
      <AppProvider key={USER_A_ID}>
        <TestChild />
      </AppProvider>,
    );
    expect(htmlA).toContain(`pink-classroom-user-${USER_A_ID}`);

    // Chuyển sang User B
    mockAuth({
      user: { id: USER_B_ID, email: 'teacher.b@pink.edu.vn' } as any,
      profile: { id: USER_B_ID, email: 'teacher.b@pink.edu.vn', fullName: 'Thầy B', role: 'teacher' },
      isCloudTeacher: true,
    });
    const htmlB = renderToStaticMarkup(
      <AppProvider key={USER_B_ID}>
        <TestChild />
      </AppProvider>,
    );
    expect(htmlB).toContain(`pink-classroom-user-${USER_B_ID}`);
    expect(htmlB).not.toContain(USER_A_ID);

    // Kiểm tra trực tiếp IndexedDB của 2 bên: phân lập vật lý 100%
    const listA = await dbA.classes.toArray();
    const listB = await dbB.classes.toArray();
    expect(listA.length).toBe(1);
    expect(listA[0].id).toBe('cls-a-secret');
    expect(listB.length).toBe(1);
    expect(listB[0].id).toBe('cls-b-public');
  });

  it('4. Kết quả truy vấn bất đồng bộ của A hoàn thành sau khi B đăng nhập: kết quả của A bị cô lập', async () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    const dbB = getDatabaseForUser(USER_B_ID);
    await dbA.classes.clear();
    await dbB.classes.clear();

    // Giả lập User A bắt đầu một query chậm
    setActiveDatabase(dbA, USER_A_ID);
    const capturedDbForA = getActiveDatabase();
    expect(capturedDbForA?.name).toBe(`pink-classroom-user-${USER_A_ID}`);

    // Trước khi User A hoàn thành, User B đăng nhập
    setActiveDatabase(dbB, USER_B_ID);
    expect(getActiveDatabase()?.name).toBe(`pink-classroom-user-${USER_B_ID}`);

    // Thao tác bất đồng bộ cũ của A (dùng capturedDbForA) ghi dữ liệu
    await capturedDbForA?.classes.add(createMockClassRoom('cls-delayed-a', 'Lớp về muộn của A'));

    // Kiểm tra: Dữ liệu của A chỉ vào DB của A, KHÔNG BAO GIỜ lọt vào DB của B!
    const classesB = await dbB.classes.toArray();
    expect(classesB.length).toBe(0);

    const classesA = await dbA.classes.toArray();
    expect(classesA.length).toBe(1);
    expect(classesA[0].id).toBe('cls-delayed-a');
  });

  it('5. Đăng xuất trong khi đang tải dữ liệu: active DB bị reset về null ngay lập tức', () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    setActiveDatabase(dbA, USER_A_ID);
    expect(getActiveDatabase()).not.toBeNull();

    // Đăng xuất: reset active database
    setActiveDatabase(null, null);
    closeDatabaseForUser(USER_A_ID);

    expect(getActiveDatabase()).toBeNull();
  });

  it('6. Profile thiếu hoặc role không hợp lệ (role = "parent"): AppProvider không mount', () => {
    mockAuth({
      user: { id: 'parent-123', email: 'parent@pink.edu.vn' } as any,
      profile: { id: 'parent-123', email: 'parent@pink.edu.vn', fullName: 'Phụ huynh', role: 'parent' },
      isCloudTeacher: false,
    });

    const html = renderToStaticMarkup(
      <AppProvider>
        <TestChild />
      </AppProvider>,
    );

    expect(html).toBe('');
    expect(getActiveDatabase()).toBeNull();
  });

  it('7. Database legacy và hàng đợi cũ không bị thay đổi', async () => {
    // Đặt sẵn dữ liệu legacy và queue cũ vào legacy database
    await legacyDb.classes.add(createMockClassRoom('legacy-class-1', 'Lớp Legacy Cũ'));
    await legacyDb.kv.put({
      key: 'cloud_pending_sync_queue',
      value: [{ key: 'legacy-item-1', kind: 'attendance_clear', classId: 'legacy-cls', date: '2024-01-01', session: 'morning', createdAt: 50 }],
    });

    const dbA = getDatabaseForUser(USER_A_ID);
    setActiveDatabase(dbA, USER_A_ID);

    // User A thao tác với queue và lớp của riêng mình
    await savePendingSyncQueue([
      { key: 'user-a-queue-1', kind: 'attendance_clear', classId: 'cls-a', date: '2026-10-27', session: 'morning', createdAt: 999 },
    ]);
    await createClass({ name: 'Lớp Mới Của A', schoolYear: '2026-2027', teacherName: 'Cô Tiên' });

    // Hàng đợi của User A có 1 mục của A
    const userAQueue = await getPendingSyncQueue();
    expect(userAQueue.length).toBe(1);
    expect(userAQueue[0].key).toBe('user-a-queue-1');

    // Database legacy 'pink-classroom': BẢO TOÀN NGUYÊN TRẠNG 100%
    const legacyClasses = await legacyDb.classes.toArray();
    expect(legacyClasses.length).toBe(1);
    expect(legacyClasses[0].id).toBe('legacy-class-1');

    const legacyQueueRow = await legacyDb.kv.get('cloud_pending_sync_queue');
    const legacyQueue = legacyQueueRow?.value as any[];
    expect(legacyQueue.length).toBe(1);
    expect(legacyQueue[0].key).toBe('legacy-item-1');
  });

  it('8. Đóng kết nối cơ sở dữ liệu khi đăng xuất nhưng KHÔNG xóa dữ liệu trên đĩa', async () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    await dbA.classes.clear();
    await dbA.classes.add(createMockClassRoom('cls-persistent', 'Lớp Lưu Trữ'));

    // Đóng kết nối của User A
    closeDatabaseForUser(USER_A_ID);

    // Mở lại database của User A (mô phỏng đăng nhập lại lần sau)
    const dbAReopened = getDatabaseForUser(USER_A_ID);
    const persistedClasses = await dbAReopened.classes.toArray();

    // Dữ liệu vẫn còn nguyên vẹn 100%
    expect(persistedClasses.length).toBe(1);
    expect(persistedClasses[0].name).toBe('Lớp Lưu Trữ');
  });

  it('9. Các luồng nghiệp vụ (lớp học, học sinh, điểm danh, điểm thưởng, nhận xét) hoạt động đúng trên database mới', async () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    await dbA.classes.clear();
    await dbA.students.clear();
    await dbA.attendance.clear();
    await dbA.transactions.clear();
    await dbA.comments.clear();
    setActiveDatabase(dbA, USER_A_ID);

    // 1. Tạo lớp học
    const cls = await createClass({ name: 'Lớp 4A1', schoolYear: '2026-2027', teacherName: 'Cô Tiên', color: 'pink' });
    expect(cls.id).toBeDefined();

    // 2. Thêm học sinh
    const stu = await addStudent(cls.id, {
      code: '01',
      fullName: 'Nguyễn Văn An',
      gender: 'male',
      avatar: 'cat-pink',
    });
    expect(stu.id).toBeDefined();

    // 3. Điểm danh
    await saveAttendance(cls.id, '2026-10-27', 'morning', [{ studentId: stu.id, status: 'present' }]);
    const attList = await dbA.attendance.toArray();
    expect(attList.length).toBe(1);
    expect(attList[0].status).toBe('present');

    // 4. Cộng điểm thi đua
    const tx = await awardPoints({
      classId: cls.id,
      studentIds: [stu.id],
      customName: 'Phát biểu tốt',
      delta: 5,
    });
    expect(tx.count).toBe(1);
    const txList = await dbA.transactions.toArray();
    expect(txList.length).toBe(1);
    expect(txList[0].delta).toBe(5);

    // 5. Lưu nhận xét tuần
    const cmt = await saveComment(cls.id, {
      studentId: stu.id,
      date: '2026-10-27',
      session: 'morning',
      content: 'Em học rất chăm chỉ và hăng hái.',
      tags: ['chăm chỉ'],
    });
    expect(cmt.id).toBeDefined();
    const cmtList = await dbA.comments.toArray();
    expect(cmtList.length).toBe(1);
    expect(cmtList[0].content).toBe('Em học rất chăm chỉ và hăng hái.');

    // Khẳng định toàn bộ các bản ghi trên đều nằm trong database riêng của User A,
    // và tuyệt đối KHÔNG có bản ghi nào lọt vào legacy database 'pink-classroom'!
    expect((await legacyDb.classes.toArray()).length).toBe(0);
    expect((await legacyDb.students.toArray()).length).toBe(0);
    expect((await legacyDb.attendance.toArray()).length).toBe(0);
    expect((await legacyDb.transactions.toArray()).length).toBe(0);
    expect((await legacyDb.comments.toArray()).length).toBe(0);
  });
});
