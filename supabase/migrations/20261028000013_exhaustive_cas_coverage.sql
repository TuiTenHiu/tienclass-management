-- ==============================================================================
-- TIENCLASS — MIGRATION 20261028000013: EXHAUSTIVE CAS FIELD COVERAGE HARDENING
-- ==============================================================================

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
    v_cls_target RECORD;
    v_stu_target RECORD;
    v_crit_target RECORD;
    v_old_data JSONB;
    v_expected_post JSONB;
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
    -- CÁC CỔNG KIỂM TRA RÀO CẢN AN TOÀN (CONTROLLED AUDIT BARRIERS 1 - 8)
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
    -- KIỂM TRA RÀO CẢN TOÀN VẸN & COMPARE-AND-SWAP (CAS) TOÀN DIỆN CHO ACTION_TYPE = 'updated'
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

        -- Phân tách cấu trúc previous_data: hỗ trợ cả flat snapshot hoặc nested {snapshot, post_import}
        IF r_check.previous_data ? 'snapshot' THEN
            v_old_data := r_check.previous_data->'snapshot';
            v_expected_post := r_check.previous_data->'post_import';
        ELSE
            v_old_data := r_check.previous_data;
            v_expected_post := NULL;
        END IF;

        -- Kiểm tra 3: Đối tượng tồn tại, đúng chủ sở hữu và so khớp CAS toàn bộ các trường
        IF r_check.entity_type = 'classes' THEN
            SELECT * INTO v_cls_target FROM public.classes WHERE id = r_check.cloud_record_id;
            IF v_cls_target.id IS NULL THEN
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

            -- Kiểm tra quyền sở hữu lớp
            IF v_cls_target.teacher_id <> v_session.teacher_id AND NOT public.is_admin() THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_target_owner_changed',
                    last_error_message = 'Lớp học mục tiêu đã bị thay đổi chủ sở hữu.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_TARGET_OWNER_CHANGED'
                );
            END IF;

            -- CAS TOÀN DIỆN CHO CLASSES: Bao phủ name, subject, note, color, school_year
            IF v_expected_post IS NOT NULL THEN
                IF (v_expected_post ? 'name' AND v_cls_target.name <> v_expected_post->>'name')
                   OR (v_expected_post ? 'subject' AND v_cls_target.subject IS DISTINCT FROM v_expected_post->>'subject')
                   OR (v_expected_post ? 'note' AND v_cls_target.note IS DISTINCT FROM v_expected_post->>'note')
                   OR (v_expected_post ? 'color' AND v_cls_target.color <> v_expected_post->>'color')
                   OR (v_expected_post ? 'school_year' AND v_cls_target.school_year <> v_expected_post->>'school_year') THEN
                    UPDATE public.legacy_import_sessions
                    SET status = 'requires_manual_review',
                        last_error_stage = 'rollback_updated_cas_mismatch',
                        last_error_message = 'Phát hiện dữ liệu lớp học đã bị thay đổi so với trạng thái sau import.',
                        updated_at = NOW()
                    WHERE id = p_session_id;

                    RETURN jsonb_build_object(
                        'ok', false,
                        'status', 'requires_manual_review',
                        'reason', 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED'
                    );
                END IF;
            END IF;

            -- Kiểm tra mốc thời gian updated_at
            IF v_cls_target.updated_at > r_check.created_at + INTERVAL '50 milliseconds' THEN
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
            SELECT * INTO v_stu_target FROM public.students WHERE id = r_check.cloud_record_id;
            IF v_stu_target.id IS NULL THEN
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

            -- CAS TOÀN DIỆN CHO STUDENTS: Bao phủ full_name, avatar, note, status, parent_name, parent_phone, birth_date
            IF v_expected_post IS NOT NULL THEN
                IF (v_expected_post ? 'full_name' AND v_stu_target.full_name <> v_expected_post->>'full_name')
                   OR (v_expected_post ? 'avatar' AND v_stu_target.avatar <> v_expected_post->>'avatar')
                   OR (v_expected_post ? 'note' AND v_stu_target.note IS DISTINCT FROM v_expected_post->>'note')
                   OR (v_expected_post ? 'status' AND v_stu_target.status::text <> v_expected_post->>'status')
                   OR (v_expected_post ? 'parent_name' AND v_stu_target.parent_name IS DISTINCT FROM v_expected_post->>'parent_name')
                   OR (v_expected_post ? 'parent_phone' AND v_stu_target.parent_phone IS DISTINCT FROM v_expected_post->>'parent_phone')
                   OR (v_expected_post ? 'birth_date' AND (v_stu_target.birth_date)::text IS DISTINCT FROM v_expected_post->>'birth_date') THEN
                    UPDATE public.legacy_import_sessions
                    SET status = 'requires_manual_review',
                        last_error_stage = 'rollback_updated_cas_mismatch',
                        last_error_message = 'Phát hiện thông tin học sinh đã bị thay đổi so với trạng thái sau import.',
                        updated_at = NOW()
                    WHERE id = p_session_id;

                    RETURN jsonb_build_object(
                        'ok', false,
                        'status', 'requires_manual_review',
                        'reason', 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED'
                    );
                END IF;
            END IF;

            -- Kiểm tra mốc thời gian updated_at
            IF v_stu_target.updated_at > r_check.created_at + INTERVAL '50 milliseconds' THEN
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
            SELECT * INTO v_crit_target FROM public.criteria WHERE id = r_check.cloud_record_id;
            IF v_crit_target.id IS NULL THEN
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

            -- Kiểm tra quyền sở hữu tiêu chí qua lớp học
            IF NOT public.is_class_teacher(v_crit_target.class_id) AND NOT public.is_admin() THEN
                UPDATE public.legacy_import_sessions
                SET status = 'requires_manual_review',
                    last_error_stage = 'rollback_updated_target_owner_changed',
                    last_error_message = 'Tiêu chí mục tiêu không thuộc quyền sở hữu của giáo viên phiên di trú.',
                    updated_at = NOW()
                WHERE id = p_session_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'status', 'requires_manual_review',
                    'reason', 'UPDATED_TARGET_OWNER_CHANGED'
                );
            END IF;

            -- CAS TOÀN DIỆN CHO CRITERIA: Bao phủ name, points, type, icon, archived
            IF v_expected_post IS NOT NULL THEN
                IF (v_expected_post ? 'name' AND v_crit_target.name <> v_expected_post->>'name')
                   OR (v_expected_post ? 'points' AND v_crit_target.points <> (v_expected_post->>'points')::integer)
                   OR (v_expected_post ? 'type' AND v_crit_target.type::text <> v_expected_post->>'type')
                   OR (v_expected_post ? 'icon' AND v_crit_target.icon <> v_expected_post->>'icon')
                   OR (v_expected_post ? 'archived' AND v_crit_target.archived <> (v_expected_post->>'archived')::boolean) THEN
                    UPDATE public.legacy_import_sessions
                    SET status = 'requires_manual_review',
                        last_error_stage = 'rollback_updated_cas_mismatch',
                        last_error_message = 'Phát hiện tiêu chí đã bị thay đổi so với trạng thái sau import.',
                        updated_at = NOW()
                    WHERE id = p_session_id;

                    RETURN jsonb_build_object(
                        'ok', false,
                        'status', 'requires_manual_review',
                        'reason', 'UPDATED_RECORD_SUBSEQUENTLY_MODIFIED'
                    );
                END IF;
            END IF;

            -- Kiểm tra mốc thời gian updated_at (hoặc session window nếu criteria không có updated_at)
            IF v_crit_target.created_at > r_check.created_at + INTERVAL '50 milliseconds' THEN
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
        v_old_data := CASE WHEN r_rec.previous_data ? 'snapshot' THEN r_rec.previous_data->'snapshot' ELSE r_rec.previous_data END;

        UPDATE public.classes c
        SET name = COALESCE(v_old_data->>'name', c.name),
            subject = CASE WHEN v_old_data ? 'subject' THEN v_old_data->>'subject' ELSE c.subject END,
            note = CASE WHEN v_old_data ? 'note' THEN v_old_data->>'note' ELSE c.note END,
            color = COALESCE(v_old_data->>'color', c.color),
            school_year = COALESCE(v_old_data->>'school_year', c.school_year),
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
        v_old_data := CASE WHEN r_rec.previous_data ? 'snapshot' THEN r_rec.previous_data->'snapshot' ELSE r_rec.previous_data END;

        UPDATE public.students s
        SET full_name = COALESCE(v_old_data->>'full_name', s.full_name),
            avatar = COALESCE(v_old_data->>'avatar', s.avatar),
            note = CASE WHEN v_old_data ? 'note' THEN v_old_data->>'note' ELSE s.note END,
            status = CASE WHEN v_old_data ? 'status' THEN (v_old_data->>'status')::student_status ELSE s.status END,
            parent_name = CASE WHEN v_old_data ? 'parent_name' THEN v_old_data->>'parent_name' ELSE s.parent_name END,
            parent_phone = CASE WHEN v_old_data ? 'parent_phone' THEN v_old_data->>'parent_phone' ELSE s.parent_phone END,
            birth_date = CASE WHEN v_old_data ? 'birth_date' AND v_old_data->>'birth_date' IS NOT NULL THEN (v_old_data->>'birth_date')::date ELSE NULL END,
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
        v_old_data := CASE WHEN r_rec.previous_data ? 'snapshot' THEN r_rec.previous_data->'snapshot' ELSE r_rec.previous_data END;

        UPDATE public.criteria cr
        SET name = COALESCE(v_old_data->>'name', cr.name),
            points = CASE WHEN v_old_data ? 'points' THEN (v_old_data->>'points')::integer ELSE cr.points END,
            type = CASE WHEN v_old_data ? 'type' THEN (v_old_data->>'type')::point_criterion_type ELSE cr.type END,
            icon = COALESCE(v_old_data->>'icon', cr.icon),
            archived = CASE WHEN v_old_data ? 'archived' THEN (v_old_data->>'archived')::boolean ELSE cr.archived END
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
