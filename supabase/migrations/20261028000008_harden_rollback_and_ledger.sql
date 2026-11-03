-- Migration: 20261028000008_harden_rollback_and_ledger.sql
-- Mục đích: Gia cố an toàn Sổ cái Provenance và Rollback (Giai đoạn 2.7)
-- 1. Cho phép cloud_record_id NULL cho bản ghi conflicted/skipped
-- 2. Thay thế unique_session_entity_cloud bằng partial index chỉ áp dụng cho 'created'
-- 3. Bổ sung các rào cản an toàn trong rollback_import_session:
--    - Phát hiện điểm thi đua mới phát sinh ngoài phiên (student_points)
--    - Phát hiện điểm danh mới phát sinh ngoài phiên (attendance)
--    - Phát hiện nhận xét mới phát sinh ngoài phiên (weekly_comments)
--    - Phát hiện mã mời phụ huynh đã phát hành (parent_invitation_tokens)

BEGIN;

-- ==============================================================================
-- 1. ĐIỀU CHỈNH SCHEMA BẢNG SỔ CÁI (legacy_import_records)
-- ==============================================================================
-- Cho phép cloud_record_id NULL (dành cho bản ghi xung đột / bỏ qua không có id Cloud)
ALTER TABLE public.legacy_import_records 
    ALTER COLUMN cloud_record_id DROP NOT NULL;

-- Xóa ràng buộc unique tuyệt đối trên cloud_record_id để cho phép nhiều source records link cùng 1 cloud record có sẵn
ALTER TABLE public.legacy_import_records 
    DROP CONSTRAINT IF EXISTS unique_session_entity_cloud;

-- Tạo Partial Unique Index: Chỉ bắt buộc duy nhất cloud_record_id đối với các bản ghi 'created'
CREATE UNIQUE INDEX IF NOT EXISTS unique_session_entity_cloud_created 
    ON public.legacy_import_records (session_id, entity_type, cloud_record_id)
    WHERE action_type = 'created' AND cloud_record_id IS NOT NULL;

