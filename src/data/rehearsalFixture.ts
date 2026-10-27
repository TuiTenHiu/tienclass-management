/**
 * Bộ dữ liệu diễn tập di trú giả lập (Synthetic Rehearsal Fixture) — Bước 3.7
 * KHÔNG sử dụng hoặc sao chép dữ liệu thật của học sinh.
 * Định danh tiền tố: REH_ hoặc _reh_ để cách ly và nhận diện hoàn toàn.
 */

import type {
  ActivityLog,
  AttendanceRecord,
  ClassRoom,
  Criterion,
  GamePick,
  ParentLink,
  PointTransaction,
  Student,
  StudentComment,
  TodoTask,
} from '../types';

export interface SyntheticRehearsalData {
  classes: ClassRoom[];
  criteria: Criterion[];
  students: Student[];
  attendance: AttendanceRecord[];
  transactions: PointTransaction[];
  comments: StudentComment[];
  parentLinks: ParentLink[];
  tasks: TodoTask[];
  activities: ActivityLog[];
  gamePicks: GamePick[];
}

export function buildSyntheticRehearsalFixture(): SyntheticRehearsalData {
  const baseTime = 1729900000000; // 2026-10-26T00:00:00Z approx

  // 1. LỚP HỌC (2 hợp lệ, 2 trùng tên để test lọc, 1 không hợp lệ)
  const classes: ClassRoom[] = [
    {
      id: 'c_reh_1',
      name: 'Lớp 1A - Diễn Tập',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Diễn Tập',
      subject: 'Tiểu học',
      color: '#F8BBD0',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'c_reh_2',
      name: 'Lớp 2A - Diễn Tập',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Diễn Tập',
      subject: 'Tiểu học',
      color: '#B3E5FC',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    // Trùng tên trong nguồn để kiểm tra phát hiện trùng
    {
      id: 'c_reh_dup_a',
      name: 'Lớp 3A - Diễn Tập',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Diễn Tập',
      color: '#C8E6C9',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 'c_reh_dup_b',
      name: 'Lớp 3a - Diễn Tập',
      schoolYear: '2026-2027',
      teacherName: 'Cô Giáo Diễn Tập',
      color: '#C8E6C9',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    // Không hợp lệ (thiếu tên, năm học sai định dạng)
    {
      id: 'c_reh_invalid',
      name: '',
      schoolYear: '2026',
      teacherName: 'Cô Giáo Diễn Tập',
      color: '#FFE0B2',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
  ];

  // 2. TIÊU CHÍ (4 hợp lệ: 2 thưởng, 2 trừ; 1 sai dấu; 1 mồ côi)
  const criteria: Criterion[] = [
    {
      id: 'cr_reh_reward_1',
      classId: 'c_reh_1',
      name: 'Phát biểu tốt',
      points: 2,
      type: 'reward',
      icon: 'star',
      order: 0,
      createdAt: baseTime,
    },
    {
      id: 'cr_reh_reward_2',
      classId: 'c_reh_1',
      name: 'Làm bài xuất sắc',
      points: 5,
      type: 'reward',
      icon: 'award',
      order: 1,
      createdAt: baseTime,
    },
    {
      id: 'cr_reh_pen_1',
      classId: 'c_reh_1',
      name: 'Mất trật tự',
      points: -2,
      type: 'penalty',
      icon: 'alert',
      order: 2,
      createdAt: baseTime,
    },
    {
      id: 'cr_reh_pen_2',
      classId: 'c_reh_1',
      name: 'Quên bài tập',
      points: -5,
      type: 'penalty',
      icon: 'book',
      order: 3,
      createdAt: baseTime,
    },
    // Tiêu chí sai dấu (penalty nhưng điểm > 0) để kiểm tra phát hiện lỗi
    {
      id: 'cr_reh_invalid_pts',
      classId: 'c_reh_1',
      name: 'Sai loại điểm',
      points: 3,
      type: 'penalty',
      icon: 'alert',
      order: 4,
      createdAt: baseTime,
    },
    // Tiêu chí mồ côi (classId không tồn tại)
    {
      id: 'cr_reh_orphan',
      classId: 'c_missing_class',
      name: 'Tiêu chí mồ côi',
      points: 1,
      type: 'reward',
      icon: 'star',
      order: 5,
      createdAt: baseTime,
    },
  ];

  // 3. HỌC SINH (4 active, 2 archived, 2 trùng mã để kiểm tra)
  const students: Student[] = [
    {
      id: 's_reh_active_1',
      classId: 'c_reh_1',
      code: 'HS-REH-01',
      fullName: 'Nguyễn Hoàng An (Diễn Tập)',
      gender: 'male',
      avatar: 'cat-pink',
      birthDate: '2019-03-15',
      parentName: 'Nguyễn Văn An (Bố)',
      parentPhone: '0901234567',
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 's_reh_active_2',
      classId: 'c_reh_1',
      code: 'HS-REH-02',
      fullName: 'Trần Mai Chi (Diễn Tập)',
      gender: 'female',
      avatar: 'cat-pink',
      birthDate: '2019-07-20',
      parentName: 'Trần Văn Chi (Bố)',
      parentPhone: '0912345678',
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 's_reh_active_3',
      classId: 'c_reh_1',
      code: 'HS-REH-03',
      fullName: 'Lê Đức Minh (Diễn Tập)',
      gender: 'male',
      avatar: 'bear-sky',
      birthDate: '2019-11-05',
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 's_reh_active_4',
      classId: 'c_reh_2',
      code: 'HS-REH-04',
      fullName: 'Phạm Quỳnh Anh (Diễn Tập)',
      gender: 'female',
      avatar: 'bear-sky',
      birthDate: '2018-05-12',
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    // Học sinh đã lưu trữ (archived)
    {
      id: 's_reh_arch_1',
      classId: 'c_reh_1',
      code: 'HS-REH-ARCH-01',
      fullName: 'Đỗ Gia Bảo (Lưu Trữ)',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'archived',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 's_reh_arch_2',
      classId: 'c_reh_2',
      code: 'HS-REH-ARCH-02',
      fullName: 'Vũ Thảo My (Lưu Trữ)',
      gender: 'female',
      avatar: 'bear-sky',
      status: 'archived',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    // Học sinh trùng mã để kiểm tra cơ chế phát hiện xung đột
    {
      id: 's_reh_dup_1',
      classId: 'c_reh_1',
      code: 'HS-REH-DUP',
      fullName: 'Học Sinh Trùng Mã A',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    {
      id: 's_reh_dup_2',
      classId: 'c_reh_1',
      code: 'hs-reh-dup',
      fullName: 'Học Sinh Trùng Mã B',
      gender: 'male',
      avatar: 'cat-pink',
      status: 'active',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
  ];

  // 4. ĐIỂM DANH (nhiều buổi: sáng, chiều; ngày 2026-10-26, 2026-10-27; 1 sai ngày, 1 sai lớp)
  const attendance: AttendanceRecord[] = [
    {
      id: 'c_reh_1|2026-10-26|morning|s_reh_active_1',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      date: '2026-10-26',
      session: 'morning',
      status: 'present',
      updatedAt: baseTime,
    },
    {
      id: 'c_reh_1|2026-10-26|morning|s_reh_active_2',
      classId: 'c_reh_1',
      studentId: 's_reh_active_2',
      date: '2026-10-26',
      session: 'morning',
      status: 'late',
      note: 'Đi muộn 10 phút',
      updatedAt: baseTime,
    },
    {
      id: 'c_reh_1|2026-10-26|afternoon|s_reh_active_1',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      date: '2026-10-26',
      session: 'afternoon',
      status: 'excused',
      note: 'Có phép của phụ huynh',
      updatedAt: baseTime,
    },
    {
      id: 'c_reh_1|2026-10-27|morning|s_reh_active_1',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      date: '2026-10-27',
      session: 'morning',
      status: 'unexcused',
      updatedAt: baseTime + 86400000,
    },
    // Điểm danh sai ngày để kiểm tra phát hiện lỗi
    {
      id: 'att_reh_bad_date',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      date: '2026-99-99',
      session: 'morning',
      status: 'present',
      updatedAt: baseTime,
    },
    // Điểm danh sai lớp (học sinh s_reh_active_4 thuộc c_reh_2 nhưng ghi vào c_reh_1)
    {
      id: 'att_reh_wrong_class',
      classId: 'c_reh_1',
      studentId: 's_reh_active_4',
      date: '2026-10-26',
      session: 'morning',
      status: 'present',
      updatedAt: baseTime,
    },
  ];

  // 5. GIAO DỊCH ĐIỂM (cộng, trừ, các tiêu chí khác nhau; 1 delta = 0; 1 mồ côi)
  const transactions: PointTransaction[] = [
    {
      id: 'tx_reh_01',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      criterionId: 'cr_reh_reward_1',
      criterionName: 'Phát biểu tốt',
      delta: 2,
      note: 'Trả lời đúng câu hỏi Toán',
      actor: 'Cô Giáo Diễn Tập',
      batchId: 'b_reh_01',
      createdAt: baseTime,
    },
    {
      id: 'tx_reh_02',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      criterionId: 'cr_reh_reward_2',
      criterionName: 'Làm bài xuất sắc',
      delta: 5,
      note: 'Điểm 10 kiểm tra giữa kỳ',
      actor: 'Cô Giáo Diễn Tập',
      batchId: 'b_reh_02',
      createdAt: baseTime + 1000,
    },
    {
      id: 'tx_reh_03',
      classId: 'c_reh_1',
      studentId: 's_reh_active_2',
      criterionId: 'cr_reh_pen_1',
      criterionName: 'Mất trật tự',
      delta: -2,
      note: 'Nói chuyện trong giờ',
      actor: 'Cô Giáo Diễn Tập',
      batchId: 'b_reh_03',
      createdAt: baseTime + 2000,
    },
    {
      id: 'tx_reh_04',
      classId: 'c_reh_1',
      studentId: 's_reh_active_2',
      criterionId: 'cr_reh_pen_2',
      criterionName: 'Quên bài tập',
      delta: -5,
      note: 'Chưa hoàn thành bài tập về nhà',
      actor: 'Cô Giáo Diễn Tập',
      batchId: 'b_reh_04',
      createdAt: baseTime + 3000,
    },
    // Giao dịch delta = 0 (không hợp lệ) để kiểm tra phát hiện lỗi
    {
      id: 'tx_reh_zero',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      criterionId: null,
      criterionName: 'Không đổi điểm',
      delta: 0,
      actor: 'Cô Giáo Diễn Tập',
      batchId: 'b_reh_05',
      createdAt: baseTime + 4000,
    },
    // Giao dịch mồ côi (học sinh không tồn tại)
    {
      id: 'tx_reh_orphan',
      classId: 'c_reh_1',
      studentId: 's_missing_student',
      criterionId: 'cr_reh_reward_1',
      criterionName: 'Phát biểu tốt',
      delta: 2,
      actor: 'Cô Giáo Diễn Tập',
      batchId: 'b_reh_06',
      createdAt: baseTime + 5000,
    },
  ];

  // 6. NHẬN XÉT TUẦN (2 sent, 2 draft)
  const comments: StudentComment[] = [
    {
      id: 'cmt_reh_sent_1',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      date: '2026-10-26',
      session: 'all',
      content: 'Em An tiếp thu bài nhanh, chăm chỉ phát biểu và hòa đồng với bạn bè.',
      tags: ['Tích cực', 'Chăm chỉ'],
      status: 'sent',
      sentAt: baseTime + 10000,
      createdAt: baseTime,
      updatedAt: baseTime + 10000,
    },
    {
      id: 'cmt_reh_sent_2',
      classId: 'c_reh_1',
      studentId: 's_reh_active_2',
      date: '2026-10-26',
      session: 'all',
      content: 'Em Chi cần chú ý tập trung hơn trong giờ học, hạn chế nói chuyện riêng.',
      tags: ['Cần cố gắng'],
      status: 'sent',
      sentAt: baseTime + 10000,
      createdAt: baseTime,
      updatedAt: baseTime + 10000,
    },
    {
      id: 'cmt_reh_draft_1',
      classId: 'c_reh_1',
      studentId: 's_reh_active_3',
      date: '2026-10-27',
      session: 'all',
      content: 'Bản nháp nhận xét tuần: Em Minh hoàn thành tốt các bài tập tuần này.',
      tags: ['Nháp'],
      status: 'draft',
      createdAt: baseTime + 86400000,
      updatedAt: baseTime + 86400000,
    },
    {
      id: 'cmt_reh_draft_2',
      classId: 'c_reh_2',
      studentId: 's_reh_active_4',
      date: '2026-10-27',
      session: 'all',
      content: 'Bản nháp nhận xét tuần: Em Quỳnh Anh có tiến bộ rõ rệt môn Toán.',
      tags: ['Nháp'],
      status: 'draft',
      createdAt: baseTime + 86400000,
      updatedAt: baseTime + 86400000,
    },
  ];

  // 7. BẢNG PHỤ TRỢ (Không di trú lên Cloud — chỉ lưu máy cục bộ)
  const parentLinks: ParentLink[] = [
    {
      id: 'pl_reh_01',
      classId: 'c_reh_1',
      studentId: 's_reh_active_1',
      token: 'SYNTHETIC_MOCK_TOKEN_ABC123456789',
      createdAt: baseTime,
      updatedAt: baseTime,
    },
  ];

  const tasks: TodoTask[] = [
    {
      id: 'task_reh_01',
      classId: 'c_reh_1',
      title: 'Soạn giáo án tuần 9 (Diễn tập)',
      done: false,
      createdAt: baseTime,
    },
  ];

  const activities: ActivityLog[] = [
    {
      id: 'act_reh_01',
      classId: 'c_reh_1',
      kind: 'points',
      message: 'Cộng 2 điểm cho Nguyễn Hoàng An',
      createdAt: baseTime,
    },
  ];

  const gamePicks: GamePick[] = [
    {
      id: 'gp_reh_01',
      classId: 'c_reh_1',
      roundId: 'round_01',
      studentId: 's_reh_active_1',
      studentName: 'Nguyễn Hoàng An',
      game: 'wheel',
      createdAt: baseTime,
    },
  ];

  return {
    classes,
    criteria,
    students,
    attendance,
    transactions,
    comments,
    parentLinks,
    tasks,
    activities,
    gamePicks,
  };
}
