-- ============================================================================
-- TIENCLASS — BƯỚC 3.7: DIỄN TẬP DI TRÚ TRỰC TIẾP TRÊN POSTGRESQL LOCAL
-- File: supabase/tests/rehearsal_live_test.sql
-- Mục đích: Diễn tập quy trình di trú thực tế bằng Synthetic Rehearsal Fixture
-- ============================================================================

BEGIN;

DO $$
DECLARE
    -- Định danh diễn tập cô lập (Prefix: eb07)
    v_teacher_id UUID := 'eb070000-0000-4000-8000-000000000001';
    v_class_1 UUID := 'eb070000-0000-4000-8000-000000000002';
    v_class_2 UUID := 'eb070000-0000-4000-8000-000000000003';
    
    v_crit_rew1 UUID := 'eb070000-0000-4000-8000-000000000011';
    v_crit_rew2 UUID := 'eb070000-0000-4000-8000-000000000012';
    v_crit_pen1 UUID := 'eb070000-0000-4000-8000-000000000013';
    v_crit_pen2 UUID := 'eb070000-0000-4000-8000-000000000014';

    v_stu_act1 UUID := 'eb070000-0000-4000-8000-000000000021';
    v_stu_act2 UUID := 'eb070000-0000-4000-8000-000000000022';
    v_stu_act3 UUID := 'eb070000-0000-4000-8000-000000000023';
    v_stu_act4 UUID := 'eb070000-0000-4000-8000-000000000024';
    v_stu_arch1 UUID := 'eb070000-0000-4000-8000-000000000025';
    v_stu_arch2 UUID := 'eb070000-0000-4000-8000-000000000026';

    v_batch_1 UUID := 'eb070000-0000-4000-8000-000000000031';
    v_batch_2 UUID := 'eb070000-0000-4000-8000-000000000032';

    v_res jsonb;
    v_sum_delta INT;
    v_dup_error BOOLEAN := FALSE;
    v_trigger_error BOOLEAN := FALSE;
    v_orphan_count INT;
