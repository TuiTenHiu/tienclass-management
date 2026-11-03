-- Migration: 20261028000010_provenance_atomicity_and_barrier_hardening.sql
-- Mục đích: Gia cố tính nguyên tử của Provenance Ledger, Rào cản Rollback và Phân quyền Trigger (Giai đoạn 2.8)
-- 1. Bổ sung previous_data JSONB cho legacy_import_records để bảo toàn trạng thái trước khi updated.
-- 2. record_import_provenance_batch: Chống ghi đè payload mâu thuẫn, bảo đảm lũy đẳng tuyệt đối khi lost ACK.
-- 3. rollback_import_session:
--    - Kiểm tra Lease Fencing: Ngăn client có lease cũ rollback đè lên client đang import tích cực.
--    - Bổ sung Cổng kiểm tra học sinh phiên được ghi danh vào lớp ngoài phiên (STUDENT_ENROLLED_IN_EXTERNAL_CLASS).
-- 4. handle_comment_status_and_consistency:
--    - Xác thực tường minh qua bảng sổ cái: Chỉ cho phép xóa nhận xét nếu nhận xét đó do chính phiên đang rollback tạo ra.

BEGIN;

-- ==============================================================================
-- 1. BỔ SUNG CỘT previous_data VÀO SỔ CÁI NGUỒN GỐC
-- ==============================================================================
ALTER TABLE public.legacy_import_records 
    ADD COLUMN IF NOT EXISTS previous_data JSONB NULL;

