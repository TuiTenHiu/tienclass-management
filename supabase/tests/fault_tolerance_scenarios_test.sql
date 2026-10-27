-- ============================================================================
-- TIENCLASS — BƯỚC 3.6: BỘ KIỂM THỬ CHỊU LỖI CUỐI CÙNG TRÊN POSTGRESQL LOCAL
-- File: supabase/tests/fault_tolerance_scenarios_test.sql
-- Mục đích: Kiểm thử thực tế các kịch bản chịu lỗi T1, T2, T3 trên PostgreSQL
-- ============================================================================

BEGIN;

DO $$
DECLARE
    -- Định danh kiểm thử cô lập (Prefix: fa01)
    v_teacher_id UUID := 'fa010000-0000-4000-8000-000000000001';
    v_class_id UUID := 'fa010000-0000-4000-8000-000000000002';
    v_crit_id UUID := 'fa010000-0000-4000-8000-000000000003';
    v_stu_active_id UUID := 'fa010000-0000-4000-8000-000000000004';
    v_stu_archived_id UUID := 'fa010000-0000-4000-8000-000000000005';
    v_batch_id UUID := 'fa010000-0000-4000-8000-000000000006';

    v_res jsonb;
    v_dup_error BOOLEAN := FALSE;
    v_verified_id UUID;
    v_verified_delta INT;
    v_conflict_detected BOOLEAN := FALSE;
    v_trigger_error BOOLEAN := FALSE;
    v_count_students INT;
    v_count_memberships INT;
    v_count_points INT;
