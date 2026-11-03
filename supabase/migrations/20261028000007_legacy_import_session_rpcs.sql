-- Migration: 20261028000007_legacy_import_session_rpcs.sql
-- Mục đích: Các hàm RPC quản lý phiên di trú, ghi sổ cái và rollback an toàn (Giai đoạn 2.6)

BEGIN;

-- ==============================================================================
-- 1. RPC: KHỞI TẠO PHIÊN DI TRÚ (start_import_session)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.start_import_session(
    p_backup_checksum VARCHAR,
    p_pipeline_version VARCHAR DEFAULT 'v1.0-cloud'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_user_id UUID;
    v_existing_id UUID;
    v_existing_expires TIMESTAMPTZ;
    v_session_id UUID;
    v_lease_token UUID;
    v_lease_expires TIMESTAMPTZ;
    v_lock_version INT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Chưa đăng nhập: Yêu cầu xác thực tài khoản.';
    END IF;

    IF NOT (public.is_admin() OR (SELECT role FROM public.profiles WHERE id = v_user_id) IN ('teacher', 'admin')) THEN
        RAISE EXCEPTION 'Quyền bị từ chối: Chỉ giáo viên hoặc admin mới được tạo phiên di trú.';
    END IF;

    IF p_backup_checksum IS NULL OR length(btrim(p_backup_checksum)) < 16 THEN
        RAISE EXCEPTION 'Checksum bản sao lưu không hợp lệ.';
    END IF;

    -- Kiểm tra xem có phiên nào của giáo viên đang active
    SELECT id, lease_expires_at INTO v_existing_id, v_existing_expires
    FROM public.legacy_import_sessions
    WHERE teacher_id = v_user_id AND status IN ('in_progress', 'rollback_in_progress')
    ORDER BY started_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_existing_id IS NOT NULL THEN
        IF v_existing_expires > NOW() THEN
            RETURN jsonb_build_object(
                'ok', false,
                'code', 'ACTIVE_SESSION_EXISTS',
                'message', 'Đang có một tiến trình di trú khác đang chạy cho tài khoản này. Vui lòng tiếp tục phiên cũ hoặc chờ hết hạn lease.',
                'active_session_id', v_existing_id,
                'lease_expires_at', v_existing_expires
            );
        ELSE
            -- Phiên cũ đã quá hạn lease: đánh dấu failed để nhường quyền cho phiên mới
            UPDATE public.legacy_import_sessions
            SET status = 'failed',
                last_error_stage = 'superseded_by_new_session',
                last_error_message = 'Phiên cũ quá hạn lease; bị thay thế bởi phiên di trú mới.',
                updated_at = NOW()
            WHERE id = v_existing_id;
        END IF;
    END IF;

    -- Khởi tạo phiên mới
    INSERT INTO public.legacy_import_sessions (
        teacher_id,
        backup_checksum,
        pipeline_version,
        status,
        lease_expires_at
    ) VALUES (
        v_user_id,
        btrim(p_backup_checksum),
        COALESCE(p_pipeline_version, 'v1.0-cloud'),
        'in_progress',
        NOW() + INTERVAL '5 minutes'
    )
    RETURNING id, lease_token, lease_expires_at, lock_version
    INTO v_session_id, v_lease_token, v_lease_expires, v_lock_version;

    RETURN jsonb_build_object(
        'ok', true,
        'session_id', v_session_id,
        'lease_token', v_lease_token,
        'lease_expires_at', v_lease_expires,
        'lock_version', v_lock_version
    );
END;
$$;

-- ==============================================================================
-- 2. RPC: GHI NHẬT KÝ SỔ CÁI BẢN GHI (record_import_provenance_batch)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.record_import_provenance_batch(
    p_session_id UUID,
    p_lease_token UUID,
    p_records JSONB,
    p_summary_update JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_user_id UUID;
    v_session RECORD;
    v_item JSONB;
    v_count INT := 0;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    SELECT * INTO v_session
    FROM public.legacy_import_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Phiên di trú không tồn tại.';
    END IF;

    IF v_session.teacher_id <> v_user_id AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Bạn không phải chủ sở hữu phiên di trú này.';
    END IF;

    IF v_session.status <> 'in_progress' THEN
        RAISE EXCEPTION 'Phiên không ở trạng thái in_progress (Trạng thái hiện tại: %).', v_session.status;
    END IF;

    IF v_session.lease_token <> p_lease_token OR v_session.lease_expires_at <= NOW() THEN
        RAISE EXCEPTION 'Lease token không hợp lệ hoặc đã hết hạn hiệu lực.';
    END IF;

    -- Gia hạn lease & cập nhật heartbeat
    UPDATE public.legacy_import_sessions
    SET heartbeat_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        summary = COALESCE(p_summary_update, summary),
        updated_at = NOW()
    WHERE id = p_session_id;

    -- Ghi nhận danh sách bản ghi vào sổ cái provenance
    IF p_records IS NOT NULL AND jsonb_typeof(p_records) = 'array' THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_records)
        LOOP
            INSERT INTO public.legacy_import_records (
                session_id,
                entity_type,
                source_record_id,
                cloud_record_id,
                action_type,
                source_fingerprint
            ) VALUES (
                p_session_id,
                (v_item->>'entity_type'),
                (v_item->>'source_record_id'),
                (v_item->>'cloud_record_id')::UUID,
                COALESCE(v_item->>'action_type', 'created'),
                COALESCE(v_item->>'source_fingerprint', 'SHA256_INITIAL')
            )
            ON CONFLICT (session_id, entity_type, source_record_id)
            DO UPDATE SET
                cloud_record_id = EXCLUDED.cloud_record_id,
                action_type = EXCLUDED.action_type,
                source_fingerprint = EXCLUDED.source_fingerprint;

            v_count := v_count + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'recorded_count', v_count,
        'lease_expires_at', (NOW() + INTERVAL '5 minutes')
    );