-- ==============================================================================
-- 2. CẬP NHẬT RPC: record_import_provenance_batch
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
    v_cloud_id UUID;
    v_raw_cloud VARCHAR;
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
            v_raw_cloud := NULLIF(btrim(v_item->>'cloud_record_id'), '');
            IF v_raw_cloud IS NOT NULL THEN
                BEGIN
                    v_cloud_id := v_raw_cloud::UUID;
                EXCEPTION WHEN OTHERS THEN
                    v_cloud_id := NULL;
                END;
            ELSE
                v_cloud_id := NULL;
            END IF;

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
                v_cloud_id,
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
-- 3. CẬP NHẬT RPC: rollback_import_session VỚI ĐẦY ĐỦ RÀO CẢN DEPENDENCY
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
    v_tokens_count INT;
    v_student_points_ext_count INT;
    v_student_att_ext_count INT;
    v_student_cmt_ext_count INT;
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
        WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    )
    ORDER BY id FOR UPDATE;

    PERFORM id FROM public.students
    WHERE id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    )
    ORDER BY id FOR UPDATE;

    -- ==========================================================================
    -- CÁC CỔNG KIỂM TRA RÀO CẢN AN TOÀN (CONTROLLED AUDIT BARRIERS)
    -- ==========================================================================
    -- Cổng 1: Kiểm tra liên kết phụ huynh đã kích hoạt (parent_students)
    SELECT count(*) INTO v_parent_links_count
    FROM public.parent_students ps
    WHERE ps.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND cloud_record_id IS NOT NULL
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

    -- Cổng 2: Kiểm tra mã mời phụ huynh chưa kích hoạt hoặc đã phát hành (parent_invitation_tokens)
    SELECT count(*) INTO v_tokens_count
    FROM public.parent_invitation_tokens pit
    WHERE pit.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    );

    IF v_tokens_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'invitation_token_barrier',
            last_error_message = format('Phát hiện %s mã mời phụ huynh gắn với học sinh tạo bởi phiên; từ chối rollback tự động.', v_tokens_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'INVITATION_TOKENS_EXIST',
            'tokens_count', v_tokens_count
        );
    END IF;

    -- Cổng 3: Kiểm tra giao dịch điểm thi đua phát sinh ngoài phiên gắn với học sinh phiên
    SELECT count(*) INTO v_student_points_ext_count
    FROM public.student_points sp
    WHERE sp.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND sp.id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'student_points' AND cloud_record_id IS NOT NULL
    );

    IF v_student_points_ext_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'student_points_external_barrier',
            last_error_message = format('Phát hiện %s giao dịch điểm ngoài phiên gắn với học sinh của phiên; từ chối rollback để bảo vệ dữ liệu.', v_student_points_ext_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'STUDENT_HAS_EXTERNAL_POINTS',
            'external_points_count', v_student_points_ext_count
        );
    END IF;

    -- Cổng 4: Kiểm tra điểm danh phát sinh ngoài phiên gắn với học sinh phiên
    SELECT count(*) INTO v_student_att_ext_count
    FROM public.attendance a
    WHERE a.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND a.id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'attendance' AND cloud_record_id IS NOT NULL
    );

    IF v_student_att_ext_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'attendance_external_barrier',
            last_error_message = format('Phát hiện %s bản ghi điểm danh ngoài phiên gắn với học sinh của phiên; từ chối rollback.', v_student_att_ext_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'STUDENT_HAS_EXTERNAL_ATTENDANCE',
            'external_attendance_count', v_student_att_ext_count
        );
    END IF;

    -- Cổng 5: Kiểm tra nhận xét phát sinh ngoài phiên gắn với học sinh phiên
    SELECT count(*) INTO v_student_cmt_ext_count
    FROM public.weekly_comments wc
    WHERE wc.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND wc.id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'weekly_comments' AND cloud_record_id IS NOT NULL
    );

    IF v_student_cmt_ext_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'comments_external_barrier',
            last_error_message = format('Phát hiện %s nhận xét ngoài phiên gắn với học sinh của phiên; từ chối rollback.', v_student_cmt_ext_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'STUDENT_HAS_EXTERNAL_COMMENTS',
            'external_comments_count', v_student_cmt_ext_count
        );
    END IF;

    -- Cổng 6: Kiểm tra tiêu chí đang được sử dụng bởi giao dịch điểm độc lập ngoài phiên
    SELECT count(*) INTO v_crit_conflict_count
    FROM public.student_points sp
    WHERE sp.criterion_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'criteria' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND sp.id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'student_points' AND cloud_record_id IS NOT NULL
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

    -- Cổng 7: Kiểm tra lớp học chứa học sinh ngoài phiên
    SELECT count(*) INTO v_class_external_count
    FROM public.class_memberships cm
    WHERE cm.class_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND cm.student_id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND cloud_record_id IS NOT NULL
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
            WHERE session_id = p_session_id AND entity_type = 'weekly_comments' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_comments FROM del;

    -- 2. Xóa giao dịch điểm (student_points)
    WITH del AS (
        DELETE FROM public.student_points
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'student_points' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_points FROM del;

    -- 3. Xóa điểm danh (attendance)
    WITH del AS (
        DELETE FROM public.attendance
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'attendance' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_attendance FROM del;

    -- 4. Xóa tiêu chí (criteria)
    WITH del AS (
        DELETE FROM public.criteria
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'criteria' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_criteria FROM del;

    -- 5. Xóa liên kết lớp (class_memberships)
    WITH del AS (
        DELETE FROM public.class_memberships
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'class_memberships' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_memberships FROM del;

    -- 6. Xóa học sinh (students) - TUYỆT ĐỐI CHỈ XÓA NẾU action_type = 'created'!
    WITH del AS (
        DELETE FROM public.students
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_students FROM del;

    -- 7. Xóa lớp học (classes) - CHỈ XÓA NẾU action_type = 'created'
    WITH del AS (
        DELETE FROM public.classes
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'created' AND cloud_record_id IS NOT NULL
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

-- Phân quyền
REVOKE ALL ON FUNCTION public.record_import_provenance_batch(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rollback_import_session(UUID, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_import_provenance_batch(UUID, UUID, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rollback_import_session(UUID, UUID) TO authenticated, service_role;

COMMIT;