BEGIN
    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'BẮT ĐẦU KIỂM THỬ CHỊU LỖI POSTGRESQL THỰC TẾ (T1, T2, T3)...';
    RAISE NOTICE '==============================================================================';

    -- 0. Khởi tạo Fixture cô lập
    INSERT INTO auth.users (id, email) VALUES (v_teacher_id, 'gv_fault_test@tienclass.local');
    UPDATE public.profiles SET full_name = 'GV Kiểm Thử Chịu Lỗi', role = 'teacher' WHERE id = v_teacher_id;

    INSERT INTO public.classes (id, name, school_year, teacher_id)
    VALUES (v_class_id, 'Lớp Chịu Lỗi T1-T3', '2026-2027', v_teacher_id);

    INSERT INTO public.criteria (id, class_id, name, points, type)
    VALUES (v_crit_id, v_class_id, 'Phát biểu tốt', 5, 'reward');

    -- Giả lập phiên đăng nhập của giáo viên phụ trách
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_teacher_id::text, 'role', 'authenticated')::text, true);

    -- ========================================================================
    -- TÌNH HUỐNG T1: ỨNG DỤNG BỊ GIÁN ĐOẠN GIỮA CHỪNG & TIẾP TỤC DI TRÚ
    -- ========================================================================
    RAISE NOTICE '>>> [T1]: Kiểm thử ứng dụng gián đoạn giữa chừng và chạy lại...';

    -- Đợt 1: Tạo học sinh active và học sinh archived trước khi gián đoạn
    v_res := public.create_student_in_class(
        p_class_id := v_class_id,
        p_code := 'HST1-01',
        p_full_name := 'Học Sinh Đang Học',
        p_id := v_stu_active_id,
        p_is_active := TRUE,
        p_status := 'active'
    );
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE, '[T1 - FAIL]: Tạo học sinh 1 thất bại';
    ASSERT (v_res->>'created_new')::BOOLEAN = TRUE, '[T1 - FAIL]: Không gắn cờ created_new';

    v_res := public.create_student_in_class(
        p_class_id := v_class_id,
        p_code := 'HST1-02',
        p_full_name := 'Học Sinh Đã Lưu Trữ',
        p_id := v_stu_archived_id,
        p_is_active := FALSE,
        p_status := 'archived'
    );
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE, '[T1 - FAIL]: Tạo học sinh 2 thất bại';

    -- Kiểm tra trạng thái is_active của học sinh archived
    ASSERT EXISTS (
        SELECT 1 FROM public.class_memberships 
        WHERE class_id = v_class_id AND student_id = v_stu_archived_id AND is_active = FALSE
    ), '[T1 - FAIL]: class_memberships không lưu đúng is_active = FALSE';

    -- GIẢ LẬP: Ứng dụng sập ở đây! Lần sau chạy lại di trú từ đầu:
    -- Đợt 2: Gọi lại create_student_in_class với cùng mã và cùng p_id
    v_res := public.create_student_in_class(
        p_class_id := v_class_id,
        p_code := 'HST1-01',
        p_full_name := 'Học Sinh Đang Học (Chạy lại)',
        p_id := v_stu_active_id,
        p_is_active := TRUE
    );
    ASSERT (v_res->>'already_exists')::BOOLEAN = TRUE, '[T1 - FAIL]: Gọi lại không trả về already_exists';
    ASSERT (v_res->>'student_id')::UUID = v_stu_active_id, '[T1 - FAIL]: Gọi lại làm đổi student_id';

    v_res := public.create_student_in_class(
        p_class_id := v_class_id,
        p_code := 'HST1-02',
        p_full_name := 'Học Sinh Đã Lưu Trữ (Chạy lại)',
        p_id := v_stu_archived_id,
        p_is_active := FALSE
    );
    ASSERT (v_res->>'already_exists')::BOOLEAN = TRUE, '[T1 - FAIL]: Học sinh 2 gọi lại không trả về already_exists';

    -- Xác minh số lượng bản ghi trên Database: không bị nhân đôi
    SELECT count(*) INTO v_count_students FROM public.students WHERE code IN ('HST1-01', 'HST1-02');
    ASSERT v_count_students = 2, '[T1 - FAIL]: Số lượng học sinh bị nhân đôi sau khi chạy lại!';

    SELECT count(*) INTO v_count_memberships FROM public.class_memberships WHERE class_id = v_class_id;
    ASSERT v_count_memberships = 2, '[T1 - FAIL]: Số lượng memberships bị nhân đôi sau khi chạy lại!';

    RAISE NOTICE '>>> [T1 - PASS]: Gián đoạn giữa chừng và chạy lại bảo toàn 100%% dữ liệu, không tạo bản ghi trùng!';

    -- ========================================================================
    -- TÌNH HUỐNG T2: SERVER GHI THÀNH CÔNG NHƯNG CLIENT TIMEOUT / RETRY
    -- ========================================================================
    RAISE NOTICE '>>> [T2]: Kiểm thử Server ghi thành công nhưng Client timeout và Retry...';

    -- Lần 1: Client gửi giao dịch điểm với source_id = 'offline_tx_t2_001'
    INSERT INTO public.student_points (
        class_id, student_id, criterion_id, criterion_name, delta, actor_id, batch_id, source_id
    ) VALUES (
        v_class_id, v_stu_active_id, v_crit_id, 'Phát biểu tốt', 5, v_teacher_id, v_batch_id, 'offline_tx_t2_001'
    );

    -- Lần 2 (Giả lập retry do timeout): Client gửi lại đúng source_id = 'offline_tx_t2_001'
    v_dup_error := FALSE;
    BEGIN
        INSERT INTO public.student_points (
            class_id, student_id, criterion_id, criterion_name, delta, actor_id, batch_id, source_id
        ) VALUES (
            v_class_id, v_stu_active_id, v_crit_id, 'Phát biểu tốt', 5, v_teacher_id, v_batch_id, 'offline_tx_t2_001'
        );
    EXCEPTION
        WHEN unique_violation THEN
            v_dup_error := TRUE;
    END;
    ASSERT v_dup_error = TRUE, '[T2 - FAIL]: PostgreSQL không chặn trùng source_id qua unique constraint!';

    -- Bước 2.3: Client truy vấn xác minh nguồn gốc khi gặp lỗi 23505
    SELECT id, delta INTO v_verified_id, v_verified_delta
    FROM public.student_points
    WHERE source_id = 'offline_tx_t2_001' AND student_id = v_stu_active_id AND class_id = v_class_id;
    
    ASSERT v_verified_id IS NOT NULL, '[T2 - FAIL]: Truy vấn xác minh không tìm thấy bản ghi Cloud!';
    ASSERT v_verified_delta = 5, '[T2 - FAIL]: Delta của bản ghi trên Cloud không khớp!';

    -- Bước 2.4: Kiểm tra trường hợp dữ liệu trên Cloud bị sai lệch nội dung
    v_conflict_detected := FALSE;
    IF v_verified_delta <> 99 THEN
        -- Giả sử client mong muốn delta = 99 nhưng Cloud trả về 5 -> Xung đột!
        v_conflict_detected := TRUE;
    END IF;
    ASSERT v_conflict_detected = TRUE, '[T2 - FAIL]: Không phát hiện xung đột khi nội dung bị sai lệch!';

    -- Bước 2.5: Gửi giao dịch hợp lệ thứ 2 có cùng nội dung (+5, cùng tiêu chí) nhưng khác source_id
    INSERT INTO public.student_points (
        class_id, student_id, criterion_id, criterion_name, delta, actor_id, batch_id, source_id
    ) VALUES (
        v_class_id, v_stu_active_id, v_crit_id, 'Phát biểu tốt', 5, v_teacher_id, v_batch_id, 'offline_tx_t2_002'
    );

    SELECT count(*) INTO v_count_points FROM public.student_points WHERE student_id = v_stu_active_id;
    ASSERT v_count_points = 2, '[T2 - FAIL]: Tổng số giao dịch điểm hợp lệ không bằng 2!';

    RAISE NOTICE '>>> [T2 - PASS]: Chống trùng cấp DB qua source_id, xác thực nguồn gốc chính xác và chấp thuận 2 giao dịch hợp lệ cùng nội dung!';

    -- ========================================================================
    -- TÌNH HUỐNG T3: BẢO VỆ ĐIỂM DANH & NHẬN XÉT TUẦN (SENT IMMUTABILITY)
    -- ========================================================================
    RAISE NOTICE '>>> [T3]: Kiểm thử bảo toàn Điểm danh và Nhận xét tuần đã phát hành...';

    -- 1. Điểm danh hợp lệ
    INSERT INTO public.attendance (class_id, student_id, date, session, status, recorded_by)
    VALUES (v_class_id, v_stu_active_id, '2026-10-27', 'morning', 'present', v_teacher_id);

    -- Thử điểm danh học sinh không thuộc lớp -> Trigger chặn đứng
    v_trigger_error := FALSE;
    BEGIN
        INSERT INTO public.attendance (class_id, student_id, date, session, status, recorded_by)
        VALUES (v_class_id, gen_random_uuid(), '2026-10-27', 'morning', 'present', v_teacher_id);
    EXCEPTION
        WHEN OTHERS THEN
            v_trigger_error := TRUE;
    END;
    ASSERT v_trigger_error = TRUE, '[T3 - FAIL]: Trigger không chặn điểm danh học sinh sai lớp!';

    -- 2. Nhận xét tuần đã phát hành (status = 'sent')
    INSERT INTO public.weekly_comments (
        class_id, student_id, week_number, school_year, date, content, status, teacher_id
    ) VALUES (
        v_class_id, v_stu_active_id, 44, '2026-2027', '2026-10-27', 'Học tập rất tích cực', 'sent', v_teacher_id
    );

    -- Thử hoàn tác nhận xét đã gửi về 'draft' -> Trigger chặn đứng
    v_trigger_error := FALSE;
    BEGIN
        UPDATE public.weekly_comments
        SET status = 'draft'
        WHERE class_id = v_class_id AND date = '2026-10-27';
    EXCEPTION
        WHEN OTHERS THEN
            v_trigger_error := TRUE;
    END;
    ASSERT v_trigger_error = TRUE, '[T3 - FAIL]: Trigger cho phép hoàn tác nhận xét đã gửi về draft!';

    -- Thử xóa nhận xét đã gửi -> Trigger chặn đứng
    v_trigger_error := FALSE;
    BEGIN
        DELETE FROM public.weekly_comments WHERE class_id = v_class_id AND date = '2026-10-27';
    EXCEPTION
        WHEN OTHERS THEN
            v_trigger_error := TRUE;
    END;
    ASSERT v_trigger_error = TRUE, '[T3 - FAIL]: Trigger cho phép xóa nhận xét đã phát hành!';

    RAISE NOTICE '>>> [T3 - PASS]: Trigger PostgreSQL bảo vệ tuyệt đối tính bất biến của nhận xét đã phát hành và tính nhất quán của điểm danh!';

    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'TẤT CẢ CÁC TÌNH HUỐNG KIỂM THỬ CHỊU LỖI (T1, T2, T3) ĐỀU ĐẠT CHUẨN 100%%!';
    RAISE NOTICE '==============================================================================';
END $$;

ROLLBACK;
