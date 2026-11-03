import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

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
import {
  setActiveDatabase,
  addStudent,
  updateStudent,
  suggestNextCode,
  isCodeTaken,
  ValidationError,
} from '../../data/repo';
import { StudentFormModal } from './StudentFormModal';
import { ToastProvider } from '../../components/ToastNotification';
import type { Student } from '../../types';

describe('Kiểm thử StudentFormModal & CRUD Học sinh', () => {
  const USER_ID = 'teacher-form-modal-1111';
  const CLASS_ID = '33333333-3333-3333-3333-333333333333';
  const userDb = getDatabaseForUser(USER_ID);

  beforeEach(async () => {
    vi.restoreAllMocks();
    clearUserDatabaseRegistry();
    setActiveDatabase(userDb, USER_ID);

    await Promise.all([
      userDb.classes.clear(),
      userDb.students.clear(),
      userDb.activities.clear(),
      legacyDb.classes.clear(),
      legacyDb.students.clear(),
    ]);

    await userDb.classes.put({
      id: CLASS_ID,
      name: 'Lớp 3A',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên',
      color: '#f472b6',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterEach(() => {
    setActiveDatabase(null, null);
  });

  it('1. Tạo học sinh thành công và lưu vào đúng database người dùng', async () => {
    const student = await addStudent(
      CLASS_ID,
      {
        code: 'HS0001',
        fullName: 'Nguyễn Văn An',
        birthDate: '2018-05-10',
        gender: 'male',
        avatar: 'cat-pink',
        parentName: 'Nguyễn Văn Ba',
        parentPhone: '0912345678',
        note: 'Chăm ngoan',
      },
      userDb,
    );

    expect(student.id).toBeDefined();
    expect(student.fullName).toBe('Nguyễn Văn An');
    expect(student.code).toBe('HS0001');

    // Kiểm tra trong database người dùng
    const saved = await userDb.students.get(student.id);
    expect(saved).toBeDefined();
    expect(saved?.fullName).toBe('Nguyễn Văn An');

    // Kiểm tra legacyDb không bị ô nhiễm
    const legacyCount = await legacyDb.students.count();
    expect(legacyCount).toBe(0);
  });

  it('2. Chặn trùng mã học sinh và ném ValidationError chính xác', async () => {
    await addStudent(
      CLASS_ID,
      {
        code: 'HS0001',
        fullName: 'Học sinh Một',
        gender: 'male',
        avatar: 'cat-pink',
      },
      userDb,
    );

    const taken = await isCodeTaken('HS0001', undefined, userDb);
    expect(taken).toBe(true);

    try {
      await addStudent(
        CLASS_ID,
        {
          code: 'HS0001',
          fullName: 'Học sinh Trùng Mã',
          gender: 'female',
          avatar: 'bunny-pink',
        },
        userDb,
      );
      expect.fail('Phải ném lỗi khi trùng mã');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fields.code).toBe('Mã học sinh đã tồn tại');
    }
  });

  it('3. Cập nhật hồ sơ học sinh thành công', async () => {
    const student = await addStudent(
      CLASS_ID,
      {
        code: 'HS0001',
        fullName: 'Nguyễn Văn An',
        gender: 'male',
        avatar: 'cat-pink',
      },
      userDb,
    );

    await updateStudent(
      student.id,
      {
        code: 'HS0001',
        fullName: 'Nguyễn Văn An Đã Đổi Tên',
        gender: 'male',
        avatar: 'dog-blue',
        parentPhone: '0987654321',
      },
      userDb,
    );

    const updated = await userDb.students.get(student.id);
    expect(updated?.fullName).toBe('Nguyễn Văn An Đã Đổi Tên');
    expect(updated?.avatar).toBe('dog-blue');
    expect(updated?.parentPhone).toBe('0987654321');
  });

  it('4. suggestNextCode sinh mã tiếp theo chính xác', async () => {
    const code1 = await suggestNextCode(userDb);
    expect(code1).toBe('HS0001');

    await addStudent(
      CLASS_ID,
      {
        code: 'HS0001',
        fullName: 'Học sinh Một',
        gender: 'male',
        avatar: 'cat-pink',
      },
      userDb,
    );

    const code2 = await suggestNextCode(userDb);
    expect(code2).toBe('HS0002');
  });

  it('5. Render StudentFormModal khi mở', () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <StudentFormModal
          open={true}
          onClose={() => {}}
          classId={CLASS_ID}
          editing={null}
        />
      </ToastProvider>,
    );
    expect(html).toContain('Thêm học sinh mới');
    expect(html).toContain('Họ và tên');
    expect(html).toContain('Mã học sinh');
  });

  it('6. Render StudentFormModal ở chế độ chỉnh sửa', () => {
    const editingStudent: Student = {
      id: 'student-edit-001',
      classId: CLASS_ID,
      code: 'HS0099',
      fullName: 'Trần Thị Bích',
      gender: 'female',
      avatar: 'bunny-pink',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    };

    const html = renderToStaticMarkup(
      <ToastProvider>
        <StudentFormModal
          open={true}
          onClose={() => {}}
          classId={CLASS_ID}
          editing={editingStudent}
        />
      </ToastProvider>,
    );
    expect(html).toContain('Chỉnh sửa hồ sơ học sinh');
    expect(html).toContain('HS0099');
    expect(html).toContain('Trần Thị Bích');
  });
});