-- ==============================================================================
-- 2. NÂNG CẤP RPC: record_import_provenance_batch
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
    v_action_type VARCHAR;
    v_existing_rec RECORD;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    -- Khóa hàng phiên để serialize ghi nhận
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

    -- Xử lý từng bản ghi trong batch
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

            v_action_type := COALESCE(v_item->>'action_type', 'created');

            -- Kiểm tra xem bản ghi provenance đã tồn tại chưa
            SELECT cloud_record_id, action_type, source_fingerprint INTO v_existing_rec
            FROM public.legacy_import_records
            WHERE session_id = p_session_id 
              AND entity_type = (v_item->>'entity_type') 
              AND source_record_id = (v_item->>'source_record_id');

            IF v_existing_rec.action_type IS NOT NULL THEN
                -- Nếu đã tồn tại nhưng payload khác biệt -> PHÁT HIỆN XUNG ĐỘT MÂU THUẪN, KHÔNG ĐƯỢC GHI ĐÈ!
                IF v_existing_rec.cloud_record_id IS DISTINCT FROM v_cloud_id 
                   OR v_existing_rec.action_type IS DISTINCT FROM v_action_type THEN
                    RAISE EXCEPTION 'Xung đột sổ cái provenance: Bản ghi (%, %) đã tồn tại với cloud_record_id (%) và action_type (%). Không thể ghi đè payload mâu thuẫn.',
                        (v_item->>'entity_type'), (v_item->>'source_record_id'), v_existing_rec.cloud_record_id, v_existing_rec.action_type;
                END IF;

                -- Nếu payload giống hệt -> Đây là retry an toàn (Lost ACK), bỏ qua không ghi trùng
                CONTINUE;
            END IF;

            -- Thêm mới bản ghi vào sổ cái
            INSERT INTO public.legacy_import_records (
                session_id,
                entity_type,
                source_record_id,
                cloud_record_id,
                action_type,
                source_fingerprint,
                previous_data
            ) VALUES (
                p_session_id,
                (v_item->>'entity_type'),
                (v_item->>'source_record_id'),
                v_cloud_id,
                v_action_type,
                COALESCE(v_item->>'source_fingerprint', 'SHA256_INITIAL'),
                (v_item->'previous_data')
            );

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
-- 3. NÂNG CẤP TRIGGER: handle_comment_status_and_consistency
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_comment_status_and_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_rollback_sess_id VARCHAR;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Bảo vệ lưu trữ sư phạm: Giáo viên không được tự xóa nhận xét đã phát hành
        IF OLD.status = 'sent' AND NOT public.is_admin() THEN
            v_rollback_sess_id := NULLIF(btrim(current_setting('tienclass.rollback_session_id', true)), '');
            
            -- Chỉ cho phép xóa nếu có bằng chứng xác thực trong sổ cái provenance:
            -- Nhận xét này do chính phiên đang rollback tạo ra (action_type = 'created')
            IF v_rollback_sess_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.legacy_import_records r
                JOIN public.legacy_import_sessions s ON s.id = r.session_id
                WHERE r.cloud_record_id = OLD.id
                  AND r.entity_type = 'weekly_comments'
                  AND r.action_type = 'created'
                  AND s.status = 'rollback_in_progress'
                  AND s.id = v_rollback_sess_id::UUID
            ) THEN
                RAISE EXCEPTION 'Không được phép xóa nhận xét đã gửi tới phụ huynh (bảo vệ lưu trữ sư phạm).';
            END IF;
        END IF;
        RETURN OLD;
    END IF;

    -- 1. Chỉ giáo viên phụ trách lớp hoặc admin mới được thêm/sửa nhận xét
    IF auth.uid() IS NOT NULL AND NOT (public.is_class_teacher(NEW.class_id) OR public.is_admin()) THEN
        RAISE EXCEPTION 'Chỉ giáo viên phụ trách lớp hoặc quản trị viên mới được thao tác nhận xét.';
    END IF;

    -- 2. Học sinh phải thuộc đúng lớp
    IF NOT public.is_student_in_class(NEW.student_id, NEW.class_id) THEN
        RAISE EXCEPTION 'Học sinh (id: %) không thuộc lớp (id: %).', NEW.student_id, NEW.class_id;
    END IF;

    -- 3. Xử lý thời điểm phát hành sang 'sent'
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'sent' THEN
            NEW.sent_at := COALESCE(NEW.sent_at, NOW());
            NEW.teacher_id := COALESCE(auth.uid(), NEW.teacher_id);
        ELSIF NEW.status = 'draft' THEN
            NEW.sent_at := NULL;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.status = 'sent' AND (OLD.status IS NULL OR OLD.status = 'draft') THEN
            NEW.sent_at := COALESCE(NEW.sent_at, NOW());
            NEW.teacher_id := COALESCE(auth.uid(), NEW.teacher_id);
        ELSIF OLD.status = 'sent' AND NEW.status = 'sent' THEN
            NEW.sent_at := OLD.sent_at;
            NEW.teacher_id := OLD.teacher_id;
        ELSIF OLD.status = 'sent' AND NEW.status = 'draft' THEN
            IF NOT public.is_admin() THEN
                RAISE EXCEPTION 'Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp.';
            END IF;
            NEW.sent_at := NULL;
        ELSIF NEW.status = 'draft' THEN
            NEW.sent_at := NULL;
        END IF;
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- ==============================================================================
-- 4. NÂNG CẤP RPC: rollback_import_session (LEASE FENCING & EXTERNAL CLASS MEMBERSHIP BARRIER)
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
    v_student_ext_classes_count INT;
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

    -- LEASE FENCING: Nếu một client khác đang giữ lease còn hạn hiệu lực -> TỪ CHỐI ROLLBACK
    IF p_lease_token IS NOT NULL 
       AND v_session.lease_token <> p_lease_token 
       AND v_session.lease_expires_at > NOW() 
       AND NOT public.is_admin() THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', v_session.status,
            'code', 'STALE_LEASE_TOKEN',
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

    -- Cổng 2: Kiểm tra mã mời phụ huynh (parent_invitation_tokens)
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

    -- Cổng 3: Kiểm tra giao dịch điểm thi đua ngoài phiên (student_points)
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

    -- Cổng 4: Kiểm tra điểm danh ngoài phiên (attendance)
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
        )
    );
END;
$$;

COMMIT;
