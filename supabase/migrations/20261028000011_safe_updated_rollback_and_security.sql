-- ==============================================================================
-- TIENCLASS — MIGRATION 20261028000011: SAFE UPDATED ROLLBACK, CONCURRENCY & SECURITY
-- ==============================================================================

-- 1. THU HỒI QUYỀN GHI TRỰC TIẾP TRÊN BẢNG SỔ CÁI & PHIÊN TỪ CLIENT ROLES
-- Đảm bảo chỉ SECURITY DEFINER RPCs mới được ghi/sửa/xóa trên sổ cái và phiên
REVOKE ALL ON TABLE public.legacy_import_sessions FROM anon, authenticated, public;
GRANT SELECT ON TABLE public.legacy_import_sessions TO authenticated;

REVOKE ALL ON TABLE public.legacy_import_records FROM anon, authenticated, public;
GRANT SELECT ON TABLE public.legacy_import_records TO authenticated;

-- 2. CẬP NHẬT reconcile_stale_import_sessions VỚI FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION public.reconcile_stale_import_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated_count INT;
BEGIN
    WITH stale AS (
        SELECT id
        FROM public.legacy_import_sessions
        WHERE status IN ('in_progress', 'rollback_in_progress')
          AND lease_expires_at < NOW()
          AND (teacher_id = auth.uid() OR public.is_admin())
        ORDER BY id
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.legacy_import_sessions s
    SET status = 'requires_manual_review',
        last_error_stage = 'lease_timeout_expired',
        last_error_message = 'Phiên di trú bị bỏ dở hoặc client mất kết nối quá thời hạn lease.',
        updated_at = NOW()
    FROM stale
    WHERE s.id = stale.id;
    
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    RETURN v_updated_count;
END;
$$;

-- 3. CẬP NHẬT rollback_import_session HỖ TRỢ ROLLBACK AN TOÀN CHO ACTION_TYPE = 'updated'
CREATE OR REPLACE FUNCTION public.rollback_import_session(
    p_session_id UUID,
    p_lease_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    v_student_ext_classes_count INT;
    v_del_comments INT := 0;
    v_del_points INT := 0;
    v_del_attendance INT := 0;
    v_del_criteria INT := 0;
    v_del_memberships INT := 0;
    v_del_students INT := 0;
    v_del_classes INT := 0;
    v_reverted_classes INT := 0;
    v_reverted_students INT := 0;
    v_reverted_criteria INT := 0;
    r_check RECORD;
    r_rec RECORD;
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

    -- LEASE FENCING: Nếu một client khác đang giữ lease còn hạn hiệu lực -> TỪ CHỐI ROLLBACK
    IF p_lease_token IS NOT NULL 
       AND v_session.lease_token <> p_lease_token 
       AND v_session.lease_expires_at > NOW() 
       AND NOT public.is_admin() THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', v_session.status,
            'code', 'STALE_LEASE_TOKEN',
            'reason', 'STALE_LEASE_TOKEN',
            'message', 'Một client khác đang giữ phiên hoạt động hợp lệ. Không thể rollback bằng lease token cũ.'
        );
    END IF;

    -- Kiểm tra trạng thái đã rollback (Idempotent response)
    IF v_session.status = 'rolled_back' THEN
        RETURN jsonb_build_object('ok', true, 'status', 'rolled_back', 'already_rolled_back', true);
    END IF;

    -- Chặn tuyệt đối rollback phiên committed
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
        WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type IN ('created', 'updated') AND cloud_record_id IS NOT NULL
    )
    ORDER BY id FOR UPDATE;

    PERFORM id FROM public.students
    WHERE id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type IN ('created', 'updated') AND cloud_record_id IS NOT NULL
    )
    ORDER BY id FOR UPDATE;

    PERFORM id FROM public.criteria
    WHERE id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'criteria' AND action_type IN ('created', 'updated') AND cloud_record_id IS NOT NULL
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

    -- Cổng 2: Kiểm tra mã mời phụ huynh (parent_invitation_tokens)
    SELECT count(*) INTO v_tokens_count
    FROM public.parent_invitation_tokens pit
    WHERE pit.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND cloud_record_id IS NOT NULL
    );

    IF v_tokens_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'parent_invitation_token_barrier',
            last_error_message = format('Phát hiện %s mã mời phụ huynh đang kích hoạt; từ chối rollback tự động.', v_tokens_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'PARENT_INVITATION_TOKENS_EXIST',
            'tokens_count', v_tokens_count
        );
    END IF;

    -- Cổng 3: Kiểm tra điểm phát sinh ngoài phiên (student_points)
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
            last_error_stage = 'points_external_barrier',
            last_error_message = format('Phát hiện %s giao dịch điểm ngoài phiên gắn với học sinh của phiên; từ chối rollback.', v_student_points_ext_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'STUDENT_HAS_EXTERNAL_POINTS',
            'external_points_count', v_student_points_ext_count
        );
    END IF;

    -- Cổng 4: Kiểm tra điểm danh ngoài phiên (attendance)
    SELECT count(*) INTO v_student_att_ext_count
    FROM public.attendance att
    WHERE att.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND att.id NOT IN (
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

    -- Cổng 5: Kiểm tra nhận xét ngoài phiên (weekly_comments)
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

    -- Cổng 6: Kiểm tra tiêu chí đang được sử dụng ngoài phiên (criteria)
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

    -- Cổng 7: Kiểm tra lớp học chứa học sinh ngoài phiên (classes)
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

    -- Cổng 8: Kiểm tra học sinh tạo bởi phiên được ghi danh vào lớp ngoài phiên
    SELECT count(*) INTO v_student_ext_classes_count
    FROM public.class_memberships cm
    WHERE cm.student_id IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'created' AND cloud_record_id IS NOT NULL
    ) AND cm.class_id NOT IN (
        SELECT cloud_record_id FROM public.legacy_import_records
        WHERE session_id = p_session_id AND entity_type = 'classes' AND cloud_record_id IS NOT NULL
    );

    IF v_student_ext_classes_count > 0 THEN
        UPDATE public.legacy_import_sessions
        SET status = 'requires_manual_review',
            last_error_stage = 'student_external_class_barrier',
            last_error_message = format('Phát hiện %s liên kết lớp ngoài phiên gắn với học sinh tạo bởi phiên; từ chối rollback để bảo vệ dữ liệu lớp khác.', v_student_ext_classes_count),
            updated_at = NOW()
        WHERE id = p_session_id;

        RETURN jsonb_build_object(
            'ok', false,
            'status', 'requires_manual_review',
            'reason', 'STUDENT_ENROLLED_IN_EXTERNAL_CLASS',
            'external_classes_count', v_student_ext_classes_count
        );
    END IF;

    -- ==========================================================================
    -- KIỂM TRA TÍNH TOÀN VẸN & THAY ĐỔI SAU IMPORT CỦA ACTION_TYPE = 'updated'
    -- ==========================================================================
    FOR r_check IN
        SELECT *
        FROM public.legacy_import_records
        WHERE session_id = p_session_id AND action_type = 'updated'
        ORDER BY id
    LOOP
        -- Kiểm tra 1: Phải có cloud_record_id
        IF r_check.cloud_record_id IS NULL THEN
            UPDATE public.legacy_import_sessions
            SET status = 'requires_manual_review',
                last_error_stage = 'rollback_updated_missing_cloud_id',
                last_error_message = format('Bản ghi nguồn %s thiếu cloud_record_id.', r_check.source_record_id),
                updated_at = NOW()
            WHERE id = p_session_id;

            RETURN jsonb_build_object(
                'ok', false,
                'status', 'requires_manual_review',
                'reason', 'UPDATED_RECORD_MISSING_CLOUD_ID'
            );
        END IF;

        -- Kiểm tra 2: Phải có previous_data hợp lệ
        IF r_check.previous_data IS NULL OR r_check.previous_data = '{}'::jsonb THEN
            UPDATE public.legacy_import_sessions
            SET status = 'requires_manual_review',
                last_error_stage = 'rollback_updated_missing_snapshot',
                last_error_message = format('Bản ghi nguồn %s thiếu previous_data để hoàn tác an toàn.', r_check.source_record_id),
                updated_at = NOW()
            WHERE id = p_session_id;

            RETURN jsonb_build_object(
                'ok', false,
                'status', 'requires_manual_review',
                'reason', 'UPDATED_RECORD_MISSING_PREVIOUS_DATA'
            );
        END IF;

        -- Kiểm tra 3: Đối tượng tồn tại và không bị sửa đổi sau khi import
        IF r_check.entity_type = 'classes' THEN
            IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = r_check.cloud_record_id) THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_target_missing',
                    last_error_message = 'Lớp học mục tiêu đã bị xóa trước khi rollback.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_TARGET_NOT_FOUND'
                );
            END IF;

            -- Kiểm tra sửa đổi sau import: nếu updated_at > r_check.created_at + 100ms
            IF EXISTS (
                SELECT 1 FROM public.classes
                WHERE id = r_check.cloud_record_id
                  AND updated_at > r_check.created_at + INTERVAL '100 milliseconds'
            ) THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_subsequently_modified',
                    last_error_message = 'Lớp học đã có thay đổi mới sau khi import; từ chối hoàn tác tự động.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED'
                );
            END IF;

        ELSIF r_check.entity_type = 'students' THEN
            IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = r_check.cloud_record_id) THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_target_missing',
                    last_error_message = 'Học sinh mục tiêu đã bị xóa trước khi rollback.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_TARGET_NOT_FOUND'
                );
            END IF;

            IF EXISTS (
                SELECT 1 FROM public.students
                WHERE id = r_check.cloud_record_id
                  AND updated_at > r_check.created_at + INTERVAL '100 milliseconds'
            ) THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_subsequently_modified',
                    last_error_message = 'Học sinh đã có thay đổi mới sau khi import; từ chối hoàn tác tự động.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED'
                );
            END IF;

        ELSIF r_check.entity_type = 'criteria' THEN
            IF NOT EXISTS (SELECT 1 FROM public.criteria WHERE id = r_check.cloud_record_id) THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_target_missing',
                    last_error_message = 'Tiêu chí mục tiêu đã bị xóa trước khi rollback.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_TARGET_NOT_FOUND'
                );
            END IF;

            IF EXISTS (
                SELECT 1 FROM public.criteria
                WHERE id = r_check.cloud_record_id
                  AND updated_at > r_check.created_at + INTERVAL '100 milliseconds'
            ) THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_subsequently_modified',
                    last_error_message = 'Tiêu chí đã có thay đổi mới sau khi import; từ chối hoàn tác tự động.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED'
                );
            END IF;
        ELSE
            -- Thực thể không được hỗ trợ cập nhật ngược
            UPDATE public.legacy_import_sessions
            SET status = 'requires_manual_review',
                last_error_stage = 'rollback_updated_unsupported_entity',
                last_error_message = format('Thực thể %s không hỗ trợ hoàn tác cập nhật tự động.', r_check.entity_type),
                updated_at = NOW()
            WHERE id = p_session_id;

            RETURN jsonb_build_object(
                'ok', false,
                'status', 'requires_manual_review',
                'reason', 'UPDATED_UNSUPPORTED_ENTITY_TYPE'
            );
        END IF;
    END LOOP;

    -- ==========================================================================
    -- THỰC THI HOÀN TÁC CẬP NHẬT (REVERT UPDATED ENTITIES)
    -- ==========================================================================
    -- 1. Hoàn tác classes updated
    FOR r_rec IN 
        SELECT * FROM public.legacy_import_records 
        WHERE session_id = p_session_id AND entity_type = 'classes' AND action_type = 'updated'
        ORDER BY id FOR UPDATE
    LOOP
        UPDATE public.classes c
        SET name = COALESCE(r_rec.previous_data->>'name', c.name),
            subject = CASE WHEN r_rec.previous_data ? 'subject' THEN r_rec.previous_data->>'subject' ELSE c.subject END,
            note = CASE WHEN r_rec.previous_data ? 'note' THEN r_rec.previous_data->>'note' ELSE c.note END,
            color = COALESCE(r_rec.previous_data->>'color', c.color),
            school_year = COALESCE(r_rec.previous_data->>'school_year', c.school_year),
            updated_at = NOW()
        WHERE c.id = r_rec.cloud_record_id;

        UPDATE public.legacy_import_records
        SET action_type = 'compensated'
        WHERE id = r_rec.id;

        v_reverted_classes := v_reverted_classes + 1;
    END LOOP;

    -- 2. Hoàn tác students updated
    FOR r_rec IN 
        SELECT * FROM public.legacy_import_records 
        WHERE session_id = p_session_id AND entity_type = 'students' AND action_type = 'updated'
        ORDER BY id FOR UPDATE
    LOOP
        UPDATE public.students s
        SET full_name = COALESCE(r_rec.previous_data->>'full_name', s.full_name),
            avatar = COALESCE(r_rec.previous_data->>'avatar', s.avatar),
            note = CASE WHEN r_rec.previous_data ? 'note' THEN r_rec.previous_data->>'note' ELSE s.note END,
            status = CASE WHEN r_rec.previous_data ? 'status' THEN (r_rec.previous_data->>'status')::student_status ELSE s.status END,
            parent_name = CASE WHEN r_rec.previous_data ? 'parent_name' THEN r_rec.previous_data->>'parent_name' ELSE s.parent_name END,
            parent_phone = CASE WHEN r_rec.previous_data ? 'parent_phone' THEN r_rec.previous_data->>'parent_phone' ELSE s.parent_phone END,
            birth_date = CASE WHEN r_rec.previous_data ? 'birth_date' AND r_rec.previous_data->>'birth_date' IS NOT NULL THEN (r_rec.previous_data->>'birth_date')::date ELSE NULL END,
            updated_at = NOW()
        WHERE s.id = r_rec.cloud_record_id;

        UPDATE public.legacy_import_records
        SET action_type = 'compensated'
        WHERE id = r_rec.id;

        v_reverted_students := v_reverted_students + 1;
    END LOOP;

    -- 3. Hoàn tác criteria updated
    FOR r_rec IN 
        SELECT * FROM public.legacy_import_records 
        WHERE session_id = p_session_id AND entity_type = 'criteria' AND action_type = 'updated'
        ORDER BY id FOR UPDATE
    LOOP
        UPDATE public.criteria cr
        SET name = COALESCE(r_rec.previous_data->>'name', cr.name),
            points = CASE WHEN r_rec.previous_data ? 'points' THEN (r_rec.previous_data->>'points')::integer ELSE cr.points END,
            icon = COALESCE(r_rec.previous_data->>'icon', cr.icon),
            is_active = CASE WHEN r_rec.previous_data ? 'is_active' THEN (r_rec.previous_data->>'is_active')::boolean ELSE cr.is_active END,
            updated_at = NOW()
        WHERE cr.id = r_rec.cloud_record_id;

        UPDATE public.legacy_import_records
        SET action_type = 'compensated'
        WHERE id = r_rec.id;

        v_reverted_criteria := v_reverted_criteria + 1;
    END LOOP;

    -- ==========================================================================
    -- THỰC THI XÓA LIFO TƯỜNG MINH (CHỐNG CASCADE LAN SANG DỮ LIỆU NGOÀI)
    -- ==========================================================================
    -- Kích hoạt mã định danh phiên rollback trong phạm vi giao dịch cục bộ (is_local = true)
    PERFORM set_config('tienclass.rollback_session_id', p_session_id::text, true);

    -- 1. Xóa nhận xét tuần (weekly_comments) - Chỉ xóa nhận xét created của phiên
    WITH del AS (
        DELETE FROM public.weekly_comments
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'weekly_comments' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_comments FROM del;

    -- 2. Xóa giao dịch điểm (student_points) - Chỉ xóa điểm created của phiên
    WITH del AS (
        DELETE FROM public.student_points
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'student_points' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_points FROM del;

    -- 3. Xóa điểm danh (attendance) - Chỉ xóa điểm danh created của phiên
    WITH del AS (
        DELETE FROM public.attendance
        WHERE id IN (
            SELECT cloud_record_id FROM public.legacy_import_records
            WHERE session_id = p_session_id AND entity_type = 'attendance' AND action_type = 'created' AND cloud_record_id IS NOT NULL
        )
        RETURNING id
    ) SELECT count(*) INTO v_del_attendance FROM del;

    -- 4. Xóa tiêu chí (criteria) - Chỉ xóa tiêu chí created của phiên
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
        ),
        'reverted_counts', jsonb_build_object(
            'classes', v_reverted_classes,
            'students', v_reverted_students,
            'criteria', v_reverted_criteria
        )
    );
END;
$$;
