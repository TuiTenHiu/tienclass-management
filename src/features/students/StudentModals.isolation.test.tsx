import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as XLSX from 'xlsx';

vi.mock('../../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

vi.mock('../../components/Modal', () => ({
  Modal: ({ open, title, children, footer }: any) =>
    open ? (
      <div data-testid="mock-modal">
        <h2>{title}</h2>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

import {
  clearUserDatabaseRegistry,
  db as legacyDb,
  getDatabaseForUser,
} from '../../data/db';
import { setActiveDatabase } from '../../data/repo';
import { ToastProvider } from '../../components/ToastNotification';
import { AppProvider } from '../../state/AppContext';
import * as AppContextModule from '../../state/AppContext';
import * as AuthContextModule from '../../state/AuthContext';
import type { AuthState } from '../../state/AuthContext';
import type { Student } from '../../types';
import {
  StudentProfileModal,
  queryStudentProfileData,
} from './StudentProfileModal';
import {
  ImportExcelModal,
  loadImportStudentContext,
  parseStudentFileForDatabase,
} from './ImportExcelModal';

function createExcelTestFile(rows: unknown[][]): File {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'DanhSach');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const uint8 = new Uint8Array(out);
  return {
    name: 'test_import.xlsx',
    size: uint8.byteLength,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    arrayBuffer: async () => uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength),
  } as unknown as File;
}

describe('Bước 2.3B-1: Cô lập Database cho StudentProfileModal và ImportExcelModal', () => {
  const USER_A_ID = 'teacher-modal-aaaa-1111';
  const USER_B_ID = 'teacher-modal-bbbb-2222';
  const CLASS_ID = 'class-shared-uuid-0001';
  const STUDENT_ID = 'student-shared-uuid-0001';

  const sampleStudent: Student = {
    id: STUDENT_ID,
    classId: CLASS_ID,
    code: 'HS0001',
    fullName: 'Nguyễn Minh An',
    birthDate: '2018-05-10',
    gender: 'female',
    avatar: 'cat-pink',
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    setActiveDatabase(null, null);
    clearUserDatabaseRegistry();

    await Promise.all([
      legacyDb.classes.clear(),
      legacyDb.students.clear(),
      legacyDb.transactions.clear(),
      legacyDb.attendance.clear(),
      legacyDb.comments.clear(),
    ]);

    const dbA = getDatabaseForUser(USER_A_ID);
    const dbB = getDatabaseForUser(USER_B_ID);
    await Promise.all([
      dbA.classes.clear(),
      dbA.students.clear(),
      dbA.transactions.clear(),
      dbA.attendance.clear(),
      dbA.comments.clear(),
      dbB.classes.clear(),
      dbB.students.clear(),
      dbB.transactions.clear(),
      dbB.attendance.clear(),
      dbB.comments.clear(),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setActiveDatabase(null, null);
    clearUserDatabaseRegistry();
  });

  const mockAuthForUser = (userId: string | null) => {
    const state: AuthState = {
      configured: true,
      loading: false,
      syncing: false,
      user: userId ? ({ id: userId, email: `${userId}@pink.edu.vn` } as any) : null,
      profile: userId
        ? { id: userId, email: `${userId}@pink.edu.vn`, fullName: 'Giáo viên', role: 'teacher' }
        : null,
      isCloudTeacher: Boolean(userId),
      lastSyncedAt: null,
      authError: null,
      refreshAuth: vi.fn(),
      signIn: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      syncNow: vi.fn(),
    };
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(state);
  };

  it('1. StudentProfileModal: Hồ sơ học sinh của A chỉ đọc lịch sử từ DB A, không đọc từ legacy hoặc DB B', async () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    const dbB = getDatabaseForUser(USER_B_ID);

    // Dữ liệu nhiễu trong Legacy DB ('pink-classroom')
    await legacyDb.transactions.add({
      id: 'tx-legacy-1',
      classId: CLASS_ID,
      studentId: STUDENT_ID,
      criterionId: null,
      criterionName: 'Điểm Legacy Cũ',
      delta: 999,
      actor: 'Cô Legacy',
      batchId: 'b-leg',
      createdAt: 5000,
    });
    await legacyDb.attendance.add({
      id: 'att-legacy-1',
      classId: CLASS_ID,
      studentId: STUDENT_ID,
      date: '2026-10-20',
      session: 'morning',
      status: 'unexcused',
      updatedAt: 5000,
    });
    await legacyDb.comments.add({
      id: 'cmt-legacy-1',
      classId: CLASS_ID,
      studentId: STUDENT_ID,
      date: '2026-10-20',
      session: 'morning',
      content: 'Nhận xét từ database LEGACY',
      tags: [],
      createdAt: 5000,
      updatedAt: 5000,
    });

    // Dữ liệu nhiễu trong DB của Giáo viên B
    await dbB.transactions.add({
      id: 'tx-b-1',
      classId: CLASS_ID,
      studentId: STUDENT_ID,
      criterionId: null,
      criterionName: 'Điểm của Giáo viên B',
      delta: 500,
      actor: 'Thầy B',
      batchId: 'b-b',
      createdAt: 6000,
    });
    await dbB.comments.add({
      id: 'cmt-b-1',
      classId: CLASS_ID,
      studentId: STUDENT_ID,
      date: '2026-10-21',
      session: 'morning',
      content: 'Nhận xét riêng của Giáo viên B',
      tags: [],
      createdAt: 6000,
      updatedAt: 6000,
    });

    // Dữ liệu thực của Giáo viên A
    await dbA.transactions.bulkAdd([
      {
        id: 'tx-a-1',
        classId: CLASS_ID,
        studentId: STUDENT_ID,
        criterionId: null,
        criterionName: 'Phát biểu bài tốt (A)',
        delta: 15,
        actor: 'Cô A',
        batchId: 'b-a1',
        createdAt: 7000,
      },
      {
        id: 'tx-a-2',
        classId: CLASS_ID,
        studentId: STUDENT_ID,
        criterionId: null,
        criterionName: 'Quên sách (A)',
        delta: -3,
        actor: 'Cô A',
        batchId: 'b-a2',
        createdAt: 8000,
      },
      {
        id: 'tx-a-undone',
        classId: CLASS_ID,
        studentId: STUDENT_ID,
        criterionId: null,
        criterionName: 'Cộng nhầm (đã hoàn tác)',
        delta: 50,
        actor: 'Cô A',
        batchId: 'b-a3',
        undone: true,
        createdAt: 9000,
      },
    ]);
    await dbA.attendance.bulkAdd([
      {
        id: 'att-a-1',
        classId: CLASS_ID,
        studentId: STUDENT_ID,
        date: '2026-10-25',
        session: 'morning',
        status: 'present',
        updatedAt: 7000,
      },
      {
        id: 'att-a-2',
        classId: CLASS_ID,
        studentId: STUDENT_ID,
        date: '2026-10-26',
        session: 'morning',
        status: 'excused',
        updatedAt: 8000,
      },
    ]);
    await dbA.comments.add({
      id: 'cmt-a-1',
      classId: CLASS_ID,
      studentId: STUDENT_ID,
      date: '2026-10-26',
      session: 'morning',
      content: 'Nhận xét chuẩn của Giáo viên A',
      tags: [],
      createdAt: 8000,
      updatedAt: 8000,
    });

    const summaryA = await queryStudentProfileData(dbA, sampleStudent);
    expect(summaryA).not.toBeNull();
    expect(summaryA!.points).toBe(12); // 15 - 3
    expect(summaryA!.recentTx.map((t) => t.id)).toEqual(['tx-a-2', 'tx-a-1']);
    expect(summaryA!.att.total).toBe(2);
    expect(summaryA!.att.present).toBe(1);
    expect(summaryA!.att.excused).toBe(1);
    expect(summaryA!.att.unexcused).toBe(0);
    expect(summaryA!.comments.length).toBe(1);
    expect(summaryA!.comments[0].content).toBe('Nhận xét chuẩn của Giáo viên A');

    // Khi truy vấn trên DB B: chỉ trả về dữ liệu của B
    const summaryB = await queryStudentProfileData(dbB, sampleStudent);
    expect(summaryB).not.toBeNull();
    expect(summaryB!.points).toBe(500);
    expect(summaryB!.comments[0].content).toBe('Nhận xét riêng của Giáo viên B');
  });

  it('2. ImportExcelModal: Kiểm tra mã học sinh trùng và tự sinh mã HSxxx chỉ dựa trên DB hiện hành', async () => {
    const dbA = getDatabaseForUser(USER_A_ID);
    const dbB = getDatabaseForUser(USER_B_ID);

    // Legacy DB có mã HS0050 và DUP_LEGACY
    await legacyDb.students.bulkAdd([
      {
        id: 'leg-s1',
        classId: CLASS_ID,
        code: 'HS0050',
        fullName: 'Trần Văn Legacy',
        birthDate: '2018-01-01',
        gender: 'male',
        avatar: 'cat-pink',
        status: 'active',
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 'leg-s2',
        classId: CLASS_ID,
        code: 'DUP_LEGACY',
        fullName: 'Lê Thị Cũ',
        birthDate: '2018-02-02',
        gender: 'female',
        avatar: 'cat-pink',
        status: 'active',
        createdAt: 100,
        updatedAt: 100,
      },
    ]);

    // DB B có mã HS0099 và DUP_B
    await dbB.students.bulkAdd([
      {
        id: 'b-s1',
        classId: CLASS_ID,
        code: 'HS0099',
        fullName: 'Phạm Văn B',
        birthDate: '2018-03-03',
        gender: 'male',
        avatar: 'cat-pink',
        status: 'active',
        createdAt: 200,
        updatedAt: 200,
      },
      {
        id: 'b-s2',
        classId: CLASS_ID,
        code: 'DUP_B',
        fullName: 'Hoàng Thị B',
        birthDate: '2018-04-04',
        gender: 'female',
        avatar: 'cat-pink',
        status: 'active',
        createdAt: 200,
        updatedAt: 200,
      },
    ]);

    // DB A chỉ có HS0003 và DUP_A
    await dbA.students.bulkAdd([
      {
        id: 'a-s1',
        classId: CLASS_ID,
        code: 'HS0003',
        fullName: 'Nguyễn Minh An',
        birthDate: '2018-05-10',
        gender: 'female',
        avatar: 'cat-pink',
        status: 'active',
        createdAt: 300,
        updatedAt: 300,
      },
      {
        id: 'a-s2',
        classId: CLASS_ID,
        code: 'DUP_A',
        fullName: 'Đỗ Hoàng Nam',
        birthDate: '2018-06-15',
        gender: 'male',
        avatar: 'cat-pink',
        status: 'active',
        createdAt: 300,
        updatedAt: 300,
      },
    ]);

    // Tạo file Excel kiểm thử gồm 4 dòng:
    // Dòng 1: dùng mã DUP_A -> Phải báo lỗi trùng trên DB A
    // Dòng 2: dùng mã DUP_LEGACY (chỉ có ở legacy) -> Phải hợp lệ trên DB A
    // Dòng 3: dùng mã DUP_B (chỉ có ở DB B) -> Phải hợp lệ trên DB A
    // Dòng 4: để trống mã HS -> Phải tự sinh HS0004 (tiếp theo HS0003 của A), không phải HS0051 hay HS0100
    const file = createExcelTestFile([
      ['Mã học sinh', 'Họ và tên', 'Ngày sinh', 'Giới tính'],
      ['DUP_A', 'Học Sinh Trùng A', '12/05/2018', 'Nam'],
      ['DUP_LEGACY', 'Trần Văn Legacy', '01/01/2018', 'Nam'],
      ['DUP_B', 'Phạm Văn B', '03/03/2018', 'Nam'],
      ['', 'Học Sinh Tự Sinh Mã', '20/07/2018', 'Nữ'],
    ]);

    const resultA = await parseStudentFileForDatabase(dbA, file, CLASS_ID);
    expect(resultA.fileError).toBeUndefined();
    expect(resultA.rows.length).toBe(4);

    // Dòng 1: DUP_A bị lỗi trùng mã trên DB A
    expect(resultA.rows[0].input.code).toBe('DUP_A');
    expect(resultA.rows[0].errors).toContain('Mã DUP_A đã tồn tại trong hệ thống');

    // Dòng 2: DUP_LEGACY hợp lệ hoàn toàn trên DB A và không cảnh báo trùng họ tên ngày sinh từ legacy
    expect(resultA.rows[1].input.code).toBe('DUP_LEGACY');
    expect(resultA.rows[1].errors).toEqual([]);
    expect(resultA.rows[1].warnings).toEqual([]);

    // Dòng 3: DUP_B hợp lệ hoàn toàn trên DB A và không cảnh báo trùng họ tên ngày sinh từ DB B
    expect(resultA.rows[2].input.code).toBe('DUP_B');
    expect(resultA.rows[2].errors).toEqual([]);
    expect(resultA.rows[2].warnings).toEqual([]);

    // Dòng 4: Tự sinh mã HS0004 dựa trên max của DB A (HS0003)
    expect(resultA.rows[3].autoCode).toBe(true);
    expect(resultA.rows[3].input.code).toBe('HS0004');
    expect(resultA.rows[3].errors).toEqual([]);
  });

  it('3. Context chưa sẵn sàng hoặc truyền nhầm legacy DB: Không bao giờ fallback hay chạm vào legacy DB', async () => {
    const spyLegacyTx = vi.spyOn(legacyDb.transactions, 'where');
    const spyLegacyAtt = vi.spyOn(legacyDb.attendance, 'where');
    const spyLegacyCmt = vi.spyOn(legacyDb.comments, 'where');
    const spyLegacyStu = vi.spyOn(legacyDb.students, 'toArray');

    // 3.1. queryStudentProfileData với null / undefined / legacyDb
    expect(await queryStudentProfileData(null, sampleStudent)).toBeNull();
    expect(await queryStudentProfileData(undefined, sampleStudent)).toBeNull();
    expect(await queryStudentProfileData(legacyDb, sampleStudent)).toBeNull();

    // 3.2. loadImportStudentContext với null / undefined / legacyDb phải từ chối
    await expect(loadImportStudentContext(null, CLASS_ID)).rejects.toThrow(/chưa sẵn sàng/);
    await expect(loadImportStudentContext(undefined, CLASS_ID)).rejects.toThrow(/chưa sẵn sàng/);
    await expect(loadImportStudentContext(legacyDb, CLASS_ID)).rejects.toThrow(/chưa sẵn sàng|không hợp lệ/);

    // 3.3. Render trực tiếp các modal khi thiếu AppProvider (context chưa sẵn sàng)
    const htmlProfileWithoutProvider = renderToStaticMarkup(
      <ToastProvider>
        <StudentProfileModal
          student={sampleStudent}
          onClose={() => {}}
          onEdit={() => {}}
          className="3A"
        />
      </ToastProvider>,
    );
    expect(htmlProfileWithoutProvider).toContain('Nguyễn Minh An');

    const htmlImportWithoutProvider = renderToStaticMarkup(
      <ToastProvider>
        <ImportExcelModal
          open={true}
          onClose={() => {}}
          classId={CLASS_ID}
          className="3A"
        />
      </ToastProvider>,
    );
    expect(htmlImportWithoutProvider).toContain('Nhập danh sách từ Excel');

    // 3.4. Render khi useApp trả về db = legacyDb (phòng vệ chiều sâu)
    vi.spyOn(AppContextModule, 'useApp').mockReturnValue({
      ready: false,
      classes: [],
      currentClass: null,
      setCurrentClassId: vi.fn(),
      settings: {} as any,
      teacherCall: 'cô Tiên',
      db: legacyDb,
      userId: 'invalid',
    });

    renderToStaticMarkup(
      <ToastProvider>
        <StudentProfileModal
          student={sampleStudent}
          onClose={() => {}}
          onEdit={() => {}}
          className="3A"
        />
      </ToastProvider>,
    );

    // Khẳng định không có bất kỳ lời gọi nào chạm vào các bảng của legacyDb
    expect(spyLegacyTx).not.toHaveBeenCalled();
    expect(spyLegacyAtt).not.toHaveBeenCalled();
    expect(spyLegacyCmt).not.toHaveBeenCalled();
    expect(spyLegacyStu).not.toHaveBeenCalled();
  });

  it('4. Khi chưa xác thực (user = null): AppProvider chặn render các modal con', () => {
    mockAuthForUser(null);

    const html = renderToStaticMarkup(
      <AppProvider>
        <ToastProvider>
          <StudentProfileModal
            student={sampleStudent}
            onClose={() => {}}
            onEdit={() => {}}
            className="3A"
          />
          <ImportExcelModal
            open={true}
            onClose={() => {}}
            classId={CLASS_ID}
            className="3A"
          />
        </ToastProvider>
      </AppProvider>,
    );

    expect(html).toBe('');
  });
});
