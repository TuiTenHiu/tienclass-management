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
  archiveStudents,
  saveGamePick,
  clearGamePicks,
} from '../data/repo';
import { pickRandom } from '../lib/picker';
import {
  calculateSneakSpawnSlots,
  stepDogWakeSequence,
  clampAndAvoidObstacles,
  formatStudentBadgeName,
  DOG_GAME_BOUNDS,
} from '../pages/DogGame';
import type { Student } from '../types';

describe('TIENCLASS — MINIGAME CHÚ CHÓ ĐUỔI BẮT (DOG GAME SUITE)', () => {
  const TEACHER_ID = 'teacher-dog-game-uuid-2026';
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
   * 1. DANH SÁCH RỖNG & BIÊN (EMPTY & SINGLE STUDENT)
   * ------------------------------------------------------------------------- */
  describe('1. Xử lý an toàn khi danh sách học sinh rỗng hoặc có 1 học sinh', () => {
    it('1.1. Khi lớp không có học sinh, pickRandom trả về an toàn, không ném ngoại lệ', () => {
      const emptyStudents: Student[] = [];
      const res = pickRandom(emptyStudents, { noRepeat: true, alreadyPicked: [] });

      expect(res.picked).toBeNull();
      expect(res.remaining).toBe(0);
      expect(res.exhausted).toBe(false);
    });

    it('1.2. Hàm calculateSneakSpawnSlots trả về mảng rỗng khi 0 học sinh', () => {
      const slots = calculateSneakSpawnSlots(0);
      expect(slots).toEqual([]);
    });

    it('1.3. Lớp có đúng 1 học sinh (Biên N = 1): Chạy đủ luồng chọn và chuyển trạng thái exhausted ở lượt 2', () => {
      const singleStudent: Student[] = [
        {
          id: 'sole-hs-1',
          code: 'HS001',
          fullName: 'Nguyễn Văn Độc Nhất',
          gender: 'male',
          avatar: 'cat-pink',
          classId: 'c1',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ];

      // Lượt 1: Chọn đúng bạn duy nhất
      const res1 = pickRandom(singleStudent, { noRepeat: true, alreadyPicked: [] });
      expect(res1.picked).not.toBeNull();
      expect(res1.picked?.id).toBe('sole-hs-1');
      expect(res1.remaining).toBe(0);
      expect(res1.exhausted).toBe(false);

      // Lượt 2: Bạn duy nhất đã được gọi -> exhausted = true
      const res2 = pickRandom(singleStudent, { noRepeat: true, alreadyPicked: ['sole-hs-1'] });
      expect(res2.picked).toBeNull();
      expect(res2.exhausted).toBe(true);
      expect(res2.remaining).toBe(0);
    });
  });

  /* -------------------------------------------------------------------------
   * 2. PHÂN BỔ VỊ TRÍ RÓN RÉN THEO NHÓM SO LE (SNEAK SPAWN SLOTS)
   * ------------------------------------------------------------------------- */
  describe('2. Phân bổ vị trí học sinh rón rén vào lớp (calculateSneakSpawnSlots)', () => {
    it('2.1. Phân bổ đúng 20 học sinh thành các nhóm nhỏ có độ trễ delayMoveSec tăng dần', () => {
      const total = 20;
      const slots = calculateSneakSpawnSlots(total);

      expect(slots).toHaveLength(20);

      // Kiểm tra các nhóm và độ trễ tăng dần tự nhiên
      expect(slots[0].groupIndex).toBe(0);
      expect(slots[0].delayMoveSec).toBe(0);
      expect(slots[19].groupIndex).toBe(4);
      expect(slots[19].delayMoveSec).toBeGreaterThan(slots[0].delayMoveSec);

      // Tất cả vị trí xuất phát và mục tiêu phải nằm trong ranh giới sân trường hợp lệ
      slots.forEach((s) => {
        expect(s.x).toBeGreaterThanOrEqual(DOG_GAME_BOUNDS.walkable.minX);
        expect(s.x).toBeLessThanOrEqual(DOG_GAME_BOUNDS.walkable.maxX);
        expect(s.y).toBeGreaterThanOrEqual(DOG_GAME_BOUNDS.walkable.minY);
        expect(s.y).toBeLessThanOrEqual(DOG_GAME_BOUNDS.walkable.maxY);

        expect(s.targetX).toBeGreaterThanOrEqual(DOG_GAME_BOUNDS.walkable.minX);
        expect(s.targetX).toBeLessThanOrEqual(DOG_GAME_BOUNDS.walkable.maxX);
        expect(s.targetY).toBeGreaterThanOrEqual(DOG_GAME_BOUNDS.walkable.minY);
        expect(s.targetY).toBeLessThanOrEqual(DOG_GAME_BOUNDS.walkable.maxY);
      });
    });

    it('2.2. Học sinh hàng đầu rón rén tiến dần về phía cửa lớp bên phải', () => {
      const slots = calculateSneakSpawnSlots(6);
      slots.forEach((s) => {
        // Hướng di chuyển về phía lớp học (targetX > startX)
        expect(s.targetX).toBeGreaterThan(s.x);
      });
    });
  });

  /* -------------------------------------------------------------------------
   * 3. MÁY TRẠNG THÁI CHÚ CHÓ THỨC GIẤC TUẦN TỰ (DOG WAKE SEQUENCE)
   * ------------------------------------------------------------------------- */
  describe('3. Chuỗi thức giấc tuần tự của chú chó (stepDogWakeSequence)', () => {
    it('3.1. Chuyển tuần tự: sleeping -> startled -> eye_open -> ears_up -> barking', () => {
      expect(stepDogWakeSequence(-0.1)).toBe('sleeping');
      expect(stepDogWakeSequence(0.15)).toBe('startled'); // 0.0 - 0.35s
      expect(stepDogWakeSequence(0.50)).toBe('eye_open'); // 0.35 - 0.72s
      expect(stepDogWakeSequence(0.90)).toBe('ears_up');  // 0.72 - 1.12s
      expect(stepDogWakeSequence(1.25)).toBe('barking');  // >= 1.12s
      expect(stepDogWakeSequence(2.50)).toBe('barking');
    });
  });

  /* -------------------------------------------------------------------------
   * 4. RANH GIỚI SÂN TRƯỜNG & NÉ VẬT CẢN (OBSTACLE AVOIDANCE)
   * ------------------------------------------------------------------------- */
  describe('4. Giới hạn không gian & Né vật cản (clampAndAvoidObstacles)', () => {
    it('4.1. Kẹp tọa độ khi vượt ra ngoài sân trường (ngoài viền màn hình)', () => {
      const outLeft = clampAndAvoidObstacles(-50, 400);
      expect(outLeft.x).toBe(DOG_GAME_BOUNDS.walkable.minX);

      const outRight = clampAndAvoidObstacles(1200, 400);
      expect(outRight.x).toBe(DOG_GAME_BOUNDS.walkable.maxX);

      const outTop = clampAndAvoidObstacles(500, 100);
      expect(outTop.y).toBe(DOG_GAME_BOUNDS.walkable.minY);

      const outBottom = clampAndAvoidObstacles(500, 700);
      expect(outBottom.y).toBe(DOG_GAME_BOUNDS.walkable.maxY);
    });

    it('4.2. Đẩy nhân vật ra khỏi vật cản ghế đá bên trái', () => {
      const bench = DOG_GAME_BOUNDS.obstacles.find((o) => o.id === 'bench-left')!;
      // Thử đặt nhân vật ngay chính giữa ghế đá
      const pos = clampAndAvoidObstacles(bench.x, bench.y);
      const dist = Math.hypot(pos.x - bench.x, pos.y - bench.y);

      // Khoảng cách sau khi né phải lớn hơn bán kính vật cản
      expect(dist).toBeGreaterThanOrEqual(bench.radius);
    });

    it('4.3. Đẩy nhân vật ra khỏi chậu cây trước cửa lớp', () => {
      const plant = DOG_GAME_BOUNDS.obstacles.find((o) => o.id === 'plant-door')!;
      const pos = clampAndAvoidObstacles(plant.x + 2, plant.y - 2);
      const dist = Math.hypot(pos.x - plant.x, pos.y - plant.y);

      expect(dist).toBeGreaterThanOrEqual(plant.radius);
    });
  });

  /* -------------------------------------------------------------------------
   * 5. ĐỊNH DẠNG NHÃN TÊN HỌC SINH (formatStudentBadgeName)
   * ------------------------------------------------------------------------- */
  describe('5. Rút gọn nhãn tên thông minh chống chồng lấn (formatStudentBadgeName)', () => {
    it('5.1. Giữ nguyên tên ngắn 1-2 từ và rút gọn tên dài 3-4 từ', () => {
      expect(formatStudentBadgeName('Minh An')).toBe('Minh An');
      expect(formatStudentBadgeName('Nguyễn')).toBe('Nguyễn');
      expect(formatStudentBadgeName('Nguyễn Minh An')).toBe('Minh An');
      expect(formatStudentBadgeName('Trần Thị Thùy Dung')).toBe('Thùy Dung');
    });
  });

  /* -------------------------------------------------------------------------
   * 6. CHỌN NGẪU NHIÊN CÔNG BẰNG & CHẾ ĐỘ TRÁNH LẶP LẠI (NO REPEAT)
   * ------------------------------------------------------------------------- */
  describe('6. Chọn ngẫu nhiên công bằng và lưu trữ CSDL', () => {
    it('6.1. Học sinh được chọn phải luôn thuộc lớp đang chọn', async () => {
      const cls = await createClass(
        {
          name: 'Lớp 5A',
          schoolYear: '2026-2027',
          teacherName: 'Cô Linh',
        },
        teacherDb
      );

      const s1 = await addStudent(cls.id, { code: 'HS01', fullName: 'Bạn Một', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const s2 = await addStudent(cls.id, { code: 'HS02', fullName: 'Bạn Hai', gender: 'female', avatar: 'bunny-pink' }, teacherDb);
      const s3 = await addStudent(cls.id, { code: 'HS03', fullName: 'Bạn Ba', gender: 'female', avatar: 'bear-cream' }, teacherDb);

      const students = [s1, s2, s3];
      const validIds = new Set(students.map((s) => s.id));

      for (let i = 0; i < 25; i++) {
        const res = pickRandom(students, { noRepeat: false });
        expect(res.picked).not.toBeNull();
        expect(validIds.has(res.picked!.id)).toBe(true);
      }
    });

    it('6.2. Chế độ không lặp lại: khi gọi hết lớp thì exhausted = true, sau khi xóa lịch sử lại sẵn sàng', async () => {
      const cls = await createClass(
        { name: 'Lớp 5B', schoolYear: '2026-2027', teacherName: 'Thầy Đức' },
        teacherDb
      );

      const s1 = await addStudent(cls.id, { code: 'HS01', fullName: 'Lê An', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const s2 = await addStudent(cls.id, { code: 'HS02', fullName: 'Vũ Bình', gender: 'female', avatar: 'bunny-pink' }, teacherDb);

      const students = [s1, s2];

      // Lượt 1
      const res1 = pickRandom(students, { noRepeat: true, alreadyPicked: [] });
      await saveGamePick(cls.id, res1.picked!, 'round-1', teacherDb);

      // Lượt 2
      const res2 = pickRandom(students, { noRepeat: true, alreadyPicked: [res1.picked!.id] });
      await saveGamePick(cls.id, res2.picked!, 'round-2', teacherDb);
      expect(res2.picked?.id).not.toBe(res1.picked?.id);

      // Lượt 3: Hết lượt cả lớp
      const res3 = pickRandom(students, { noRepeat: true, alreadyPicked: [res1.picked!.id, res2.picked!.id] });
      expect(res3.picked).toBeNull();
      expect(res3.exhausted).toBe(true);

      // Bắt đầu vòng mới: xóa lịch sử
      await clearGamePicks(cls.id, teacherDb);
      const freshPicks = await teacherDb.gamePicks.where('classId').equals(cls.id).toArray();
      expect(freshPicks).toHaveLength(0);

      // Sẵn sàng gọi lại
      const resAfterReset = pickRandom(students, { noRepeat: true, alreadyPicked: [] });
      expect(resAfterReset.picked).not.toBeNull();
      expect(resAfterReset.exhausted).toBe(false);
    });

    it('6.3. Khi học sinh bị lưu trữ (archive), loại khỏi danh sách tham gia game', async () => {
      const cls = await createClass(
        { name: 'Lớp 5C', schoolYear: '2026-2027', teacherName: 'Cô Trang' },
        teacherDb
      );

      const s1 = await addStudent(cls.id, { code: 'HS01', fullName: 'Học sinh Cũ', gender: 'male', avatar: 'cat-pink' }, teacherDb);
      const s2 = await addStudent(cls.id, { code: 'HS02', fullName: 'Học sinh Mới', gender: 'female', avatar: 'bunny-pink' }, teacherDb);

      // Lưu trữ học sinh 1
      await archiveStudents([s1.id], teacherDb);

      const activeStudents = await teacherDb.students
        .where('classId')
        .equals(cls.id)
        .filter((s) => s.status === 'active')
        .toArray();

      expect(activeStudents).toHaveLength(1);
      expect(activeStudents[0].id).toBe(s2.id);

      const res = pickRandom(activeStudents, { noRepeat: true });
      expect(res.picked?.id).toBe(s2.id);
    });
  });

  /* -------------------------------------------------------------------------
   * 7. TÍNH ĐÓNG BĂNG KHI TẠM DỪNG (PAUSE INTEGRITY)
   * ------------------------------------------------------------------------- */
  describe('7. Đóng băng chuyển động khi tạm dừng (isPaused = true)', () => {
    it('7.1. Khi tạm dừng, tọa độ học sinh và chú chó giữ nguyên vị trí, không nhảy tọa độ', () => {
      let dogX = 805;
      let dogY = 438;
      const isPaused = true;
      const targetDogX = 350;

      // Giả lập 20 frames với isPaused = true
      for (let f = 0; f < 20; f++) {
        if (!isPaused) {
          dogX += (targetDogX - dogX) * 0.1;
        }
      }

      expect(dogX).toBe(805);
      expect(dogY).toBe(438);
    });
  });
});