END;
$$;

-- ==============================================================================
-- 3. RPC: KHÔI PHỤC PHIÊN DI TRÚ SAU GIÁN ĐOẠN (resume_import_session)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.resume_import_session(
    p_session_id UUID,
    p_backup_checksum VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_user_id UUID;
    v_session RECORD;
    v_new_lease UUID;
    v_lock_ver INT;
    v_records_count INT;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    SELECT * INTO v_session
    FROM public.legacy_import_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Phiên di trú không tồn tại.';
    END IF;

    IF v_session.teacher_id <> v_user_id AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Bạn không phải chủ sở hữu phiên di trú này.';
    END IF;

    IF v_session.status = 'committed' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'committed',
            'already_committed', true,
            'message', 'Phiên di trú đã hoàn tất cam kết (committed).'
        );
    END IF;

    IF v_session.status NOT IN ('in_progress', 'failed') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', v_session.status,
            'message', format('Phiên ở trạng thái "%s" không thể phục hồi.', v_session.status)
        );
    END IF;

    IF v_session.backup_checksum <> btrim(p_backup_checksum) THEN
        RAISE EXCEPTION 'Checksum bản sao lưu không khớp với phiên ban đầu.';
    END IF;

    v_new_lease := gen_random_uuid();

    UPDATE public.legacy_import_sessions
    SET status = 'in_progress',
        lease_token = v_new_lease,
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        heartbeat_at = NOW(),
        lock_version = lock_version + 1,
        updated_at = NOW()
    WHERE id = p_session_id
    RETURNING lock_version INTO v_lock_ver;

    SELECT count(*) INTO v_records_count
    FROM public.legacy_import_records
    WHERE session_id = p_session_id;

    RETURN jsonb_build_object(
        'ok', true,
        'session_id', p_session_id,
        'lease_token', v_new_lease,
        'lease_expires_at', (NOW() + INTERVAL '5 minutes'),
        'lock_version', v_lock_ver,
        'summary', v_session.summary,
        'records_count', v_records_count
    );
END;
$$;