BEGIN
    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'BẮT ĐẦU DIỄN TẬP DI TRÚ (REHEARSAL) TRÊN POSTGRESQL LOCAL...';
    RAISE NOTICE '==============================================================================';

    -- 1. TÀI KHOẢN GIÁO VIÊN DIỄN TẬP
    INSERT INTO auth.users (id, email) VALUES (v_teacher_id, 'gv_rehearsal_live@tienclass.local');
    UPDATE public.profiles SET full_name = 'Cô Giáo Diễn Tập', role = 'teacher' WHERE id = v_teacher_id;

    -- Thiết lập phiên làm việc của giáo viên
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_teacher_id::text, 'role', 'authenticated')::text, true);

    -- 2. DIỄN TẬP BƯỚC 1: LỚP HỌC (classes)
    INSERT INTO public.classes (id, name, school_year, teacher_id)
    VALUES (v_class_1, 'Lớp 1A - Diễn Tập', '2026-2027', v_teacher_id);
    INSERT INTO public.classes (id, name, school_year, teacher_id)
    VALUES (v_class_2, 'Lớp 2A - Diễn Tập', '2026-2027', v_teacher_id);

    ASSERT (SELECT count(*) FROM public.classes WHERE teacher_id = v_teacher_id) = 2, '[REH - FAIL]: Lớp học tạo không đủ 2 lớp';
    RAISE NOTICE '>>> [REH Bước 1 - PASS]: Tạo 2 lớp học diễn tập thành công.';

    -- 3. DIỄN TẬP BƯỚC 2: TIÊU CHÍ (criteria)
    INSERT INTO public.criteria (id, class_id, name, points, type) VALUES
        (v_crit_rew1, v_class_1, 'Phát biểu tốt', 2, 'reward'),
        (v_crit_rew2, v_class_1, 'Làm bài xuất sắc', 5, 'reward'),
        (v_crit_pen1, v_class_1, 'Mất trật tự', -2, 'penalty'),
        (v_crit_pen2, v_class_1, 'Quên bài tập', -5, 'penalty');

    ASSERT (SELECT count(*) FROM public.criteria WHERE class_id = v_class_1) = 4, '[REH - FAIL]: Tiêu chí tạo không đủ 4 tiêu chí';
    RAISE NOTICE '>>> [REH Bước 2 - PASS]: Tạo 4 tiêu chí thưởng/phạt diễn tập thành công.';

    -- 4. DIỄN TẬP BƯỚC 3: HỌC SINH & LIÊN KẾT LỚP (qua create_student_in_class)
    -- Tạo 4 học sinh active
    v_res := public.create_student_in_class(v_class_1, 'HS-REH-01', 'Nguyễn Hoàng An (Diễn Tập)', 'male'::gender_type, '2019-03-15'::date, 'cat-pink', 'Ghi chú', 'Nguyễn Văn An', '0901234567', v_stu_act1, TRUE, 'active'::student_status);
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE AND (v_res->>'created_new')::BOOLEAN = TRUE, '[REH - FAIL]: Tạo HS1 thất bại';

    v_res := public.create_student_in_class(v_class_1, 'HS-REH-02', 'Trần Mai Chi (Diễn Tập)', 'female'::gender_type, '2019-07-20'::date, 'cat-pink', NULL, 'Trần Văn Chi', '0912345678', v_stu_act2, TRUE, 'active'::student_status);
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE AND (v_res->>'created_new')::BOOLEAN = TRUE, '[REH - FAIL]: Tạo HS2 thất bại';

    v_res := public.create_student_in_class(v_class_1, 'HS-REH-03', 'Lê Đức Minh (Diễn Tập)', 'male'::gender_type, '2019-11-05'::date, 'bear-sky', NULL, NULL, NULL, v_stu_act3, TRUE, 'active'::student_status);
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE, '[REH - FAIL]: Tạo HS3 thất bại';

    v_res := public.create_student_in_class(v_class_2, 'HS-REH-04', 'Phạm Quỳnh Anh (Diễn Tập)', 'female'::gender_type, '2018-05-12'::date, 'bear-sky', NULL, NULL, NULL, v_stu_act4, TRUE, 'active'::student_status);
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE, '[REH - FAIL]: Tạo HS4 thất bại';

    -- Tạo 2 học sinh lưu trữ (archived) với p_is_active = FALSE
    v_res := public.create_student_in_class(v_class_1, 'HS-REH-ARCH-01', 'Đỗ Gia Bảo (Lưu Trữ)', 'male'::gender_type, NULL, 'cat-pink', NULL, NULL, NULL, v_stu_arch1, FALSE, 'archived'::student_status);
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE, '[REH - FAIL]: Tạo HS archived 1 thất bại';

    v_res := public.create_student_in_class(v_class_2, 'HS-REH-ARCH-02', 'Vũ Thảo My (Lưu Trữ)', 'female'::gender_type, NULL, 'bear-sky', NULL, NULL, NULL, v_stu_arch2, FALSE, 'archived'::student_status);
    ASSERT (v_res->>'ok')::BOOLEAN = TRUE, '[REH - FAIL]: Tạo HS archived 2 thất bại';

    -- Kiểm tra bảo toàn trạng thái is_active = FALSE của học sinh lưu trữ
    ASSERT (SELECT is_active FROM public.class_memberships WHERE student_id = v_stu_arch1 AND class_id = v_class_1) = FALSE, '[REH - FAIL]: HS lưu trữ 1 không có is_active = FALSE';
    ASSERT (SELECT is_active FROM public.class_memberships WHERE student_id = v_stu_arch2 AND class_id = v_class_2) = FALSE, '[REH - FAIL]: HS lưu trữ 2 không có is_active = FALSE';
    -- Kiểm tra trạng thái is_active = TRUE của học sinh đang học
    ASSERT (SELECT is_active FROM public.class_memberships WHERE student_id = v_stu_act1 AND class_id = v_class_1) = TRUE, '[REH - FAIL]: HS đang học 1 không có is_active = TRUE';

    -- Kiểm tra lũy đẳng khi gọi lại RPC (Idempotent retry)
    v_res := public.create_student_in_class(v_class_1, 'HS-REH-01', 'Nguyễn Hoàng An (Gọi Lại)', 'male'::gender_type, NULL, 'cat-pink', NULL, NULL, NULL, v_stu_act1, TRUE, 'active'::student_status);
    ASSERT (v_res->>'already_exists')::BOOLEAN = TRUE, '[REH - FAIL]: Gọi lại HS1 không trả về already_exists';
    ASSERT (v_res->>'student_id')::UUID = v_stu_act1, '[REH - FAIL]: Gọi lại HS1 đổi student_id';

    RAISE NOTICE '>>> [REH Bước 3 - PASS]: Tạo 6 học sinh (4 active, 2 archived) và bảo toàn trạng thái lớp thành công.';

    -- 5. DIỄN TẬP BƯỚC 4: ĐIỂM DANH (attendance)
    INSERT INTO public.attendance (class_id, student_id, date, session, status, recorded_by) VALUES
        (v_class_1, v_stu_act1, '2026-10-26', 'morning', 'present', v_teacher_id),
        (v_class_1, v_stu_act2, '2026-10-26', 'morning', 'late', v_teacher_id),
        (v_class_1, v_stu_act1, '2026-10-26', 'afternoon', 'excused', v_teacher_id),
        (v_class_1, v_stu_act1, '2026-10-27', 'morning', 'unexcused', v_teacher_id);

    ASSERT (SELECT count(*) FROM public.attendance WHERE class_id = v_class_1) = 4, '[REH - FAIL]: Điểm danh không đủ 4 bản ghi';

    -- Thử điểm danh học sinh không thuộc lớp -> Trigger chặn đứng
    v_trigger_error := FALSE;
    BEGIN
        INSERT INTO public.attendance (class_id, student_id, date, session, status, recorded_by)
        VALUES (v_class_1, v_stu_act4, '2026-10-26', 'morning', 'present', v_teacher_id);
    EXCEPTION WHEN OTHERS THEN
        v_trigger_error := TRUE;
    END;
    ASSERT v_trigger_error = TRUE, '[REH - FAIL]: Trigger không chặn điểm danh học sinh sai lớp';

    RAISE NOTICE '>>> [REH Bước 4 - PASS]: Điểm danh nhiều buổi và kiểm tra trigger nhất quán thành công.';

    -- 6. DIỄN TẬP BƯỚC 5: GIAO DỊCH ĐIỂM (student_points)
    INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta, actor_id, batch_id, source_id) VALUES
        (v_class_1, v_stu_act1, v_crit_rew1, 'Phát biểu tốt', 2, v_teacher_id, v_batch_1, 'tx_reh_01'),
        (v_class_1, v_stu_act1, v_crit_rew2, 'Làm bài xuất sắc', 5, v_teacher_id, v_batch_1, 'tx_reh_02'),
        (v_class_1, v_stu_act2, v_crit_pen1, 'Mất trật tự', -2, v_teacher_id, v_batch_2, 'tx_reh_03'),
        (v_class_1, v_stu_act2, v_crit_pen2, 'Quên bài tập', -5, v_teacher_id, v_batch_2, 'tx_reh_04');

    ASSERT (SELECT count(*) FROM public.student_points WHERE class_id = v_class_1) = 4, '[REH - FAIL]: Điểm thi đua không đủ 4 bản ghi';

    -- Thử chèn trùng source_id -> Bị chặn cấp Database (23505)
    v_dup_error := FALSE;
    BEGIN
        INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta, actor_id, batch_id, source_id)
        VALUES (v_class_1, v_stu_act1, v_crit_rew1, 'Phát biểu tốt', 2, v_teacher_id, v_batch_1, 'tx_reh_01');
    EXCEPTION WHEN unique_violation THEN
        v_dup_error := TRUE;
    END;
    ASSERT v_dup_error = TRUE, '[REH - FAIL]: PostgreSQL không chặn trùng source_id qua unique constraint';

    -- Thử chấm điểm tiêu chí không thuộc lớp -> Trigger chặn đứng
    v_trigger_error := FALSE;
    BEGIN
        INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta, actor_id, batch_id, source_id)
        VALUES (v_class_2, v_stu_act4, v_crit_rew1, 'Phát biểu tốt', 2, v_teacher_id, v_batch_1, 'tx_reh_bad_crit');
    EXCEPTION WHEN OTHERS THEN
        v_trigger_error := TRUE;
    END;
    ASSERT v_trigger_error = TRUE, '[REH - FAIL]: Trigger không chặn chấm điểm tiêu chí sai lớp';

    RAISE NOTICE '>>> [REH Bước 5 - PASS]: Giao dịch điểm cộng/trừ và cơ chế chống trùng source_id thành công.';

    -- 7. DIỄN TẬP BƯỚC 6: NHẬN XÉT TUẦN (weekly_comments)
    INSERT INTO public.weekly_comments (class_id, student_id, week_number, school_year, date, content, status, teacher_id) VALUES
        (v_class_1, v_stu_act1, 44, '2026-2027', '2026-10-26', 'Em An tiếp thu bài nhanh, chăm chỉ phát biểu.', 'sent', v_teacher_id),
        (v_class_1, v_stu_act2, 44, '2026-2027', '2026-10-26', 'Em Chi cần chú ý tập trung hơn.', 'sent', v_teacher_id),
        (v_class_1, v_stu_act3, 44, '2026-2027', '2026-10-27', 'Bản nháp nhận xét tuần: Hoàn thành bài tập.', 'draft', v_teacher_id),
        (v_class_2, v_stu_act4, 44, '2026-2027', '2026-10-27', 'Bản nháp nhận xét tuần: Có tiến bộ môn Toán.', 'draft', v_teacher_id);

    ASSERT (SELECT count(*) FROM public.weekly_comments WHERE class_id IN (v_class_1, v_class_2)) = 4, '[REH - FAIL]: Nhận xét tuần không đủ 4 bản ghi';

    -- Thử xóa nhận xét đã gửi (sent) -> Trigger chặn đứng
    v_trigger_error := FALSE;
    BEGIN
        DELETE FROM public.weekly_comments WHERE class_id = v_class_1 AND student_id = v_stu_act1 AND date = '2026-10-26';
    EXCEPTION WHEN OTHERS THEN
        v_trigger_error := TRUE;
    END;
    ASSERT v_trigger_error = TRUE, '[REH - FAIL]: Trigger cho phép xóa nhận xét đã phát hành (sent)';

    RAISE NOTICE '>>> [REH Bước 6 - PASS]: Nhận xét tuần (2 sent, 2 draft) và bảo vệ bất biến thành công.';

    -- ========================================================================
    -- 8. DIỄN TẬP GIAI ĐOẠN D: ĐỐI SOÁT HẬU DI TRÚ (RECONCILIATION)
    -- ========================================================================
    RAISE NOTICE '>>> [REH Giai đoạn D]: Bắt đầu kiểm tra đối soát độc lập...';

    -- 8.1. Đối soát khóa ngoại: Kiểm tra 0 bản ghi mồ côi
    -- Criteria mồ côi
    SELECT count(*) INTO v_orphan_count FROM public.criteria cr WHERE cr.class_id IN (v_class_1, v_class_2) AND NOT EXISTS (SELECT 1 FROM public.classes c WHERE c.id = cr.class_id);
    ASSERT v_orphan_count = 0, '[REH - FAIL]: Phát hiện tiêu chí mồ côi';

    -- Memberships mồ côi
    SELECT count(*) INTO v_orphan_count FROM public.class_memberships cm WHERE cm.class_id IN (v_class_1, v_class_2) AND (NOT EXISTS (SELECT 1 FROM public.classes c WHERE c.id = cm.class_id) OR NOT EXISTS (SELECT 1 FROM public.students s WHERE s.id = cm.student_id));
    ASSERT v_orphan_count = 0, '[REH - FAIL]: Phát hiện membership mồ côi';

    -- Attendance mồ côi
    SELECT count(*) INTO v_orphan_count FROM public.attendance a WHERE a.class_id IN (v_class_1, v_class_2) AND (NOT EXISTS (SELECT 1 FROM public.classes c WHERE c.id = a.class_id) OR NOT EXISTS (SELECT 1 FROM public.students s WHERE s.id = a.student_id));
    ASSERT v_orphan_count = 0, '[REH - FAIL]: Phát hiện attendance mồ côi';

    -- Points mồ côi
    SELECT count(*) INTO v_orphan_count FROM public.student_points p WHERE p.class_id IN (v_class_1, v_class_2) AND (NOT EXISTS (SELECT 1 FROM public.classes c WHERE c.id = p.class_id) OR NOT EXISTS (SELECT 1 FROM public.students s WHERE s.id = p.student_id));
    ASSERT v_orphan_count = 0, '[REH - FAIL]: Phát hiện student_points mồ côi';

    -- Comments mồ côi
    SELECT count(*) INTO v_orphan_count FROM public.weekly_comments w WHERE w.class_id IN (v_class_1, v_class_2) AND (NOT EXISTS (SELECT 1 FROM public.classes c WHERE c.id = w.class_id) OR NOT EXISTS (SELECT 1 FROM public.students s WHERE s.id = w.student_id));
    ASSERT v_orphan_count = 0, '[REH - FAIL]: Phát hiện weekly_comments mồ côi';

    RAISE NOTICE '>>> [REH Đối soát Khóa ngoại - PASS]: Toàn bộ 5 cặp quan hệ khóa ngoại đạt chuẩn 0 mồ côi.';

    -- 8.2. Đối soát tổng điểm thi đua:
    -- 4 giao dịch: +2 +5 -2 -5 = 0 delta
    SELECT COALESCE(sum(delta), 0) INTO v_sum_delta FROM public.student_points WHERE source_id IN ('tx_reh_01', 'tx_reh_02', 'tx_reh_03', 'tx_reh_04');
    ASSERT v_sum_delta = 0, '[REH - FAIL]: Tổng điểm thi đua không bằng 0 (kết quả: ' || v_sum_delta || ')';
    RAISE NOTICE '>>> [REH Đối soát Điểm - PASS]: Tổng điểm thi đua khớp tuyệt đối (Delta = 0).';

    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'DIỄN TẬP DI TRÚ TRÊN POSTGRESQL LOCAL ĐẠT CHUẨN 100%% THÀNH CÔNG!';
    RAISE NOTICE '==============================================================================';
END $$;

ROLLBACK;
