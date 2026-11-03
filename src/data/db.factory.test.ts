import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  getDatabaseForUser,
  getUserDatabaseName,
  validateAndSanitizeUserId,
  closeDatabaseForUser,
  clearUserDatabaseRegistry,
  LEGACY_DB_NAME,
  USER_DB_PREFIX,
  db as legacyDb,
} from './db';
import type { ClassRoom } from '../types';

describe('Bước 2.1: Database Factory per Account Tests', () => {
  beforeEach(() => {
    clearUserDatabaseRegistry();
  });

  it('1. validateAndSanitizeUserId: Chấp nhận ID hợp lệ và từ chối các định dạng không an toàn', () => {
    // UUID hợp lệ
    expect(validateAndSanitizeUserId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
    // Chuỗi định danh an toàn
    expect(validateAndSanitizeUserId('teacher_123')).toBe('teacher_123');
    expect(validateAndSanitizeUserId('user-a')).toBe('user-a');

    // Từ chối chuỗi rỗng / whitespace
    expect(() => validateAndSanitizeUserId('')).toThrowError(/Thiếu định danh/);
    expect(() => validateAndSanitizeUserId('   ')).toThrowError(/Thiếu định danh/);
    expect(() => validateAndSanitizeUserId(null as any)).toThrowError(/phải là chuỗi/);

    // Từ chối email (chứa @ hoặc dấu chấm)
    expect(() => validateAndSanitizeUserId('teacher@pink.edu.vn')).toThrowError(/Không được sử dụng email/);
    expect(() => validateAndSanitizeUserId('user.name')).toThrowError(/Không được sử dụng email/);

    // Từ chối tên legacy database
    expect(() => validateAndSanitizeUserId(LEGACY_DB_NAME)).toThrowError(/dành riêng của hệ thống/);

    // Từ chối ký tự đặc biệt nguy hiểm hoặc quá ngắn
    expect(() => validateAndSanitizeUserId('a')).toThrowError(/độ dài 3-128/);
    expect(() => validateAndSanitizeUserId('user$name!')).toThrowError(/chỉ được chứa chữ cái/);
  });

  it('2. getUserDatabaseName: Luôn có prefix riêng và không bao giờ trùng tên database legacy', () => {
    const nameA = getUserDatabaseName('teacher-a');
    expect(nameA).toBe(`${USER_DB_PREFIX}teacher-a`);
    expect(nameA).not.toBe(LEGACY_DB_NAME);
  });

  it('3. User A và User B được cấp hai database Dexie hoàn toàn khác nhau', () => {
    const dbA = getDatabaseForUser('teacher-a');
    const dbB = getDatabaseForUser('teacher-b');

    expect(dbA.name).toBe(`${USER_DB_PREFIX}teacher-a`);
    expect(dbB.name).toBe(`${USER_DB_PREFIX}teacher-b`);
    expect(dbA).not.toBe(dbB);
    expect(dbA.name).not.toBe(dbB.name);
  });

  it('4. Tái sử dụng cùng instance cho cùng một user ID trong cùng runtime', () => {
    const db1 = getDatabaseForUser('teacher-a');
    const db2 = getDatabaseForUser('teacher-a');

    expect(db1).toBe(db2);
    expect(db1.name).toBe(db2.name);
  });

  it('5. Cô lập dữ liệu vật lý: Ghi dữ liệu vào Database A không làm xuất hiện trong Database B', async () => {
    const dbA = getDatabaseForUser('teacher-isolated-a');
    const dbB = getDatabaseForUser('teacher-isolated-b');

    const sampleClassA: ClassRoom = {
      id: 'class-a-1',
      name: 'Lớp 1A của Cô Tiên',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Ghi lớp học vào database của Giáo viên A
    await dbA.classes.put(sampleClassA);

    // Kiểm tra database A có lớp học
    const classesInA = await dbA.classes.toArray();
    expect(classesInA).toHaveLength(1);
    expect(classesInA[0].id).toBe('class-a-1');

    // Kiểm tra database B: hoàn toàn rỗng, không hề có lớp của A!
    const classesInB = await dbB.classes.toArray();
    expect(classesInB).toHaveLength(0);

    // Ghi lớp học của Giáo viên B vào database B
    const sampleClassB: ClassRoom = {
      id: 'class-b-1',
      name: 'Lớp 2B của Thầy Nam',
      schoolYear: '2026-2027',
      teacherName: 'Thầy Nam',
      color: '#A8D8F7',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await dbB.classes.put(sampleClassB);

    // Kiểm tra hai bên độc lập
    expect(await dbA.classes.toArray()).toHaveLength(1);
    expect(await dbB.classes.toArray()).toHaveLength(1);
    expect((await dbA.classes.get('class-a-1'))?.name).toBe('Lớp 1A của Cô Tiên');
    expect((await dbB.classes.get('class-a-1'))).toBeUndefined();
    expect((await dbB.classes.get('class-b-1'))?.name).toBe('Lớp 2B của Thầy Nam');
    expect((await dbA.classes.get('class-b-1'))).toBeUndefined();
  });

  it('6. Database legacy "pink-classroom" vẫn nguyên trạng, không bị ghi đè', async () => {
    // Đảm bảo legacyDb có tên chuẩn 'pink-classroom'
    expect(legacyDb.name).toBe(LEGACY_DB_NAME);

    const dbA = getDatabaseForUser('teacher-fresh-a');
    await dbA.classes.put({
      id: 'class-in-user-db',
      name: 'Lớp trong User DB',
      schoolYear: '2026-2027',
      teacherName: 'Cô Tiên',
      color: '#F7A8C4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Database legacy không có bản ghi của dbA
    const inLegacy = await legacyDb.classes.get('class-in-user-db');
    expect(inLegacy).toBeUndefined();
  });

  it('7. closeDatabaseForUser: Đóng và dọn dẹp kết nối khỏi registry', () => {
    const dbA = getDatabaseForUser('teacher-to-close');
    expect(dbA).toBeDefined();

    closeDatabaseForUser('teacher-to-close');

    // Khi gọi lại sau khi đã đóng, registry sẽ cấp một instance mới
    const dbANew = getDatabaseForUser('teacher-to-close');
    expect(dbANew).toBeDefined();
    expect(dbANew.name).toBe(`${USER_DB_PREFIX}teacher-to-close`);
  });
});
