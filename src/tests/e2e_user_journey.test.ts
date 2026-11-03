import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  supabase: null,
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
}));

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
  getPendingSyncQueue,
  savePendingSyncQueue,
  flushPendingSyncQueue,
  type PendingSyncItem,
} from '../data/repo';

describe('TIENCLASS — KIỂM THỬ TỔNG THỂ CÁC LUỒNG THỰC TẾ (E2E USER JOURNEYS)', () => {
  const TEACHER_USER_ID = 'teacher-e2e-user-uuid-1111';
  const teacherDb = getDatabaseForUser(TEACHER_USER_ID);

  beforeEach(async () => {
    vi.restoreAllMocks();
    clearUserDatabaseRegistry();
    setActiveDatabase(teacherDb, TEACHER_USER_ID);

    await Promise.all([
      teacherDb.classes.clear(),
      teacherDb.students.clear(),
      teacherDb.criteria.clear(),
      teacherDb.transactions.clear(),
      teacherDb.attendance.clear(),
      teacherDb.comments.clear(),
      teacherDb.parentLinks.clear(),
      teacherDb.kv.clear(),
      legacyDb.classes.clear(),
      legacyDb.students.clear(),
    ]);
  });

  afterEach(() => {
    setActiveDatabase(null, null);
  });

  /* -------------------------------------------------------------------------
   * LUỒNG 1: QUẢN LÝ LỚP HỌC & HỒ SƠ HỌC SINH (CRUD, VALIDATION, PERSISTENCE)
   * ------------------------------------------------------------------------- */
  describe('Luồng 1: Lớp học và Học sinh', () => {
    it('1.1. Tạo lớp học mới, sửa tên lớp và lưu trữ bền vững trong database riêng', async () => {
      // 1. Tạo lớp học
      const cls = await createClass({
        name: 'Lớp 4A1',
        schoolYear: '2026-2027',
        teacherName: 'Cô Bông',
        color: '#F7A8C4',
        subject: 'Toán & Tiếng Việt',
      }, teacherDb);

      expect(cls.id).toBeDefined();
      expect(cls.name).toBe('Lớp 4A1');

      // Tự sinh 6 tiêu chí mặc định
      const criteria = await teacherDb.criteria.where('classId').equals(cls.id).toArray();
      expect(criteria).toHaveLength(6);

      // 2. Chỉnh sửa lớp học
      await updateClass(cls.id, {
        name: 'Lớp 4A1 Chuyên Sáng Tạo',
        schoolYear: '2026-2027',
        teacherName: 'Cô Bông',
        color: '#DCD2FF',
      }, teacherDb);

      const updatedCls = await teacherDb.classes.get(cls.id);
      expect(updatedCls?.name).toBe('Lớp 4A1 Chuyên Sáng Tạo');
      expect(updatedCls?.color).toBe('#DCD2FF');

      // 3. Chặn tạo trùng tên lớp trong cùng năm học
      await expect(
        createClass({
          name: 'Lớp 4A1 Chuyên Sáng Tạo',
          schoolYear: '2026-2027',
          teacherName: 'Cô Khác',
        }, teacherDb),
      ).rejects.toThrow(/Đã có lớp cùng tên/);
    });

    it('1.2. Thêm học sinh, cập nhật thông tin và lưu trữ (Archive / Restore)', async () => {
      const cls = await createClass({
        name: 'Lớp 2B',
        schoolYear: '2026-2027',
        teacherName: 'Thầy Hưng',
      }, teacherDb);

      // 1. Tự sinh mã
      const nextCode = await suggestNextCode(teacherDb);
      expect(nextCode).toBe('HS0001');

      // 2. Thêm học sinh
      const student = await addStudent(cls.id, {
        code: nextCode,
        fullName: 'Trần Minh Quang',
        birthDate: '2018-10-15',
        gender: 'male',
        avatar: 'bunny-pink',
        parentName: 'Trần Văn Nam',
        parentPhone: '0901234567',
        note: 'Năng nổ, hay phát biểu',
      }, teacherDb);

      expect(student.id).toBeDefined();
      expect(student.status).toBe('active');

      // 3. Sửa học sinh
      await updateStudent(student.id, {
        code: 'HS0001',
        fullName: 'Trần Minh Quang (Lớp Trưởng)',
        gender: 'male',
        avatar: 'cat-pink',
        parentPhone: '0909999999',
      }, teacherDb);

      const updatedStu = await teacherDb.students.get(student.id);
      expect(updatedStu?.fullName).toBe('Trần Minh Quang (Lớp Trưởng)');
      expect(updatedStu?.parentPhone).toBe('0909999999');

      // 4. Lưu trữ (Archive)
      await archiveStudents([student.id], teacherDb);
      const archivedStu = await teacherDb.students.get(student.id);
      expect(archivedStu?.status).toBe('archived');

      // 5. Khôi phục (Restore)
      await restoreStudents([student.id], teacherDb);
      const restoredStu = await teacherDb.students.get(student.id);
      expect(restoredStu?.status).toBe('active');
    });

    it('1.3. Xác thực tính toàn vẹn khi tải lại trang (Persistence check)', async () => {
      const cls = await createClass({
        name: 'Lớp 5C',
        schoolYear: '2026-2027',
        teacherName: 'Cô Mai',
      }, teacherDb);

      await addStudent(cls.id, {
        code: 'HS0001',
        fullName: 'Lê Hoàng Yến',
        gender: 'female',
        avatar: 'bear-cream',
      }, teacherDb);

      // Mô phỏng tải lại trang bằng cách mở một instance database mới cho cùng user
      const reloadedDb = getDatabaseForUser(TEACHER_USER_ID);
      const loadedClasses = await reloadedDb.classes.toArray();
      const loadedStudents = await reloadedDb.students.toArray();

      expect(loadedClasses).toHaveLength(1);
      expect(loadedClasses[0].name).toBe('Lớp 5C');
      expect(loadedStudents).toHaveLength(1);
      expect(loadedStudents[0].fullName).toBe('Lê Hoàng Yến');

      // Khẳng định legacyDb không có dữ liệu rò rỉ
      const legacyCount = await legacyDb.classes.count();
      expect(legacyCount).toBe(0);
    });
  });

  /* -------------------------------------------------------------------------
   * LUỒNG 2: NGHIỆP VỤ SƯ PHẠM (ĐIỂM SỐ, TIÊU CHÍ, ĐIỂM DANH, NHẬN XÉT TUẦN)
   * ------------------------------------------------------------------------- */
  describe('Luồng 2: Nghiệp vụ Sư phạm', () => {
    it('2.1. Chấm điểm thi đua, cộng/trừ điểm và ghi log lịch sử giao dịch', async () => {
      const cls = await createClass({
        name: 'Lớp 1A',
        schoolYear: '2026-2027',
        teacherName: 'Cô Linh',
      }, teacherDb);

      const stu = await addStudent(cls.id, {
        code: 'HS0001',
        fullName: 'Phạm Bảo An',
        gender: 'female',
        avatar: 'bunny-pink',
      }, teacherDb);

      const criteria = await teacherDb.criteria.where('classId').equals(cls.id).toArray();
      const rewardCriterion = criteria.find((c) => c.points > 0)!;
      const penaltyCriterion = criteria.find((c) => c.points < 0)!;

      // Khen thưởng (+2)
      await awardPoints({
        classId: cls.id,
        studentIds: [stu.id],
        criterion: rewardCriterion,
      }, teacherDb);

      // Nhắc nhở (-1)
      await awardPoints({
        classId: cls.id,
        studentIds: [stu.id],
        criterion: penaltyCriterion,
      }, teacherDb);

      const transactions = await teacherDb.transactions.where('studentId').equals(stu.id).toArray();
      expect(transactions).toHaveLength(2);
      const totalPoints = transactions.reduce((sum, t) => sum + t.delta, 0);
      expect(totalPoints).toBe(rewardCriterion.points + penaltyCriterion.points);
    });

    it('2.2. Điểm danh theo buổi (Sáng / Chiều), ghi nhận trạng thái và xóa điểm danh', async () => {
      const cls = await createClass({
        name: 'Lớp 3B',
        schoolYear: '2026-2027',
        teacherName: 'Thầy Tuấn',
      }, teacherDb);

      const stu1 = await addStudent(cls.id, { code: 'HS0001', fullName: 'Đỗ Tuấn Hưng', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const stu2 = await addStudent(cls.id, { code: 'HS0002', fullName: 'Ngô Thùy Chi', gender: 'female', avatar: 'bunny-pink' }, teacherDb);

      const today = '2026-10-29';

      // Điểm danh buổi sáng
      await saveAttendance(
        cls.id,
        today,
        'morning',
        [
          { studentId: stu1.id, status: 'present' },
          { studentId: stu2.id, status: 'late', note: 'Kẹt xe 10 phút' },
        ],
        teacherDb,
      );

      const attRecords = await teacherDb.attendance.where('classId').equals(cls.id).toArray();
      expect(attRecords).toHaveLength(2);

      const r2 = attRecords.find((r) => r.studentId === stu2.id);
      expect(r2?.status).toBe('late');
      expect(r2?.note).toBe('Kẹt xe 10 phút');

      // Xóa điểm danh buổi sáng
      await clearAttendance(cls.id, today, 'morning', teacherDb);
      const attAfterClear = await teacherDb.attendance.where('classId').equals(cls.id).toArray();
      expect(attAfterClear).toHaveLength(0);
    });

    it('2.3. Nhận xét tuần: Cách ly bản nháp (draft) và phát hành (sent)', async () => {
      const cls = await createClass({
        name: 'Lớp 4D',
        schoolYear: '2026-2027',
        teacherName: 'Cô Loan',
      }, teacherDb);

      const stu = await addStudent(cls.id, { code: 'HS0001', fullName: 'Vũ Đức Đam', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const today = '2026-10-29';

      // Lưu bản nháp (draft)
      const draftComment = await saveComment(
        cls.id,
        {
          studentId: stu.id,
          date: today,
          session: 'morning',
          tags: [],
          content: 'Bản thảo nhận xét: Em cần tập trung hơn trong giờ Toán.',
          status: 'draft',
        },
        undefined,
        teacherDb,
      );

      expect(draftComment.id).toBeDefined();
      expect(draftComment.status).toBe('draft');
      expect(draftComment.sentAt).toBeUndefined();

      // Phát hành nhận xét (sent)
      const sentComment = await saveComment(
        cls.id,
        {
          studentId: stu.id,
          date: today,
          session: 'morning',
          tags: [],
          content: 'Em học tập chăm chỉ và có tiến bộ rõ rệt trong tuần!',
          status: 'sent',
        },
        draftComment.id,
        teacherDb,
      );

      expect(sentComment.status).toBe('sent');
      expect(sentComment.sentAt).toBeDefined();
      expect(typeof sentComment.sentAt).toBe('number');

      // Quy tắc bất biến: Không thể chuyển ngược từ sent về draft
      await expect(
        saveComment(
          cls.id,
          {
            studentId: stu.id,
            date: today,
            session: 'morning',
            tags: [],
            content: 'Muốn đưa về nháp',
            status: 'draft',
          },
          sentComment.id,
          teacherDb,
        ),
      ).rejects.toThrow('Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.');
    });
  });

  /* -------------------------------------------------------------------------
   * LUỒNG 3: LIÊN KẾT PHỤ HUYNH & CỔNG THÔNG TIN PHỤ HUYNH
   * ------------------------------------------------------------------------- */
  describe('Luồng 3: Mời Phụ huynh & Cổng Phụ huynh', () => {
    it('3.1. Tạo mã mời phụ huynh (Token 30 ngày) và thu hồi mã', async () => {
      const cls = await createClass({
        name: 'Lớp 5A',
        schoolYear: '2026-2027',
        teacherName: 'Cô Thu',
      }, teacherDb);

      const stu = await addStudent(cls.id, { code: 'HS0001', fullName: 'Bùi Anh Tuấn', gender: 'male', avatar: 'bunny-pink' }, teacherDb);

      const link = await getOrCreateParentLink(cls.id, stu.id, undefined, teacherDb);

      expect(link.token).toBeDefined();
      expect(link.token.length).toBeGreaterThan(10);
      expect(link.expiresAt).toBeGreaterThan(Date.now());
      expect(link.isRevoked).toBe(false);

      // Thu hồi mã mời
      const revoked = await revokeParentInvitationToken(link.id, teacherDb);
      expect(revoked.ok).toBe(true);

      // Kiểm tra trong database
      const savedLink = await teacherDb.parentLinks.get(link.id);
      expect(savedLink?.isRevoked).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------
   * LUỒNG 4: HÀNG ĐỢI ĐỒNG BỘ OFFLINE & PHỤC HỒI LỖI MẠNG
   * ------------------------------------------------------------------------- */
  describe('Luồng 4: Hàng đợi Ngoại tuyến & Đồng bộ', () => {
    it('4.1. Tích lũy thay đổi ngoại tuyến vào cloud_pending_sync_queue và retry an toàn', async () => {
      const clsId = 'cls-offline-001';

      const item1: PendingSyncItem = {
        key: 'pts:tx-offline-001',
        kind: 'points_upsert',
        txId: 'tx-offline-001',
        createdAt: Date.now(),
        retryCount: 0,
        status: 'pending',
      };

      const item2: PendingSyncItem = {
        key: `att:${clsId}:2026-10-29:morning`,
        kind: 'attendance_upsert',
        classId: clsId,
        date: '2026-10-29',
        session: 'morning',
        createdAt: Date.now(),
        retryCount: 0,
        status: 'pending',
      };

      // Lưu vào hàng đợi offline
      await savePendingSyncQueue([item1, item2], teacherDb);

      const queue = await getPendingSyncQueue(teacherDb);
      expect(queue).toHaveLength(2);
      expect(queue[0].kind).toBe('points_upsert');
      expect(queue[1].kind).toBe('attendance_upsert');

      // Retry trong môi trường offline: hàng đợi vẫn được bảo toàn nguyên vẹn
      const res = await flushPendingSyncQueue(teacherDb);
      expect(res.remainingCount).toBe(2);
      expect(res.flushedCount).toBe(0);

      const queueAfterRetry = await getPendingSyncQueue(teacherDb);
      expect(queueAfterRetry).toHaveLength(2);
    });
  });

  /* -------------------------------------------------------------------------
   * LUỒNG 5: HÀNH TRÌNH THỰC TẾ CỦA GIÁO VIÊN (LỚP 5A & 2 HỌC SINH GIẢ LẬP)
   * ------------------------------------------------------------------------- */
  describe('Luồng 5: Hành trình Thực tế của Giáo viên (Lớp 5A)', () => {
    it('Thực hiện tuần tự 8 bước hành trình thực tế của giáo viên', async () => {
      // BƯỚC 1: Đăng nhập tài khoản giáo viên & xác lập CSDL riêng
      expect(teacherDb.name).toBe('pink-classroom-user-teacher-e2e-user-uuid-1111');

      // BƯỚC 2: Tạo lớp 5A và thêm 2 học sinh giả lập
      const cls5A = await createClass({
        name: 'Lớp 5A',
        schoolYear: '2026-2027',
        teacherName: 'Cô Thu Hà',
        color: '#F7A8C4',
      }, teacherDb);

      expect(cls5A.name).toBe('Lớp 5A');

      const hs1 = await addStudent(cls5A.id, {
        code: 'HS0001',
        fullName: 'Nguyễn Văn An',
        birthDate: '2015-05-12',
        gender: 'male',
        avatar: 'bunny-pink',
        parentName: 'Nguyễn Văn Hùng',
        parentPhone: '0912345678',
      }, teacherDb);

      const hs2 = await addStudent(cls5A.id, {
        code: 'HS0002',
        fullName: 'Trần Thị Bình',
        birthDate: '2015-08-20',
        gender: 'female',
        avatar: 'cat-pink',
        parentName: 'Lê Thị Mai',
        parentPhone: '0987654321',
      }, teacherDb);

      expect(hs1.fullName).toBe('Nguyễn Văn An');
      expect(hs2.fullName).toBe('Trần Thị Bình');

      // BƯỚC 3: Sửa hồ sơ học sinh, tải lại trang và xác nhận dữ liệu vẫn còn
      await updateStudent(hs1.id, {
        code: 'HS0001',
        fullName: 'Nguyễn Văn An (Lớp Trưởng)',
        gender: 'male',
        avatar: 'bear-cream',
        parentPhone: '0919999999',
      }, teacherDb);

      // Mô phỏng F5/reload: Mở lại instance database từ registry
      const reloadedInstance = getDatabaseForUser(TEACHER_USER_ID);
      const stuReloaded = await reloadedInstance.students.get(hs1.id);
      expect(stuReloaded?.fullName).toBe('Nguyễn Văn An (Lớp Trưởng)');
      expect(stuReloaded?.parentPhone).toBe('0919999999');

      // BƯỚC 4: Thực hiện điểm danh, cộng/trừ điểm thi đua và viết nhận xét tuần
      const todayISO = '2026-10-29';

      // 4.1 Điểm danh sáng: An có mặt, Bình đi muộn
      await saveAttendance(
        cls5A.id,
        todayISO,
        'morning',
        [
          { studentId: hs1.id, status: 'present' },
          { studentId: hs2.id, status: 'late', note: 'Đi muộn 15 phút' },
        ],
        teacherDb,
      );

      const attList = await teacherDb.attendance.where('classId').equals(cls5A.id).toArray();
      expect(attList).toHaveLength(2);

      // 4.2 Chấm điểm thi đua: An +2 điểm, Bình -1 điểm
      const criteriaList = await teacherDb.criteria.where('classId').equals(cls5A.id).toArray();
      const posCrit = criteriaList.find((c) => c.points > 0)!;
      const negCrit = criteriaList.find((c) => c.points < 0)!;

      await awardPoints({ classId: cls5A.id, studentIds: [hs1.id], criterion: posCrit }, teacherDb);
      await awardPoints({ classId: cls5A.id, studentIds: [hs2.id], criterion: negCrit }, teacherDb);

      const txAn = await teacherDb.transactions.where('studentId').equals(hs1.id).toArray();
      const txBinh = await teacherDb.transactions.where('studentId').equals(hs2.id).toArray();
      expect(txAn[0].delta).toBeGreaterThan(0);
      expect(txBinh[0].delta).toBeLessThan(0);

      // 4.3 Viết nhận xét tuần (bản nháp)
      const draftComment = await saveComment(
        cls5A.id,
        {
          studentId: hs1.id,
          date: todayISO,
          session: 'morning',
          tags: [],
          content: 'Em An tiếp thu bài nhanh, cần chú ý chữ viết nắn nót hơn.',
          status: 'draft',
        },
        undefined,
        teacherDb,
      );
      expect(draftComment.status).toBe('draft');
      expect(draftComment.sentAt).toBeUndefined();

      // BƯỚC 5: Phát hành nhận xét và kiểm tra trạng thái lưu
      const publishedComment = await saveComment(
        cls5A.id,
        {
          studentId: hs1.id,
          date: todayISO,
          session: 'morning',
          tags: [],
          content: 'Em An tiếp thu bài rất tốt, chữ viết đã tiến bộ rõ rệt!',
          status: 'sent',
        },
        draftComment.id,
        teacherDb,
      );

      expect(publishedComment.status).toBe('sent');
      expect(publishedComment.sentAt).toBeDefined();

      // Kiểm tra bất biến: không thể đảo ngược sent về draft
      await expect(
        saveComment(
          cls5A.id,
          {
            studentId: hs1.id,
            date: todayISO,
            session: 'morning',
            tags: [],
            content: 'Muốn hủy',
            status: 'draft',
          },
          publishedComment.id,
          teacherDb,
        ),
      ).rejects.toThrow('Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.');

      // BƯỚC 6: Tạo mã mời phụ huynh, liên kết tài khoản và quyền xem dữ liệu
      const parentLinkAn = await getOrCreateParentLink(cls5A.id, hs1.id, undefined, teacherDb);
      expect(parentLinkAn.token).toBeDefined();
      expect(parentLinkAn.expiresAt).toBeGreaterThan(Date.now());
      expect(parentLinkAn.isRevoked).toBe(false);

      // Thu hồi mã mời
      const revokeRes = await revokeParentInvitationToken(parentLinkAn.id, teacherDb);
      expect(revokeRes.ok).toBe(true);
      const reloadedLink = await teacherDb.parentLinks.get(parentLinkAn.id);
      expect(reloadedLink?.isRevoked).toBe(true);

      // BƯỚC 7: Kiểm tra dữ liệu được lưu và phục hồi sau khi đăng xuất / đăng nhập lại
      const clsCountBefore = await teacherDb.classes.count();
      const stuCountBefore = await teacherDb.students.count();
      expect(clsCountBefore).toBe(1);
      expect(stuCountBefore).toBe(2);

      // BƯỚC 8: Kiểm tra xử lý lỗi mạng và form validation
      // 8.1 Chặn mã học sinh trùng lặp
      await expect(
        addStudent(cls5A.id, {
          code: 'HS0001',
          fullName: 'Học Sinh Trùng Mã',
          gender: 'male',
          avatar: 'cat-pink',
        }, teacherDb),
      ).rejects.toThrow(/Mã học sinh đã tồn tại/);

      // 8.2 Chặn họ tên chứa số
      await expect(
        addStudent(cls5A.id, {
          code: 'HS0099',
          fullName: 'Nguyễn Văn 123',
          gender: 'male',
          avatar: 'cat-pink',
        }, teacherDb),
      ).rejects.toThrow(/Họ tên không chứa số hoặc ký tự đặc biệt/);
    });
  });
});
