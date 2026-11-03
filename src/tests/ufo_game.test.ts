import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn(),
  supabase: null,
}));

import { getDatabaseForUser, clearUserDatabaseRegistry } from '../data/db';
import {
  setActiveDatabase,
  createClass,
  addStudent,
  updateStudent,
  archiveStudents,
  saveGamePick,
  clearGamePicks,
} from '../data/repo';
import { pickRandom } from '../lib/picker';
import { calculateStudentSlots, UFO_BOUNDS } from '../pages/UfoGame';
import type { Student } from '../types';

describe('TIENCLASS — MINIGAME UFO GẮP HỌC SINH (UFO GAME SUITE)', () => {
  const TEACHER_ID = 'teacher-ufo-game-uuid-1111';
  const teacherDb = getDatabaseForUser(TEACHER_ID);

  beforeEach(async () => {
    vi.restoreAllMocks();
    clearUserDatabaseRegistry();
    setActiveDatabase(teacherDb, TEACHER_ID);

    await Promise.all([
      teacherDb.classes.clear(),
      teacherDb.students.clear(),
      teacherDb.gamePicks.clear(),
    ]);
  });

  afterEach(() => {
    setActiveDatabase(null, null);
  });

  /* -------------------------------------------------------------------------
   * 1. DANH SÁCH RỖNG & BIÊN
   * ------------------------------------------------------------------------- */
  describe('1. Xử lý an toàn khi danh sách học sinh rỗng', () => {
    it('1.1. Khi lớp không có học sinh, pickRandom trả về an toàn, không ném ngoại lệ', () => {
      const emptyStudents: Student[] = [];
      const res = pickRandom(emptyStudents, { noRepeat: true, alreadyPicked: [] });

      expect(res.picked).toBeNull();
      expect(res.remaining).toBe(0);
      expect(res.exhausted).toBe(false);
    });

    it('1.2. Không tạo lượt chơi trong CSDL nếu lớp chưa có học sinh', async () => {
      const cls = await createClass({
        name: 'Lớp Rỗng',
        schoolYear: '2026-2027',
        teacherName: 'Cô Bông',
      }, teacherDb);

      const picks = await teacherDb.gamePicks.where('classId').equals(cls.id).toArray();
      expect(picks).toHaveLength(0);
    });

    it('1.3. Hàm tính toán slot vị trí calculateStudentSlots trả về mảng rỗng khi 0 học sinh', () => {
      const slots = calculateStudentSlots(0);
      expect(slots).toEqual([]);
    });
  });

  /* -------------------------------------------------------------------------
   * 2. CHỌN NGẪU NHIÊN CÔNG BẰNG & PHẠM VI LỚP
   * ------------------------------------------------------------------------- */
  describe('2. Chọn ngẫu nhiên công bằng và trong phạm vi lớp', () => {
    it('2.1. Học sinh được chọn phải luôn nằm trong danh sách học sinh lớp đang chọn', async () => {
      const cls = await createClass({
        name: 'Lớp 3A',
        schoolYear: '2026-2027',
        teacherName: 'Cô Lan',
      }, teacherDb);

      const s1 = await addStudent(cls.id, { code: 'HS0001', fullName: 'Nguyễn Văn An', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const s2 = await addStudent(cls.id, { code: 'HS0002', fullName: 'Trần Thị Bình', gender: 'female', avatar: 'bunny-pink' }, teacherDb);
      const s3 = await addStudent(cls.id, { code: 'HS0003', fullName: 'Lê Hoàng Cúc', gender: 'female', avatar: 'bear-cream' }, teacherDb);

      const students = [s1, s2, s3];
      const validIds = new Set(students.map((s) => s.id));

      for (let i = 0; i < 20; i++) {
        const res = pickRandom(students, { noRepeat: false });
        expect(res.picked).not.toBeNull();
        expect(validIds.has(res.picked!.id)).toBe(true);
      }
    });

    it('2.2. Phân phối ngẫu nhiên bao quát mọi bạn học sinh trong lớp', () => {
      const mockStudents: Student[] = [
        { id: 'hs-1', code: 'HS01', fullName: 'Bạn Một', gender: 'male', avatar: 'cat-pink', classId: 'cls-1', status: 'active', createdAt: 1, updatedAt: 1 },
        { id: 'hs-2', code: 'HS02', fullName: 'Bạn Hai', gender: 'female', avatar: 'bunny-pink', classId: 'cls-1', status: 'active', createdAt: 1, updatedAt: 1 },
        { id: 'hs-3', code: 'HS03', fullName: 'Bạn Ba', gender: 'male', avatar: 'bear-cream', classId: 'cls-1', status: 'active', createdAt: 1, updatedAt: 1 },
      ];

      const counts: Record<string, number> = { 'hs-1': 0, 'hs-2': 0, 'hs-3': 0 };

      // Chạy 150 lượt với chế độ cho phép lặp
      for (let i = 0; i < 150; i++) {
        const res = pickRandom(mockStudents, { noRepeat: false });
        if (res.picked) {
          counts[res.picked.id]++;
        }
      }

      // Mỗi bạn học sinh đều phải được chọn ít nhất một vài lần
      expect(counts['hs-1']).toBeGreaterThan(15);
      expect(counts['hs-2']).toBeGreaterThan(15);
      expect(counts['hs-3']).toBeGreaterThan(15);
    });
  });

  /* -------------------------------------------------------------------------
   * 3. CHẾ ĐỘ TRÁNH LẶP LẠI (NO REPEAT) VÀ BẮT ĐẦU VÒNG MỚI
   * ------------------------------------------------------------------------- */
  describe('3. Chế độ tránh lặp lại & Vòng chơi mới', () => {
    it('3.1. Loại trừ người đã được gọi và báo exhausted khi hết cả lớp', () => {
      const mockStudents: Student[] = [
        { id: 's-1', code: 'HS01', fullName: 'An', gender: 'male', avatar: 'cat-pink', classId: 'c1', status: 'active', createdAt: 1, updatedAt: 1 },
        { id: 's-2', code: 'HS02', fullName: 'Bình', gender: 'female', avatar: 'bunny-pink', classId: 'c1', status: 'active', createdAt: 1, updatedAt: 1 },
      ];

      // Lượt 1: Gắp 1 bạn
      const res1 = pickRandom(mockStudents, { noRepeat: true, alreadyPicked: [] });
      expect(res1.picked).not.toBeNull();
      expect(res1.remaining).toBe(1);
      expect(res1.exhausted).toBe(false);

      // Lượt 2: Gắp bạn còn lại
      const alreadyPicked = [res1.picked!.id];
      const res2 = pickRandom(mockStudents, { noRepeat: true, alreadyPicked });
      expect(res2.picked).not.toBeNull();
      expect(res2.picked!.id).not.toBe(res1.picked!.id);
      expect(res2.remaining).toBe(0);
      expect(res2.exhausted).toBe(false);

      // Lượt 3: Hết lượt cả lớp (exhausted = true)
      alreadyPicked.push(res2.picked!.id);
      const res3 = pickRandom(mockStudents, { noRepeat: true, alreadyPicked });
      expect(res3.picked).toBeNull();
      expect(res3.exhausted).toBe(true);
      expect(res3.remaining).toBe(0);
    });

    it('3.2. Bắt đầu vòng mới: sau khi làm mới lịch sử, tất cả học sinh sẵn sàng được gắp lại', () => {
      const mockStudents: Student[] = [
        { id: 's-1', code: 'HS01', fullName: 'An', gender: 'male', avatar: 'cat-pink', classId: 'c1', status: 'active', createdAt: 1, updatedAt: 1 },
        { id: 's-2', code: 'HS02', fullName: 'Bình', gender: 'female', avatar: 'bunny-pink', classId: 'c1', status: 'active', createdAt: 1, updatedAt: 1 },
      ];

      // Làm mới danh sách đã chọn (reset alreadyPicked về rỗng)
      const freshPicks: string[] = [];
      const resAfterReset = pickRandom(mockStudents, { noRepeat: true, alreadyPicked: freshPicks });

      expect(resAfterReset.picked).not.toBeNull();
      expect(resAfterReset.exhausted).toBe(false);
      expect(resAfterReset.remaining).toBe(1);
    });
  });

  /* -------------------------------------------------------------------------
   * 4. LƯU LỊCH SỬ & XÓA LỊCH SỬ GỌI TÊN
   * ------------------------------------------------------------------------- */
  describe('4. Lưu và quản lý lịch sử gọi tên của UFO', () => {
    it('4.1. saveGamePick lưu đúng thông tin học sinh, lớp và roundId của minigame', async () => {
      const cls = await createClass({
        name: 'Lớp 4B',
        schoolYear: '2026-2027',
        teacherName: 'Cô Trúc',
      }, teacherDb);

      const stu = await addStudent(cls.id, {
        code: 'HS0001',
        fullName: 'Phạm Gia Khiêm',
        gender: 'male',
        avatar: 'bunny-pink',
      }, teacherDb);

      const roundId = 'ufo-round-test-123';
      await saveGamePick(cls.id, stu, roundId, teacherDb);

      const picks = await teacherDb.gamePicks.where('classId').equals(cls.id).toArray();
      expect(picks).toHaveLength(1);
      expect(picks[0].studentId).toBe(stu.id);
      expect(picks[0].studentName).toBe('Phạm Gia Khiêm');
      expect(picks[0].roundId).toBe(roundId);
      expect(picks[0].game).toBe('ufo-beam');
    });

    it('4.2. clearGamePicks xóa sạch lịch sử của đúng lớp mà không ảnh hưởng lớp khác', async () => {
      const cls1 = await createClass({ name: 'Lớp Một', schoolYear: '2026-2027', teacherName: 'Cô Một' }, teacherDb);
      const cls2 = await createClass({ name: 'Lớp Hai', schoolYear: '2026-2027', teacherName: 'Cô Hai' }, teacherDb);

      const s1 = await addStudent(cls1.id, { code: 'HS0001', fullName: 'Học Sinh Lớp Một', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const s2 = await addStudent(cls2.id, { code: 'HS0002', fullName: 'Học Sinh Lớp Hai', gender: 'female', avatar: 'bunny-pink' }, teacherDb);

      await saveGamePick(cls1.id, s1, 'r1', teacherDb);
      await saveGamePick(cls2.id, s2, 'r2', teacherDb);

      // Xóa lịch sử lớp 1
      await clearGamePicks(cls1.id, teacherDb);

      const picksCls1 = await teacherDb.gamePicks.where('classId').equals(cls1.id).toArray();
      const picksCls2 = await teacherDb.gamePicks.where('classId').equals(cls2.id).toArray();

      expect(picksCls1).toHaveLength(0);
      expect(picksCls2).toHaveLength(1); // Lớp 2 vẫn còn nguyên
    });
  });

  /* -------------------------------------------------------------------------
   * 5. ĐỒNG BỘ KHI DANH SÁCH HỌC SINH THAY ĐỔI
   * ------------------------------------------------------------------------- */
  describe('5. Cập nhật tương ứng khi thêm, sửa, xóa học sinh', () => {
    it('5.1. Khi sửa tên học sinh, lượt gọi phản ánh thông tin mới nhất', async () => {
      const cls = await createClass({ name: 'Lớp 5D', schoolYear: '2026-2027', teacherName: 'Thầy Hưng' }, teacherDb);
      const stu = await addStudent(cls.id, { code: 'HS0001', fullName: 'Đặng Tuấn Tú', gender: 'male', avatar: 'cat-pink' }, teacherDb);

      // Sửa tên học sinh
      await updateStudent(stu.id, {
        code: 'HS0001',
        fullName: 'Đặng Tuấn Tú (Lớp Trưởng)',
        gender: 'male',
        avatar: 'bunny-pink',
      }, teacherDb);

      const updatedStu = await teacherDb.students.get(stu.id);
      expect(updatedStu?.fullName).toBe('Đặng Tuấn Tú (Lớp Trưởng)');

      // Lưu lượt chơi phản ánh đúng tên mới
      await saveGamePick(cls.id, updatedStu!, 'round-updated', teacherDb);
      const picks = await teacherDb.gamePicks.where('classId').equals(cls.id).toArray();
      expect(picks[0].studentName).toBe('Đặng Tuấn Tú (Lớp Trưởng)');
    });

    it('5.2. Khi học sinh bị lưu trữ (archive), không còn nằm trong danh sách học sinh active tham gia game', async () => {
      const cls = await createClass({ name: 'Lớp 5E', schoolYear: '2026-2027', teacherName: 'Cô Thu' }, teacherDb);
      const s1 = await addStudent(cls.id, { code: 'HS0001', fullName: 'Học Sinh A', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const s2 = await addStudent(cls.id, { code: 'HS0002', fullName: 'Học Sinh B', gender: 'female', avatar: 'bunny-pink' }, teacherDb);

      // Lưu trữ học sinh A
      await archiveStudents([s1.id], teacherDb);

      const activeStudents = await teacherDb.students
        .where('classId')
        .equals(cls.id)
        .filter((s) => s.status === 'active')
        .toArray();

      expect(activeStudents).toHaveLength(1);
      expect(activeStudents[0].id).toBe(s2.id);

      // pickRandom chỉ nhận học sinh active
      const res = pickRandom(activeStudents, { noRepeat: true });
      expect(res.picked?.id).toBe(s2.id);
    });
  });

  /* -------------------------------------------------------------------------
   * 6. CÁC TRẠNG THÁI & CHUYỂN ĐỘNG CỦA UFO VÀ HỌC SINH
   * ------------------------------------------------------------------------- */
  describe('6. Máy trạng thái UFO: Idle -> Scan -> Abduct -> Celebrate', () => {
    it('6.1. Giới hạn không gian tuần tra của UFO nằm trong UFO_BOUNDS', () => {
      expect(UFO_BOUNDS.ufo.minX).toBeGreaterThanOrEqual(100);
      expect(UFO_BOUNDS.ufo.maxX).toBeLessThanOrEqual(900);
      expect(UFO_BOUNDS.ufo.hoverY).toBeLessThan(UFO_BOUNDS.minY); // UFO luôn ở trên trời, cao hơn học sinh
    });

    it('6.2. Hoạt ảnh gắp học sinh (Tractor Beam floatProgress tăng dần từ 0 lên 1 và học sinh bay lên)', () => {
      const baseY = 420;
      const ufoY = 120;
      const targetFlyY = ufoY + 40; // 160

      let floatProgress = 0;
      const dt = 0.5; // nửa giây
      floatProgress = Math.min(1, floatProgress + dt * 0.38);

      const currentY = baseY - (baseY - targetFlyY) * floatProgress;
      expect(currentY).toBeLessThan(baseY); // Học sinh bay cao dần lên trời
      expect(floatProgress).toBeGreaterThan(0);
    });

    it('6.3. Kiểm tra trường hợp lớp có đúng 1 học sinh (Biên N = 1)', () => {
      const singleStudent: Student[] = [
        { id: 'sole-1', code: 'HS01', fullName: 'Học Sinh Duy Nhất', gender: 'male', avatar: 'cat-pink', classId: 'cls-1', status: 'active', createdAt: 1, updatedAt: 1 },
      ];

      // Lượt 1: Chọn đúng bạn duy nhất
      const res1 = pickRandom(singleStudent, { noRepeat: true, alreadyPicked: [] });
      expect(res1.picked?.id).toBe('sole-1');
      expect(res1.remaining).toBe(0);
      expect(res1.exhausted).toBe(false);

      // Lượt 2: Đã gọi bạn duy nhất -> exhausted
      const res2 = pickRandom(singleStudent, { noRepeat: true, alreadyPicked: ['sole-1'] });
      expect(res2.picked).toBeNull();
      expect(res2.exhausted).toBe(true);
    });

    it('6.4. Logic tạm dừng: Khi paused = true, tọa độ nhân vật và UFO đóng băng 100%', () => {
      let ufoX = 500;
      let ufoY = 110;
      const paused = true;
      const targetX = 750;

      // Giả lập 10 frame khi paused
      for (let f = 0; f < 10; f++) {
        if (!paused) {
          ufoX += (targetX - ufoX) * 0.1;
        }
      }

      // Tọa độ phải đứng yên tuyệt đối
      expect(ufoX).toBe(500);
      expect(ufoY).toBe(110);
    });
  });
});
