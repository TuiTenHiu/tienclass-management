import { describe, it, expect } from 'vitest';
import { pickRandom, secureRandomInt } from './picker';
import { pointsByStudent, summarizeAttendance } from './stats';
import type { AttendanceRecord, PointTransaction, Student } from '../types';

describe('Logic chọn học sinh ngẫu nhiên công bằng', () => {
  const dummyStudents: Student[] = [
    { id: '1', classId: 'c1', code: 'HS1', fullName: 'Nguyễn Văn A', gender: 'male', avatar: 'cat-pink', status: 'active', createdAt: 0, updatedAt: 0 },
    { id: '2', classId: 'c1', code: 'HS2', fullName: 'Trần Thị B', gender: 'female', avatar: 'bunny-pink', status: 'active', createdAt: 0, updatedAt: 0 },
    { id: '3', classId: 'c1', code: 'HS3', fullName: 'Lê Văn C', gender: 'male', avatar: 'bear-sky', status: 'active', createdAt: 0, updatedAt: 0 },
  ];

  it('secureRandomInt trả về số trong phạm vi mong đợi', () => {
    for (let i = 0; i < 50; i++) {
      const val = secureRandomInt(5);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(5);
    }
  });

  it('chọn học sinh khi danh sách hợp lệ', () => {
    const res = pickRandom(dummyStudents);
    expect(res.picked).not.toBeNull();
    expect(dummyStudents.map((s) => s.id)).toContain(res.picked?.id);
  });

  it('tôn trọng chế độ không lặp lại học sinh đã chọn', () => {
    const res = pickRandom(dummyStudents, {
      alreadyPicked: ['1', '2'],
      noRepeat: true,
    });
    expect(res.picked?.id).toBe('3');
    expect(res.remaining).toBe(0);
  });

  it('báo hết lượt khi tất cả học sinh đã được chọn ở chế độ không lặp', () => {
    const res = pickRandom(dummyStudents, {
      alreadyPicked: ['1', '2', '3'],
      noRepeat: true,
    });
    expect(res.picked).toBeNull();
    expect(res.exhausted).toBe(true);
  });
});

describe('Logic tính toán thống kê thi đua & chuyên cần', () => {
  it('tính chính xác điểm thi đua theo học sinh và loại trừ giao dịch hoàn tác', () => {
    const txs: PointTransaction[] = [
      { id: 't1', classId: 'c1', studentId: 's1', criterionId: null, criterionName: 'Phát biểu', delta: 2, actor: 'Cô Tiên', batchId: 'b1', createdAt: 1000 },
      { id: 't2', classId: 'c1', studentId: 's1', criterionId: null, criterionName: 'Làm bài tập', delta: 3, actor: 'Cô Tiên', batchId: 'b2', createdAt: 2000 },
      { id: 't3', classId: 'c1', studentId: 's1', criterionId: null, criterionName: 'Nói chuyện', delta: -1, actor: 'Cô Tiên', batchId: 'b3', createdAt: 3000, undone: true },
      { id: 't4', classId: 'c1', studentId: 's2', criterionId: null, criterionName: 'Phát biểu', delta: 2, actor: 'Cô Tiên', batchId: 'b4', createdAt: 4000 },
    ];

    const pts = pointsByStudent(txs);
    expect(pts.get('s1')).toBe(5); // 2 + 3 (bỏ qua t3 vì undone)
    expect(pts.get('s2')).toBe(2);
  });

  it('tổng hợp chính xác tỷ lệ và số lượng các trạng thái điểm danh', () => {
    const att: AttendanceRecord[] = [
      { id: '1', classId: 'c1', studentId: 's1', date: '2026-10-26', session: 'morning', status: 'present', updatedAt: 0 },
      { id: '2', classId: 'c1', studentId: 's2', date: '2026-10-26', session: 'morning', status: 'late', updatedAt: 0 },
      { id: '3', classId: 'c1', studentId: 's3', date: '2026-10-26', session: 'morning', status: 'excused', updatedAt: 0 },
      { id: '4', classId: 'c1', studentId: 's4', date: '2026-10-26', session: 'morning', status: 'unexcused', updatedAt: 0 },
    ];

    const sum = summarizeAttendance(att);
    expect(sum.present).toBe(1);
    expect(sum.late).toBe(1);
    expect(sum.excused).toBe(1);
    expect(sum.unexcused).toBe(1);
    expect(sum.total).toBe(4);
    expect(sum.rate).toBe(0.5); // (1 + 1) / 4 = 50%
  });
});
