import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('./repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repo')>();
  return {
    ...actual,
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      userId: 'teacher-uuid-1111-1111-111111111111',
      fullName: 'Cô Giáo Test',
      role: 'teacher',
      email: 'teacher@test.com',
    }),
  };
});

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: {
            id: 'teacher-uuid-1111-1111-111111111111',
            email: 'teacher@test.com',
          },
        },
        error: null,
      }),
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: {
            user: {
              id: 'teacher-uuid-1111-1111-111111111111',
              email: 'teacher@test.com',
            },
          },
        },
        error: null,
      }),
    },
  },
  isSupabaseConfigured: true,
  checkSupabaseConnection: vi.fn().mockResolvedValue(true),
}));

import {
  startImportSession,
  recordImportProvenanceBatch,
  resumeImportSession,
  commitImportSession,
  rollbackImportSession,
  reconcileStaleImportSessions,
  getActiveImportSession,
  ProvenanceRecordInput,
} from './migration';

describe('TIENCLASS — GIAI ĐOẠN 2.6: Unit & Integration Tests cho Import Session & Safe Rollback', () => {
  const dummyChecksum = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef';
  const dummySessionId = '00000000-0000-0000-0000-000000000001';
  const dummyLeaseToken = '00000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Khởi tạo phiên (startImportSession)', () => {
    it('gọi đúng RPC start_import_session với checksum và pipeline_version', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          session_id: dummySessionId,
          lease_token: dummyLeaseToken,
          lease_expires_at: '2026-10-28T12:00:00Z',
          lock_version: 1,
        },
        error: null,
      });

      const res = await startImportSession(dummyChecksum);

      expect(mockRpc).toHaveBeenCalledWith('start_import_session', {
        p_backup_checksum: dummyChecksum,
        p_pipeline_version: 'v1.0-cloud',
      });
      expect(res.ok).toBe(true);
      expect(res.session_id).toBe(dummySessionId);
      expect(res.lease_token).toBe(dummyLeaseToken);
      expect(res.lock_version).toBe(1);
    });

    it('xử lý lỗi RPC khi khởi tạo phiên thất bại', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Đang có phiên di trú khác đang chạy (lease chưa hết hạn).' },
      });

      const res = await startImportSession(dummyChecksum);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Đang có phiên di trú khác đang chạy');
    });
  });

  describe('2. Ghi nhận sổ cái nguồn gốc (recordImportProvenanceBatch)', () => {
    it('gửi mảng bản ghi nguồn gốc (classes, students, points) đến RPC', async () => {
      const records: ProvenanceRecordInput[] = [
        {
          entity_type: 'classes',
          source_record_id: 'local-class-1',
          cloud_record_id: '11111111-1111-1111-1111-111111111111',
          action_type: 'created',
        },
        {
          entity_type: 'students',
          source_record_id: 'local-stu-1',
          cloud_record_id: '22222222-2222-2222-2222-222222222222',
          action_type: 'linked_existing',
        },
      ];

      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          recorded_count: 2,
          lease_expires_at: '2026-10-28T12:05:00Z',
        },
        error: null,
      });

      const res = await recordImportProvenanceBatch(dummySessionId, dummyLeaseToken, records, { progress: 'step 2' });

      expect(mockRpc).toHaveBeenCalledWith('record_import_provenance_batch', {
        p_session_id: dummySessionId,
        p_lease_token: dummyLeaseToken,
        p_records: records,
        p_summary_update: { progress: 'step 2' },
      });
      expect(res.ok).toBe(true);
      expect(res.recorded_count).toBe(2);
    });

    it('từ chối ghi khi lease token bị hết hạn hoặc không khớp', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Lease token không khớp hoặc đã hết hạn.' },
      });

      const res = await recordImportProvenanceBatch(dummySessionId, dummyLeaseToken, []);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Lease token không khớp');
    });

    it('hỗ trợ ghi previous_data cho action_type = updated', async () => {
      const records: ProvenanceRecordInput[] = [
        {
          entity_type: 'classes',
          source_record_id: 'local-class-update-1',
          cloud_record_id: '33333333-3333-3333-3333-333333333333',
          action_type: 'updated',
          previous_data: { name: 'Lớp Cũ' },
        },
      ];

      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          recorded_count: 1,
        },
        error: null,
      });

      const res = await recordImportProvenanceBatch(dummySessionId, dummyLeaseToken, records);

      expect(mockRpc).toHaveBeenCalledWith('record_import_provenance_batch', {
        p_session_id: dummySessionId,
        p_lease_token: dummyLeaseToken,
        p_records: records,
        p_summary_update: null,
      });
      expect(res.ok).toBe(true);
      expect(res.recorded_count).toBe(1);
    });

    it('từ chối khi gửi bản ghi xung đột payload với bản ghi đã tồn tại trong sổ cái', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'PROVENANCE_PAYLOAD_CONFLICT: Không thể ghi đè bản ghi nguồn với payload khác.' },
      });

      const records: ProvenanceRecordInput[] = [
        {
          entity_type: 'students',
          source_record_id: 'local-stu-conflict',
          cloud_record_id: '44444444-4444-4444-4444-444444444444',
          action_type: 'created',
        },
      ];

      const res = await recordImportProvenanceBatch(dummySessionId, dummyLeaseToken, records);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('PROVENANCE_PAYLOAD_CONFLICT');
    });
  });

  describe('3. Phục hồi phiên (resumeImportSession)', () => {
    it('gọi resume_import_session thành công và nhận lease mới với lock_version tăng', async () => {
      const newLease = '00000000-0000-0000-0000-000000000003';
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          session_id: dummySessionId,
          lease_token: newLease,
          lock_version: 2,
          records_count: 5,
        },
        error: null,
      });

      const res = await resumeImportSession(dummySessionId, dummyChecksum);

      expect(mockRpc).toHaveBeenCalledWith('resume_import_session', {
        p_session_id: dummySessionId,
        p_backup_checksum: dummyChecksum,
      });
      expect(res.ok).toBe(true);
      expect(res.lease_token).toBe(newLease);
      expect(res.lock_version).toBe(2);
    });

    it('báo lỗi khi checksum bản sao lưu không khớp với phiên ban đầu', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Checksum bản sao lưu không khớp với phiên ban đầu.' },
      });

      const res = await resumeImportSession(dummySessionId, 'invalid-checksum');

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Checksum bản sao lưu không khớp');
    });
  });

  describe('4. Cam kết hoàn tất phiên (commitImportSession)', () => {
    it('gọi commit_import_session với final_summary khi di trú thành công', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          session_id: dummySessionId,
          status: 'committed',
          completed_at: '2026-10-28T12:10:00Z',
        },
        error: null,
      });

      const finalSummary = { classes: { created: 1 } };
      const res = await commitImportSession(dummySessionId, dummyLeaseToken, finalSummary);

      expect(mockRpc).toHaveBeenCalledWith('commit_import_session', {
        p_session_id: dummySessionId,
        p_lease_token: dummyLeaseToken,
        p_final_summary: finalSummary,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe('committed');
    });
  });

  describe('5. Hoàn tác an toàn (rollbackImportSession) & Rào cản an toàn (Gate Barriers)', () => {
    it('hoàn tác thành công khi không có phụ thuộc bên ngoài', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'rolled_back',
          deleted_counts: {
            weekly_comments: 2,
            student_points: 5,
            attendance: 3,
            criteria: 1,
            class_memberships: 4,
            students: 4,
            classes: 1,
          },
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(mockRpc).toHaveBeenCalledWith('rollback_import_session', {
        p_session_id: dummySessionId,
        p_lease_token: dummyLeaseToken,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe('rolled_back');
      expect(res.deleted_counts?.students).toBe(4);
      expect(res.deleted_counts?.classes).toBe(1);
    });

    it('RÀO CẢN CỔNG 1: Từ chối rollback tự động khi phát hiện liên kết phụ huynh (parent_students)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'PARENT_LINKS_EXIST',
          parent_links_count: 2,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('PARENT_LINKS_EXIST');
    });

    it('RÀO CẢN CỔNG 2: Từ chối rollback tự động khi tiêu chí đang được sử dụng ngoài phiên', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'CRITERIA_IN_USE',
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('CRITERIA_IN_USE');
    });

    it('RÀO CẢN CỔNG 4: Từ chối rollback tự động khi phát hiện mã mời phụ huynh (INVITATION_TOKENS_EXIST)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'INVITATION_TOKENS_EXIST',
          tokens_count: 3,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('INVITATION_TOKENS_EXIST');
    });

    it('RÀO CẢN CỔNG 5: Từ chối rollback tự động khi phát hiện điểm thi đua ngoài phiên (STUDENT_HAS_EXTERNAL_POINTS)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'STUDENT_HAS_EXTERNAL_POINTS',
          external_points_count: 4,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('STUDENT_HAS_EXTERNAL_POINTS');
    });

    it('RÀO CẢN CỔNG 6: Từ chối rollback tự động khi phát hiện điểm danh ngoài phiên (STUDENT_HAS_EXTERNAL_ATTENDANCE)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'STUDENT_HAS_EXTERNAL_ATTENDANCE',
          external_attendance_count: 2,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('STUDENT_HAS_EXTERNAL_ATTENDANCE');
    });

    it('RÀO CẢN CỔNG 7: Từ chối rollback tự động khi phát hiện nhận xét ngoài phiên (STUDENT_HAS_EXTERNAL_COMMENTS)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'STUDENT_HAS_EXTERNAL_COMMENTS',
          external_comments_count: 1,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('STUDENT_HAS_EXTERNAL_COMMENTS');
    });

    it('RÀO CẢN CỔNG 8: Từ chối rollback tự động khi học sinh di trú đã được ghi danh vào lớp ngoài phiên (STUDENT_ENROLLED_IN_EXTERNAL_CLASS)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'STUDENT_ENROLLED_IN_EXTERNAL_CLASS',
          external_classes_count: 1,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('STUDENT_ENROLLED_IN_EXTERNAL_CLASS');
    });

    it('FENCING LEASE: Từ chối rollback khi leaseToken truyền vào là stale trong khi phiên có lease hợp lệ khác', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'rejected',
          reason: 'STALE_LEASE_TOKEN',
          message: 'Phiên đang có lease hợp lệ khác nắm quyền.',
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, 'stale-lease-token');

      expect(res.ok).toBe(false);
      expect(res.status).toBe('rejected');
      expect(res.reason).toBe('STALE_LEASE_TOKEN');
    });

    it('HOÀN TÁC UPDATED: Hoàn tác thành công bản ghi cập nhật và trả về reverted_counts', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'rolled_back',
          deleted_counts: { classes: 0, students: 0 },
          reverted_counts: { classes: 1, students: 2, criteria: 0 },
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(true);
      expect(res.status).toBe('rolled_back');
      expect(res.reverted_counts?.classes).toBe(1);
      expect(res.reverted_counts?.students).toBe(2);
    });

    it('RÀO CẢN UPDATED: Từ chối rollback tự động khi bản ghi updated thiếu previous_data', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'UPDATED_RECORD_MISSING_PREVIOUS_DATA',
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('UPDATED_RECORD_MISSING_PREVIOUS_DATA');
    });

    it('RÀO CẢN UPDATED: Từ chối rollback tự động khi bản ghi mục tiêu bị chỉnh sửa sau import', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'requires_manual_review',
          reason: 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED',
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('requires_manual_review');
      expect(res.reason).toBe('UPDATED_RECORD_SUBSEQUENTLY_MODIFIED');
    });

    it('Tính lũy đẳng: Rollback lặp lại trả về already_rolled_back an toàn không báo lỗi', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: true,
          status: 'rolled_back',
          already_rolled_back: true,
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(true);
      expect(res.status).toBe('rolled_back');
      expect((res as any).already_rolled_back).toBe(true);
    });

    it('RÀO CẢN CỔNG 3: Từ chối rollback phiên đã cam kết (committed)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          status: 'committed',
          message: 'Phiên đã hoàn tất cam kết (committed) không được phép rollback tự động để bảo toàn tính toàn vẹn hệ thống.',
        },
        error: null,
      });

      const res = await rollbackImportSession(dummySessionId, dummyLeaseToken);

      expect(res.ok).toBe(false);
      expect(res.status).toBe('committed');
      expect(res.message).toContain('không được phép rollback tự động');
    });
  });

  describe('6. Đối soát phiên hết hạn (reconcileStaleImportSessions)', () => {
    it('gọi RPC reconcile_stale_import_sessions và trả về số phiên cập nhật', async () => {
      mockRpc.mockResolvedValueOnce({
        data: 3,
        error: null,
      });

      const res = await reconcileStaleImportSessions();

      expect(mockRpc).toHaveBeenCalledWith('reconcile_stale_import_sessions');
      expect(res.ok).toBe(true);
      expect(res.updated_count).toBe(3);
    });
  });

  describe('7. Truy vấn phiên đang hoạt động (getActiveImportSession)', () => {
    it('trả về phiên di trú gần nhất của giáo viên', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: dummySessionId,
                    status: 'in_progress',
                    lease_token: dummyLeaseToken,
                    lease_expires_at: '2026-10-28T12:00:00Z',
                    lock_version: 1,
                    summary: { step: 'criteria' },
                    backup_checksum: dummyChecksum,
                    last_error_stage: null,
                    last_error_message: null,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      });

      const session = await getActiveImportSession();

      expect(session).not.toBeNull();
      expect(session?.id).toBe(dummySessionId);
      expect(session?.status).toBe('in_progress');
      expect(session?.lockVersion).toBe(1);
    });
  });
});
