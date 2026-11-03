import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => {
  return {
    isSupabaseConfigured: true,
    checkSupabaseConnection: vi.fn(),
    supabase: null,
  };
});

import {
  clearUserDatabaseRegistry,
  db as legacyDb,
  getDatabaseForUser,
} from '../data/db';
import {
  setActiveDatabase,
  createClass,
  updateClass,
  addStudent,
  updateStudent,
  archiveStudents,
  restoreStudents,
  suggestNextCode,
  awardPoints,
  saveAttendance,
  clearAttendance,
  saveComment,
  getOrCreateParentLink,
  revokeParentInvitationToken,
  undoTransaction,
  undoBatch,
  saveSettings,
  exportBackup,
  importBackup,
  wipeAll,
  saveGamePick,
  clearGamePicks,
  getPendingSyncQueue,
  savePendingSyncQueue,
  flushPendingSyncQueue,
  bulkAddStudents,
  type PendingSyncItem,
} from '../data/repo';
import * as XLSX from 'xlsx';
import { parseStudentFile } from '../lib/excel';
import { pickRandom } from '../lib/picker';
import type { AppSettings } from '../types';

describe('TIENCLASS — BỘ KIỂM THỬ TỔNG THỂ TRƯỚC KHI BÀN GIAO (9 CHUYÊN ĐỀ)', () => {
  const TEACHER_A_ID = 'teacher-handover-a-1111';
  const TEACHER_B_ID = 'teacher-handover-b-2222';
  const teacherDbA = getDatabaseForUser(TEACHER_A_ID);
  const teacherDbB = getDatabaseForUser(TEACHER_B_ID);

  beforeEach(async () => {
    vi.restoreAllMocks();
    clearUserDatabaseRegistry();
    setActiveDatabase(teacherDbA, TEACHER_A_ID);

    await Promise.all([
      teacherDbA.classes.clear(),
      teacherDbA.students.clear(),
      teacherDbA.criteria.clear(),
      teacherDbA.transactions.clear(),
      teacherDbA.attendance.clear(),
      teacherDbA.comments.clear(),
      teacherDbA.parentLinks.clear(),
      teacherDbA.gamePicks.clear(),
      teacherDbA.kv.clear(),
      teacherDbB.classes.clear(),
      teacherDbB.students.clear(),
      teacherDbB.criteria.clear(),
      teacherDbB.transactions.clear(),
      teacherDbB.attendance.clear(),
      teacherDbB.comments.clear(),
      teacherDbB.parentLinks.clear(),
      teacherDbB.gamePicks.clear(),
      teacherDbB.kv.clear(),
      legacyDb.classes.clear(),
      legacyDb.students.clear(),
    ]);
  });

  afterEach(() => {
    setActiveDatabase(null, null);
  });

  /* -------------------------------------------------------------------------
   * MỤC 1: ĐĂNG NHẬP, ĐĂNG XUẤT VÀ ĐĂNG NHẬP LẠI (PHIÊN VÀ CÁCH LY CSDL)
   * ------------------------------------------------------------------------- */
  describe('1. Đăng nhập, đăng xuất và phân quyền phiên', () => {
    it('1.1. Giáo viên A đăng nhập, tạo dữ liệu, đăng xuất và đăng nhập lại vẫn toàn vẹn', async () => {
      // Đăng nhập A
      setActiveDatabase(teacherDbA, TEACHER_A_ID);
      const cls = await createClass({
        name: 'Lớp 5A - Năm 2026',
        schoolYear: '2026-2027',
        teacherName: 'Cô Nguyễn Thị Hoa',
        color: '#F7A8C4',
      }, teacherDbA);

      await addStudent(cls.id, {
        code: 'HS0001',
        fullName: 'Nguyễn Văn An',
        gender: 'male',
        avatar: 'bunny-pink',
      }, teacherDbA);

      // Đăng xuất: clear active session
      setActiveDatabase(null, null);

      // Đăng nhập lại giáo viên A
      const reconnectedDbA = getDatabaseForUser(TEACHER_A_ID);
      setActiveDatabase(reconnectedDbA, TEACHER_A_ID);

      const classesA = await reconnectedDbA.classes.toArray();
      const studentsA = await reconnectedDbA.students.toArray();

      expect(classesA).toHaveLength(1);
      expect(classesA[0].name).toBe('Lớp 5A - Năm 2026');
      expect(studentsA).toHaveLength(1);
      expect(studentsA[0].fullName).toBe('Nguyễn Văn An');
    });

    it('1.2. Chuyển đổi tài khoản giữa Giáo viên A và B: Cách ly hoàn toàn', async () => {
      // Giáo viên A tạo lớp
      setActiveDatabase(teacherDbA, TEACHER_A_ID);
      await createClass({
        name: 'Lớp Của A',
        schoolYear: '2026-2027',
        teacherName: 'Giáo viên A',
      }, teacherDbA);

      // Chuyển sang Giáo viên B
      setActiveDatabase(teacherDbB, TEACHER_B_ID);
      const classesBBefore = await teacherDbB.classes.toArray();
      expect(classesBBefore).toHaveLength(0); // B không nhìn thấy lớp của A

      await createClass({
        name: 'Lớp Của B',
        schoolYear: '2026-2027',
        teacherName: 'Giáo viên B',
      }, teacherDbB);

      // Trở lại Giáo viên A
      setActiveDatabase(teacherDbA, TEACHER_A_ID);
      const classesA = await teacherDbA.classes.toArray();
      expect(classesA).toHaveLength(1);
      expect(classesA[0].name).toBe('Lớp Của A');
    });
  });

  /* -------------------------------------------------------------------------
   * MỤC 2: TẠO, SỬA, XEM VÀ LƯU LỚP HỌC, HỒ SƠ HỌC SINH
   * ------------------------------------------------------------------------- */
  describe('2. Quản lý lớp học và hồ sơ học sinh', () => {
    it('2.1. Tạo lớp, tự sinh 6 tiêu chí mặc định, chặn trùng tên', async () => {
      const cls = await createClass({
        name: 'Lớp 3A',
        schoolYear: '2026-2027',
        teacherName: 'Cô Lan',
        color: '#BFF3E8',
        subject: 'Toán học',
      }, teacherDbA);

      expect(cls.id).toBeDefined();
      const criteria = await teacherDbA.criteria.where('classId').equals(cls.id).toArray();
      expect(criteria).toHaveLength(6);

      // Cập nhật lớp
      await updateClass(cls.id, {
        name: 'Lớp 3A Nâng Cao',
        schoolYear: '2026-2027',
        teacherName: 'Cô Lan Phương',
        color: '#FFE2AA',
      }, teacherDbA);

      const updated = await teacherDbA.classes.get(cls.id);
      expect(updated?.name).toBe('Lớp 3A Nâng Cao');
      expect(updated?.color).toBe('#FFE2AA');

      // Chặn tạo lớp trùng tên cùng năm học
      await expect(
        createClass({
          name: 'Lớp 3A Nâng Cao',
          schoolYear: '2026-2027',
          teacherName: 'Thầy Khác',
        }, teacherDbA),
      ).rejects.toThrow(/Đã có lớp cùng tên/);
    });

    it('2.2. Thêm học sinh, cập nhật, lưu trữ (Archive) và phục hồi (Restore)', async () => {
      const cls = await createClass({
        name: 'Lớp 1B',
        schoolYear: '2026-2027',
        teacherName: 'Thầy Hưng',
      }, teacherDbA);

      const code = await suggestNextCode(teacherDbA);
      expect(code).toBe('HS0001');

      const stu = await addStudent(cls.id, {
        code,
        fullName: 'Lê Hoàng Nam',
        birthDate: '2019-03-20',
        gender: 'male',
        avatar: 'bunny-pink',
        parentName: 'Lê Văn Chính',
        parentPhone: '0912345678',
        note: 'Tiếp thu tốt',
      }, teacherDbA);

      expect(stu.status).toBe('active');

      // Chỉnh sửa hồ sơ
      await updateStudent(stu.id, {
        code: 'HS0001',
        fullName: 'Lê Hoàng Nam (Lớp Phó)',
        parentPhone: '0988776655',
        avatar: 'cat-pink',
        gender: 'male',
      }, teacherDbA);

      const reloaded = await teacherDbA.students.get(stu.id);
      expect(reloaded?.fullName).toBe('Lê Hoàng Nam (Lớp Phó)');
      expect(reloaded?.parentPhone).toBe('0988776655');

      // Lưu trữ học sinh
      await archiveStudents([stu.id], teacherDbA);
      const archived = await teacherDbA.students.get(stu.id);
      expect(archived?.status).toBe('archived');

      // Khôi phục học sinh
      await restoreStudents([stu.id], teacherDbA);
      const restored = await teacherDbA.students.get(stu.id);
      expect(restored?.status).toBe('active');
    });

    it('2.3. Nhập học sinh bằng file Excel (xử lý thiếu dữ liệu, mã trùng và lưu vào CSDL)', async () => {
      const cls = await createClass({ name: 'Lớp 1C Excel', schoolYear: '2026-2027', teacherName: 'Thầy Hưng' }, teacherDbA);

      // Thêm trước 1 học sinh với mã HS0001
      await addStudent(cls.id, {
        code: 'HS0001',
        fullName: 'Học Sinh Đã Có',
        gender: 'male',
        avatar: 'bunny-pink',
      }, teacherDbA);

      // Tạo workbook mô phỏng file Excel tải lên
      const wb = XLSX.utils.book_new();
      const rows = [
        ['Mã học sinh', 'Họ và tên', 'Ngày sinh', 'Giới tính', 'Họ tên phụ huynh', 'SĐT phụ huynh', 'Ghi chú'],
        ['HS0001', 'Nguyễn Trùng Mã Hệ Thống', '15/03/2019', 'Nam', 'Ba An', '0901234567', ''], // Lỗi: mã trùng hệ thống
        ['HS0002', 'Trần Văn Hai', '2019-08-20', 'Nam', 'Ba Hai', '0902222222', ''], // Hợp lệ
        ['HS0002', 'Lê Thị Trùng Trong File', '2019-05-10', 'Nữ', 'Mẹ Ba', '0903333333', ''], // Lỗi: trùng mã với dòng trên
        ['HS0004', 'Vũ Thị Không Tên Số 123', '2019-01-01', 'Nữ', '', '', ''], // Lỗi: họ tên chứa số
        ['', 'Hoàng Minh Tự Động Mã', '2019-12-12', 'Nam', 'Mẹ Hoàng', '0904444444', ''], // Hợp lệ: tự sinh mã
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'DanhSach');
      const u8 = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      const file = new File([u8], 'test_students.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const existingCodes = new Set(['HS0001']);
      const parseResult = await parseStudentFile(file, existingCodes, [], 2);

      // Tổng cộng 5 dòng dữ liệu
      expect(parseResult.rows).toHaveLength(5);

      // Dòng 1: Lỗi trùng mã hệ thống
      expect(parseResult.rows[0].errors.some((e) => e.includes('đã tồn tại trong hệ thống'))).toBe(true);

      // Dòng 2: Hợp lệ
      expect(parseResult.rows[1].errors).toHaveLength(0);
      expect(parseResult.rows[1].input.code).toBe('HS0002');

      // Dòng 3: Lỗi trùng mã trong file
      expect(parseResult.rows[2].errors.some((e) => e.includes('bị trùng với dòng'))).toBe(true);

      // Dòng 4: Lỗi họ tên chứa số
      expect(parseResult.rows[3].errors.some((e) => e.includes('Họ tên không chứa số'))).toBe(true);

      // Dòng 5: Tự sinh mã
      expect(parseResult.rows[4].errors).toHaveLength(0);
      expect(parseResult.rows[4].autoCode).toBe(true);
      expect(parseResult.rows[4].input.code).toMatch(/^HS\d{4}$/);

      // Lọc các dòng hợp lệ và thực hiện bulkAddStudents
      const validRows = parseResult.rows.filter((r) => r.errors.length === 0);
      expect(validRows).toHaveLength(2); // Dòng 2 (HS0002) và Dòng 5 (tự sinh mã)

      const addedCount = await bulkAddStudents(cls.id, validRows.map((r) => r.input), teacherDbA);
      expect(addedCount).toBe(2);

      // Kiểm tra lưu bền vững trong CSDL
      const allStudentsInDb = await teacherDbA.students.where('classId').equals(cls.id).toArray();
      expect(allStudentsInDb).toHaveLength(3); // 1 có sẵn + 2 mới thêm
      expect(allStudentsInDb.some((s) => s.fullName === 'Trần Văn Hai')).toBe(true);
      expect(allStudentsInDb.some((s) => s.fullName === 'Hoàng Minh Tự Động Mã')).toBe(true);

      // Chặn nhập đè khi mã đã tồn tại
      await expect(
        bulkAddStudents(cls.id, [{
          code: 'HS0002',
          fullName: 'Người Thử Trùng Lặp',
          gender: 'male',
          avatar: 'cat-pink',
        }], teacherDbA),
      ).rejects.toThrow(/đã tồn tại/);
    });
  });

  /* -------------------------------------------------------------------------
   * MỤC 3: ĐIỂM DANH, THI ĐUA, CỘNG/TRỪ ĐIỂM VÀ HOÀN TÁC (UNDO / REDO)
   * ------------------------------------------------------------------------- */
  describe('3. Điểm danh, Chấm điểm thi đua và Hoàn tác', () => {
    it('3.1. Điểm danh sáng/chiều, ghi chú vắng/muộn và xóa điểm danh', async () => {
      const cls = await createClass({ name: 'Lớp 4C', schoolYear: '2026-2027', teacherName: 'Cô My' }, teacherDbA);
      const stu1 = await addStudent(cls.id, { code: 'HS0001', fullName: 'Đặng Tuấn Anh', gender: 'male', avatar: 'cat-pink' }, teacherDbA);
      const stu2 = await addStudent(cls.id, { code: 'HS0002', fullName: 'Bùi Lan Chi', gender: 'female', avatar: 'bunny-pink' }, teacherDbA);

      const date = '2026-10-29';
      await saveAttendance(cls.id, date, 'morning', [
        { studentId: stu1.id, status: 'present' },
        { studentId: stu2.id, status: 'excused', note: 'Gia đình xin phép đi khám bệnh' },
      ], teacherDbA);

      const attList = await teacherDbA.attendance.where('classId').equals(cls.id).toArray();
      expect(attList).toHaveLength(2);
      const chiAtt = attList.find((a) => a.studentId === stu2.id);
      expect(chiAtt?.status).toBe('excused');
      expect(chiAtt?.note).toContain('khám bệnh');

      // Xóa điểm danh
      await clearAttendance(cls.id, date, 'morning', teacherDbA);
      const attAfter = await teacherDbA.attendance.where('classId').equals(cls.id).toArray();
      expect(attAfter).toHaveLength(0);
    });

    it('3.2. Chấm điểm cộng/trừ, đơn lẻ và hàng loạt; Hoàn tác giao dịch (Undo)', async () => {
      const cls = await createClass({ name: 'Lớp 2A', schoolYear: '2026-2027', teacherName: 'Thầy Bình' }, teacherDbA);
      const stu1 = await addStudent(cls.id, { code: 'HS0001', fullName: 'Trần Bình An', gender: 'male', avatar: 'bunny-pink' }, teacherDbA);
      const stu2 = await addStudent(cls.id, { code: 'HS0002', fullName: 'Ngô Thảo Nguyên', gender: 'female', avatar: 'cat-pink' }, teacherDbA);

      const criteria = await teacherDbA.criteria.where('classId').equals(cls.id).toArray();
      const posCrit = criteria.find((c) => c.points > 0)!;

      // Cộng điểm đồng loạt cho 2 học sinh
      await awardPoints({
        classId: cls.id,
        studentIds: [stu1.id, stu2.id],
        criterion: posCrit,
        note: 'Làm bài tập xuất sắc',
      }, teacherDbA);

      const txs = await teacherDbA.transactions.where('classId').equals(cls.id).toArray();
      expect(txs).toHaveLength(2);
      expect(Boolean(txs[0].undone)).toBe(false);

      const batchId = txs[0].batchId;

      // Hoàn tác 1 giao dịch
      await undoTransaction(txs[0].id, teacherDbA);
      const tx0After = await teacherDbA.transactions.get(txs[0].id);
      expect(tx0After?.undone).toBe(true);
      expect(tx0After?.undoneAt).toBeDefined();

      // Hoàn tác cả mẻ (Batch Undo)
      if (batchId) {
        await undoBatch(batchId, teacherDbA);
        const tx1After = await teacherDbA.transactions.get(txs[1].id);
        expect(tx1After?.undone).toBe(true);
      }
    });
  });

  /* -------------------------------------------------------------------------
   * MỤC 4: NHẬN XÉT HỌC SINH (BẢN NHÁP VÀ PHÁT HÀNH BẤT BIẾN)
   * ------------------------------------------------------------------------- */
  describe('4. Nhận xét tuần: Bản nháp & Phát hành', () => {
    it('4.1. Tạo bản nháp, phát hành nhận xét và chặn đảo ngược về trạng thái nháp', async () => {
      const cls = await createClass({ name: 'Lớp 5B', schoolYear: '2026-2027', teacherName: 'Cô Oanh' }, teacherDbA);
      const stu = await addStudent(cls.id, { code: 'HS0001', fullName: 'Hoàng Minh Quân', gender: 'male', avatar: 'cat-pink' }, teacherDbA);

      // Lưu nháp
      const draft = await saveComment(cls.id, {
        studentId: stu.id,
        date: '2026-10-29',
        session: 'morning',
        tags: ['Chăm chỉ'],
        content: 'Bản nháp nhận xét: Tuần này con có nhiều cố gắng.',
        status: 'draft',
      }, undefined, teacherDbA);

      expect(draft.status).toBe('draft');
      expect(draft.sentAt).toBeUndefined();

      // Phát hành nhận xét
      const sent = await saveComment(cls.id, {
        studentId: stu.id,
        date: '2026-10-29',
        session: 'morning',
        tags: ['Chăm chỉ', 'Tiến bộ'],
        content: 'Bản chính thức: Con rất chăm ngoan và học tập tiến bộ vượt bậc!',
        status: 'sent',
      }, draft.id, teacherDbA);

      expect(sent.status).toBe('sent');
      expect(sent.sentAt).toBeDefined();

      // Không cho phép đảo ngược về nháp
      await expect(
        saveComment(cls.id, {
          studentId: stu.id,
          date: '2026-10-29',
          session: 'morning',
          tags: [],
          content: 'Thử chuyển về nháp',
          status: 'draft',
        }, sent.id, teacherDbA),
      ).rejects.toThrow('Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.');
    });
  });

  /* -------------------------------------------------------------------------
   * MỤC 5: LIÊN KẾT PHỤ HUYNH VÀ BẢO MẬT PHÂN QUYỀN
   * ------------------------------------------------------------------------- */
  describe('5. Liên kết phụ huynh & Mã mời', () => {
    it('5.1. Tạo mã mời phụ huynh có thời hạn 30 ngày và thu hồi mã an toàn', async () => {
      const cls = await createClass({ name: 'Lớp 2C', schoolYear: '2026-2027', teacherName: 'Thầy Sơn' }, teacherDbA);
      const stu = await addStudent(cls.id, { code: 'HS0001', fullName: 'Đỗ Hải Đăng', gender: 'male', avatar: 'bunny-pink' }, teacherDbA);

      const link = await getOrCreateParentLink(cls.id, stu.id, undefined, teacherDbA);
      expect(link.token).toBeDefined();
      expect(link.token.length).toBeGreaterThan(10);
      expect(link.expiresAt).toBeGreaterThan(Date.now());
      expect(link.isRevoked).toBe(false);

      // Thu hồi mã mời
      const res = await revokeParentInvitationToken(link.id, teacherDbA);
      expect(res.ok).toBe(true);

      const updatedLink = await teacherDbA.parentLinks.get(link.id);
      expect(updatedLink?.isRevoked).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------
   * MỤC 6: MINIGAME (UFO GẮP HỌC SINH) & CÀI ĐẶT / SAO LƯU DỮ LIỆU
   * ------------------------------------------------------------------------- */
  describe('6. Minigame & Cài đặt hệ thống', () => {
    it('6.1. Minigame: Chọn ngẫu nhiên công bằng, chế độ không lặp và làm mới vòng', async () => {
      const cls = await createClass({ name: 'Lớp Game', schoolYear: '2026-2027', teacherName: 'Cô Bông' }, teacherDbA);
      const stu1 = await addStudent(cls.id, { code: 'HS0001', fullName: 'Bạn Một', gender: 'male', avatar: 'cat-pink' }, teacherDbA);
      const stu2 = await addStudent(cls.id, { code: 'HS0002', fullName: 'Bạn Hai', gender: 'female', avatar: 'bunny-pink' }, teacherDbA);

      const participants = [stu1, stu2];

      // Lượt 1: Chọn 1 bạn
      const res1 = pickRandom(participants, { noRepeat: true, alreadyPicked: [] });
      expect(res1.picked).toBeDefined();
      expect(res1.remaining).toBe(1);
      expect(res1.exhausted).toBe(false);

      // Lưu lượt chọn vào repo
      await saveGamePick(cls.id, res1.picked!, 'dog-catch', teacherDbA);
      let picks = await teacherDbA.gamePicks.where('classId').equals(cls.id).toArray();
      expect(picks).toHaveLength(1);

      // Lượt 2: Chọn bạn còn lại
      const res2 = pickRandom(participants, { noRepeat: true, alreadyPicked: [res1.picked!.id] });
      expect(res2.picked).toBeDefined();
      expect(res2.picked!.id).not.toBe(res1.picked!.id);
      expect(res2.remaining).toBe(0);

      // Lượt 3: Hết người (exhausted)
      const res3 = pickRandom(participants, { noRepeat: true, alreadyPicked: [stu1.id, stu2.id] });
      expect(res3.picked).toBeNull();
      expect(res3.exhausted).toBe(true);

      // Làm mới lịch sử game
      await clearGamePicks(cls.id, teacherDbA);
      picks = await teacherDbA.gamePicks.where('classId').equals(cls.id).toArray();
      expect(picks).toHaveLength(0);
    });

    it('6.2. Cài đặt hệ thống: Lưu tùy chọn, Xuất và Nhập bản sao lưu (Backup/Restore)', async () => {
      // 1. Lưu cài đặt
      await saveSettings({
        teacherName: 'Cô Bùi Tuyết Mai',
        teacherTitle: 'cô',
        defaultSession: 'afternoon',
        soundEnabled: false,
      }, teacherDbA);

      const settingsRow = await teacherDbA.kv.get('settings');
      const savedSettings = settingsRow?.value as AppSettings | undefined;
      expect(savedSettings?.teacherName).toBe('Cô Bùi Tuyết Mai');
      expect(savedSettings?.defaultSession).toBe('afternoon');

      // 2. Tạo một lớp dữ liệu để test backup
      const cls = await createClass({ name: 'Lớp Sao Lưu', schoolYear: '2026-2027', teacherName: 'Cô Mai' }, teacherDbA);
      await addStudent(cls.id, { code: 'HS0001', fullName: 'Học Sinh Sao Lưu', gender: 'female', avatar: 'bunny-pink' }, teacherDbA);

      // 3. Xuất file backup
      const backup = await exportBackup(teacherDbA);
      expect(backup.format).toBe('pink-classroom-backup');
      expect(backup.data.classes).toHaveLength(1);
      expect(backup.data.students).toHaveLength(1);

      // 4. Xóa sạch dữ liệu (Wipe All)
      await wipeAll(teacherDbA);
      const clsCountAfterWipe = await teacherDbA.classes.count();
      const stuCountAfterWipe = await teacherDbA.students.count();
      expect(clsCountAfterWipe).toBe(0);
      expect(stuCountAfterWipe).toBe(0);

      // 5. Khôi phục từ bản sao lưu (Import Backup)
      await importBackup(backup, teacherDbA);
      const clsCountAfterImport = await teacherDbA.classes.count();
      const stuCountAfterImport = await teacherDbA.students.count();
      expect(clsCountAfterImport).toBe(1);
      expect(stuCountAfterImport).toBe(1);
    });
  });

  /* -------------------------------------------------------------------------
   * MỤC 7: SUPABASE ↔ INDEXEDDB & HÀNG ĐỢI OFFLINE
   * ------------------------------------------------------------------------- */
  describe('7. Lưu trữ Offline & Hàng đợi đồng bộ Cloud', () => {
    it('7.1. Ghi nhận giao dịch offline vào hàng đợi và bảo toàn khi chưa có mạng', async () => {
      const offlineItem: PendingSyncItem = {
        key: 'pts:offline-101',
        kind: 'points_upsert',
        txId: 'offline-101',
        createdAt: Date.now(),
        retryCount: 0,
        status: 'pending',
      };

      await savePendingSyncQueue([offlineItem], teacherDbA);
      const queue = await getPendingSyncQueue(teacherDbA);
      expect(queue).toHaveLength(1);
      expect(queue[0].key).toBe('pts:offline-101');

      // Khi mạng chưa sẵn sàng, flush giữ nguyên hàng đợi an toàn
      const flushRes = await flushPendingSyncQueue(teacherDbA);
      expect(flushRes.remainingCount).toBe(1);
      expect(flushRes.flushedCount).toBe(0);
    });
  });
});