-- ==============================================================================
-- 4. RPC: CAM KẾT HOÀN TẤT PHIÊN DI TRÚ (commit_import_session)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.commit_import_session(
    p_session_id UUID,
    p_lease_token UUID,
    p_final_summary JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_user_id UUID;
    v_session RECORD;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    SELECT * INTO v_session
    FROM public.legacy_import_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Phiên di trú không tồn tại.';
    END IF;

    IF v_session.teacher_id <> v_user_id AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Bạn không phải chủ sở hữu phiên di trú này.';
    END IF;

    IF v_session.status = 'committed' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'status', 'committed',
            'already_committed', true,
            'completed_at', v_session.completed_at
        );
    END IF;

    IF v_session.status <> 'in_progress' THEN
        RAISE EXCEPTION 'Phiên không ở trạng thái in_progress để cam kết (Trạng thái hiện tại: %).', v_session.status;
    END IF;

    IF v_session.lease_token <> p_lease_token OR v_session.lease_expires_at <= NOW() THEN
        RAISE EXCEPTION 'Lease token không hợp lệ hoặc đã hết hạn hiệu lực.';
    END IF;

    UPDATE public.legacy_import_sessions
    SET status = 'committed',
        completed_at = NOW(),
        summary = COALESCE(p_final_summary, summary),
        updated_at = NOW()
    WHERE id = p_session_id;

    RETURN jsonb_build_object(
        'ok', true,
        'status', 'committed',
        'completed_at', NOW()
    );
END;
$$;

-- ==============================================================================
-- 5. RPC: HOÀN TÁC DI TRÚ AN TOÀN (rollback_import_session)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.rollback_import_session(
    p_session_id UUID,
    p_lease_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_user_id UUID;
    v_session RECORD;
    v_parent_links_count INT;
    v_crit_conflict_count INT;
    v_class_external_count INT;
    v_del_comments INT := 0;
    v_del_points INT := 0;
    v_del_attendance INT := 0;
    v_del_criteria INT := 0;
    v_del_memberships INT := 0;
    v_del_students INT := 0;
    v_del_classes INT := 0;
BEGIN
    -- Rào chắn timeout 8 giây
    SET LOCAL statement_timeout = '8s';

    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    -- Khóa hàng phiên di trú
    SELECT * INTO v_session
    FROM public.legacy_import_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Phiên di trú không tồn tại.';
    END IF;

    IF v_session.teacher_id <> v_user_id AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Bạn không phải chủ sở hữu phiên di trú này.';
    END IF;

    IF v_session.status = 'rolled_back' THEN
        RETURN jsonb_build_object('ok', true, 'status', 'rolled_back', 'already_rolled_back', true);
    END IF;

    IF v_session.status = 'committed' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', 'committed',
            'message', 'Phiên đã hoàn tất cam kết (committed) không được phép rollback tự động để bảo toàn tính toàn vẹn hệ thống.'
        );
    END IF;

    -- Đánh dấu trạng thái chuyển tiếp
    UPDATE public.legacy_import_sessions
    SET status = 'rollback_in_progress',
        updated_at = NOW()
    WHERE id = p_session_id;

    -- ==========================================================================
    -- GIAO THỨC KHÓA DÒNG CHA THEO THỨ TỰ TĂNG DẦN (ORDER BY id FOR UPDATE)
    -- ==========================================================================
    PERFORM id FROM public.classes
    WHERE id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'created'
    )
    ORDER BY id FOR UPDATE;

    PERFORM id FROM public.students
    WHERE id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created'
    )
    ORDER BY id FOR UPDATE;

    -- ==========================================================================
    -- 6 CỔNG KIỂM TRA RÀO CẢN AN TOÀN (CONTROLLED AUDIT BARRIERS)
    -- ==========================================================================
    -- Cổng 1: Kiểm tra liên kết phụ huynh (parent_students)
    SELECT count(*) INTO v_parent_links_count
    FROM public.parent_students ps
    WHERE ps.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students'
    );

    IF v_parent_links_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'parent_link_barrier',
            last_error_message = format('Phát hiện %s liên kết phụ huynh đã kích hoạt; từ chối rollback tự động.', v_parent_links_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'PARENT_LINKS_EXIST',
            'parent_links_count', v_parent_links_count
        );
    END IF;

    -- Cổng 2: Kiểm tra tiêu chí đang được sử dụng bởi giao dịch điểm độc lập
    SELECT count(*) INTO v_crit_conflict_count
    FROM public.student_points sp
    WHERE sp.criterion_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'criteria' AND action_type = 'created'
    ) AND sp.id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'student_points'
    );

    IF v_crit_conflict_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'criteria_dependency_barrier',
            last_error_message = 'Tiêu chí của phiên đang được dùng bởi các giao dịch điểm ngoài phiên.',
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'CRITERIA_IN_USE'
        );
    END IF;

    -- Cổng 3: Kiểm tra lớp học chứa học sinh ngoài phiên
    SELECT count(*) INTO v_class_external_count
    FROM public.class_memberships cm
    WHERE cm.class_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'created'
    ) AND cm.student_id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students'
    );

    IF v_class_external_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'class_membership_barrier',
            last_error_message = 'Lớp học của phiên chứa học sinh ngoài phiên; từ chối xóa lớp.',
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'CLASS_HAS_EXTERNAL_STUDENTS'
        );
    END IF;

    -- ==========================================================================
    -- THỰC THI XÓA LIFO TƯỜNG MINH (CHỐNG CASCADE LAN SANG DỮ LIỆU NGOÀI)
    -- ==========================================================================
    -- 1. Xóa nhận xét tuần (weekly_comments)
    WITH del AS (
        DELETE FROM public.weekly_comments
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'weekly_comments' AND action_type = 'created'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_comments FROM del;

    -- 2. Xóa giao dịch điểm (student_points)
    WITH del AS (
        DELETE FROM public.student_points
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'student_points' AND action_type = 'created'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_points FROM del;

    -- 3. Xóa điểm danh (attendance)
    WITH del AS (
        DELETE FROM public.attendance
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'attendance' AND action_type = 'created'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_attendance FROM del;

    -- 4. Xóa tiêu chí (criteria)
    WITH del AS (
        DELETE FROM public.criteria
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'criteria' AND action_type = 'created'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_criteria FROM del;

    -- 5. Xóa liên kết lớp (class_memberships)
    WITH del AS (
        DELETE FROM public.class_memberships
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'class_memberships'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_memberships FROM del;

    -- 6. Xóa học sinh (students) - TUYỆT ĐỐI CHỈ XÓA NẾU action_type = 'created'!
    WITH del AS (
        DELETE FROM public.students
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_students FROM del;

    -- 7. Xóa lớp học (classes) - CHỈ XÓA NẾU action_type = 'created'
    WITH del AS (
        DELETE FROM public.classes
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'created'
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_classes FROM del;

    -- Hoàn tất rollback
    UPDATE public.legacy_import_sessions
    SET status = 'rolled_back',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_session_id;

    RETURN jsonb_build_object(
        'ok', true,
        'status', 'rolled_back',
        'deleted_counts', jsonb_build_object(
            'comments', v_del_comments,
            'points', v_del_points,
            'attendance', v_del_attendance,
            'criteria', v_del_criteria,
            'memberships', v_del_memberships,
            'students', v_del_students,
            'classes', v_del_classes
        )
    );
END;
$$;

-- ==============================================================================
-- 6. RPC: DỌN DẸP PHIÊN DI TRÚ MỒ CÔI / QUÁ HẠN (reconcile_stale_import_sessions)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.reconcile_stale_import_sessions()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_updated INT := 0;
BEGIN
    -- Phiên in_progress quá hạn lease chuyển thành failed
    WITH upd AS (
        UPDATE public.legacy_import_sessions
        SET status = 'failed',
            last_error_stage = 'lease_timeout',
            last_error_message = 'Phiên quá hạn lease không nhận được heartbeat từ client.',
            updated_at = NOW()
        WHERE status = 'in_progress' AND lease_expires_at <= NOW()
        RETURNING id
    )
    SELECT count(*) INTO v_updated FROM upd;

    -- Phiên rollback_in_progress quá hạn lease chuyển thành requires_manual_review
    UPDATE public.legacy_import_sessions
    SET status = 'requires_manual_review',
        last_error_stage = 'rollback_timeout',
        last_error_message = 'Phiên rollback quá hạn lease; cần kiểm tra thủ công.',
        updated_at = NOW()
    WHERE status = 'rollback_in_progress' AND lease_expires_at <= NOW();

    RETURN v_updated;
END;
$$;

-- ==============================================================================
-- 7. PHÂN QUYỀN TRÊN CÁC HÀM RPC (GRANT/REVOKE)
-- ==============================================================================
REVOKE ALL ON FUNCTION public.start_import_session(VARCHAR, VARCHAR) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_import_provenance_batch(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resume_import_session(UUID, VARCHAR) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commit_import_session(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rollback_import_session(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reconcile_stale_import_sessions() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.start_import_session(VARCHAR, VARCHAR) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_import_provenance_batch(UUID, UUID, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_import_session(UUID, VARCHAR) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_import_session(UUID, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rollback_import_session(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_import_sessions() TO authenticated, service_role;

COMMIT;
