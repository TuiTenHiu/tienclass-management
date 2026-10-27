-- ==============================================================================
-- PINK CLASSROOM - CROSS-TENANT ISOLATION & HELPER SECURITY TEST SUITE (10 CASES)
-- Bổ sung kiểm thử chuyên sâu cho Bước 6:
-- 1. Cô lập dữ liệu chéo giữa Phụ huynh - Phụ huynh và Giáo viên - Giáo viên.
-- 2. Bảo vệ quyền cập nhật học sinh (students_teacher_update & class_memberships):
--    - Chặn sửa/xóa học sinh lớp khác.
--    - Chặn đổi ID học sinh.
--    - Chặn chuyển học sinh sang lớp không thuộc quyền quản lý.
--    - Chặn gắn (hijack) học sinh của lớp khác vào lớp mình (cả khi is_active=TRUE/FALSE).
-- 3. Chống dò quét quan hệ (Oracle/Enumeration) qua các hàm SECURITY DEFINER.
-- 4. Khóa hoàn toàn quyền thực thi từ vai trò anon và khóa gọi trực tiếp hàm trigger.
-- ==============================================================================

BEGIN;

CREATE TEMP TABLE pg_temp.iso_test_results (
    seq_no  SERIAL PRIMARY KEY,
    test_id TEXT UNIQUE NOT NULL,
    passed  BOOLEAN NOT NULL,
    detail  TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION pg_temp.set_iso_jwt(
    p_user_id UUID,
    p_app_role TEXT DEFAULT 'authenticated',
    p_user_meta_role TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', COALESCE(p_user_id::text, ''), true);
    PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM pg_catalog.set_config(
        'request.jwt.claims',
        pg_catalog.json_build_object(
            'sub', p_user_id::text,
            'role', 'authenticated',
            'aud', 'authenticated',
            'app_metadata', pg_catalog.json_build_object('role', p_app_role),
            'user_metadata', CASE
                WHEN p_user_meta_role IS NOT NULL THEN pg_catalog.json_build_object('role', p_user_meta_role)
                ELSE pg_catalog.json_build_object()
            END
        )::text,
        true
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.record_iso_pass(p_test_id TEXT, p_detail TEXT)
RETURNS VOID AS $$
BEGIN
    INSERT INTO pg_temp.iso_test_results (test_id, passed, detail)
    VALUES (p_test_id, TRUE, p_detail);
    RAISE NOTICE '[% - PASS]: %', p_test_id, p_detail;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_temp, pg_catalog;

DO $$
DECLARE
    v_temp_schema TEXT := pg_catalog.pg_my_temp_schema()::regnamespace::text;
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO authenticated, anon', v_temp_schema);
    EXECUTE pg_catalog.format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated', v_temp_schema);
END $$;

GRANT SELECT, INSERT ON TABLE pg_temp.iso_test_results TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.set_iso_jwt(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.record_iso_pass(TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 1. KHỞI TẠO FIXTURE CÔ LẬP HAI LỚP HỌC (LỚP 1A & LỚP 1B)
-- ------------------------------------------------------------------------------
RESET ROLE;

DO $$
DECLARE
    uid_admin UUID := '00000000-0000-0000-0000-000000000000';
    uid_gv01  UUID := '11111111-1111-1111-1111-111111111111';
    uid_gv02  UUID := '22222222-2222-2222-2222-222222222222';
    uid_ph01  UUID := '33333333-3333-3333-3333-333333333333';
    uid_ph02  UUID := '44444444-4444-4444-4444-444444444444';

    cid_lop1a UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    cid_lop1b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    sid_hs01  UUID := '10000000-0000-0000-0000-000000000001';
    sid_hs02  UUID := '20000000-0000-0000-0000-000000000002';
    v_cnt     INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt FROM auth.users WHERE id IN (uid_admin, uid_gv01, uid_gv02, uid_ph01, uid_ph02);
    IF v_cnt > 0 THEN
        RAISE EXCEPTION '[ABORT]: Phát hiện dữ liệu trùng UUID kiểm thử trong auth.users!';
    END IF;

    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
    ) VALUES
        ('00000000-0000-0000-0000-000000000000', uid_admin, 'authenticated', 'authenticated', 'iso_admin@tienclass.local', '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Admin"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_gv01,  'authenticated', 'authenticated', 'iso_gv01@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"GV 1A"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_gv02,  'authenticated', 'authenticated', 'iso_gv02@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"GV 1B"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph01,  'authenticated', 'authenticated', 'iso_ph01@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"PH 1A"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph02,  'authenticated', 'authenticated', 'iso_ph02@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"PH 1B"}'::jsonb, NOW(), NOW(), '', '', '', '');

    UPDATE public.profiles SET role = 'admin'   WHERE id = uid_admin;
    UPDATE public.profiles SET role = 'teacher' WHERE id IN (uid_gv01, uid_gv02);

    INSERT INTO public.classes (id, name, school_year, teacher_id) VALUES
        (cid_lop1a, 'Lớp 1A ISO', '2026-2027', uid_gv01),
        (cid_lop1b, 'Lớp 1B ISO', '2026-2027', uid_gv02);

    INSERT INTO public.students (id, code, full_name) VALUES
        (sid_hs01, 'ISO-HS-1A-001', 'Học Sinh Lớp 1A'),
        (sid_hs02, 'ISO-HS-1B-002', 'Học Sinh Lớp 1B');

    INSERT INTO public.class_memberships (class_id, student_id, is_active) VALUES
        (cid_lop1a, sid_hs01, TRUE),
        (cid_lop1b, sid_hs02, TRUE);

    INSERT INTO public.parent_students (parent_id, student_id, relationship, is_verified, verified_by, verified_at) VALUES
        (uid_ph01, sid_hs01, 'Bố', TRUE, uid_gv01, NOW()),
        (uid_ph02, sid_hs02, 'Mẹ', TRUE, uid_gv02, NOW());

    INSERT INTO public.criteria (class_id, name, points, type) VALUES
        (cid_lop1a, 'Tiêu chí 1A', 5, 'reward'),
        (cid_lop1b, 'Tiêu chí 1B', 5, 'reward');

    INSERT INTO public.attendance (class_id, student_id, date, session, status, recorded_by) VALUES
        (cid_lop1a, sid_hs01, CURRENT_DATE, 'morning', 'present', uid_gv01),
        (cid_lop1b, sid_hs02, CURRENT_DATE, 'morning', 'present', uid_gv02);

    INSERT INTO public.student_points (class_id, student_id, criterion_name, delta, actor_id) VALUES
        (cid_lop1a, sid_hs01, 'Tiêu chí 1A', 5, uid_gv01),
        (cid_lop1b, sid_hs02, 'Tiêu chí 1B', 5, uid_gv02);

    INSERT INTO public.weekly_comments (class_id, student_id, school_year, week_number, date, content, status, teacher_id) VALUES
        (cid_lop1a, sid_hs01, '2026-2027', 1, CURRENT_DATE, 'Nhận xét 1A đã gửi', 'sent', uid_gv01),
        (cid_lop1b, sid_hs02, '2026-2027', 1, CURRENT_DATE, 'Nhận xét 1B đã gửi', 'sent', uid_gv02);
END $$;

-- ------------------------------------------------------------------------------
-- 2. KIỂM THỬ CÔ LẬP DỮ LIỆU PHỤ HUYNH (ISO-01)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_ph01  UUID := '33333333-3333-3333-3333-333333333333';
    uid_ph02  UUID := '44444444-4444-4444-4444-444444444444';
    uid_gv02  UUID := '22222222-2222-2222-2222-222222222222';
    cid_lop1b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    sid_hs02  UUID := '20000000-0000-0000-0000-000000000002';
    v_cnt     INT;
BEGIN
    PERFORM pg_temp.set_iso_jwt(uid_ph01, 'authenticated', NULL);

    -- PH01 không được thấy hồ sơ của PH02 hoặc GV02
    SELECT COUNT(*) INTO v_cnt FROM public.profiles WHERE id IN (uid_ph02, uid_gv02);
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - ISO-01]: PH01 đọc được % hồ sơ của lớp khác!', v_cnt;
    END IF;

    -- PH01 không được thấy Lớp 1B, HS02, memberships 1B, parent_students 1B, criteria 1B, attendance 1B, points 1B, comments 1B
    IF (SELECT COUNT(*) FROM public.classes WHERE id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.students WHERE id = sid_hs02) <> 0
       OR (SELECT COUNT(*) FROM public.class_memberships WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.parent_students WHERE student_id = sid_hs02) <> 0
       OR (SELECT COUNT(*) FROM public.criteria WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.attendance WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.student_points WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.weekly_comments WHERE class_id = cid_lop1b) <> 0 THEN
        RAISE EXCEPTION '[FAIL - ISO-01]: PH01 đọc được dữ liệu nghiệp vụ của Lớp 1B / HS02!';
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-01',
        'Phụ huynh Lớp 1A hoàn toàn bị cô lập (0 bản ghi) trước hồ sơ, học sinh và dữ liệu của Lớp 1B.'
    );
END $$;

RESET ROLE;

-- ------------------------------------------------------------------------------
-- 3. KIỂM THỬ CÔ LẬP GIÁO VIÊN & BẢO VỆ CẬP NHẬT HỌC SINH (ISO-02 .. ISO-08)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01   UUID := '11111111-1111-1111-1111-111111111111';
    uid_gv02   UUID := '22222222-2222-2222-2222-222222222222';
    uid_ph02   UUID := '44444444-4444-4444-4444-444444444444';
    cid_lop1a  UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    cid_lop1b  UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    sid_hs01   UUID := '10000000-0000-0000-0000-000000000001';
    sid_hs02   UUID := '20000000-0000-0000-0000-000000000002';

    v_row_cnt  INT;
    v_sqlstate TEXT;
    v_sqlerrm  TEXT;
BEGIN
    PERFORM pg_temp.set_iso_jwt(uid_gv01, 'authenticated', NULL);

    -- [ISO-02]: GV01 không đọc được bất kỳ dữ liệu nào của Lớp 1B / HS02 / PH02
    IF (SELECT COUNT(*) FROM public.profiles WHERE id IN (uid_ph02, uid_gv02)) <> 0
       OR (SELECT COUNT(*) FROM public.classes WHERE id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.students WHERE id = sid_hs02) <> 0
       OR (SELECT COUNT(*) FROM public.class_memberships WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.parent_students WHERE student_id = sid_hs02) <> 0
       OR (SELECT COUNT(*) FROM public.criteria WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.attendance WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.student_points WHERE class_id = cid_lop1b) <> 0
       OR (SELECT COUNT(*) FROM public.weekly_comments WHERE class_id = cid_lop1b) <> 0 THEN
        RAISE EXCEPTION '[FAIL - ISO-02]: GV01 đọc được dữ liệu của Lớp 1B!';
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-02',
        'Giáo viên Lớp 1A hoàn toàn không đọc được học sinh, phụ huynh và dữ liệu của Lớp 1B.'
    );

    -- [ISO-03]: GV01 không thể UPDATE hoặc DELETE học sinh thuộc Lớp 1B (sid_hs02)
    UPDATE public.students SET full_name = 'Bị sửa trái phép' WHERE id = sid_hs02;
    GET DIAGNOSTICS v_row_cnt = ROW_COUNT;
    IF v_row_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - ISO-03]: GV01 sửa được thông tin học sinh Lớp 1B!';
    END IF;

    DELETE FROM public.students WHERE id = sid_hs02;
    GET DIAGNOSTICS v_row_cnt = ROW_COUNT;
    IF v_row_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - ISO-03]: GV01 xóa được học sinh Lớp 1B!';
    END IF;

    -- [ISO-04]: GV01 cố ý đổi id của học sinh lớp mình sang id khác khi UPDATE
    v_sqlstate := NULL;
    BEGIN
        UPDATE public.students SET id = gen_random_uuid() WHERE id = sid_hs01;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - ISO-04]: Đổi id học sinh không bị chặn bởi RLS WITH CHECK 42501 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-04',
        'Policy students_teacher_update (WITH CHECK) chặn giáo viên thay đổi định danh id của học sinh (SQLSTATE=42501).'
    );

    -- [ISO-05]: GV01 cố ý chuyển học sinh lớp mình sang Lớp 1B không thuộc quyền quản lý
    v_sqlstate := NULL;
    BEGIN
        UPDATE public.class_memberships
        SET class_id = cid_lop1b
        WHERE class_id = cid_lop1a AND student_id = sid_hs01;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' OR v_sqlerrm NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION '[FAIL - ISO-05]: Chuyển học sinh sang lớp khác không bị chặn bởi RLS 42501 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-05',
        'Chặn giáo viên chuyển học sinh sang lớp không thuộc quyền quản lý (SQLSTATE=42501).'
    );

    -- [ISO-06]: GV01 cố ý gắn (hijack) học sinh Lớp 1B (sid_hs02) vào Lớp 1A qua INSERT hoặc UPDATE class_memberships
    v_sqlstate := NULL;
    BEGIN
        INSERT INTO public.class_memberships (class_id, student_id, is_active)
        VALUES (cid_lop1a, sid_hs02, TRUE);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' OR v_sqlerrm NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION '[FAIL - ISO-06 INSERT]: GV01 gắn được học sinh Lớp 1B vào Lớp 1A (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    v_sqlstate := NULL;
    BEGIN
        UPDATE public.class_memberships
        SET student_id = sid_hs02
        WHERE class_id = cid_lop1a AND student_id = sid_hs01;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' OR v_sqlerrm NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION '[FAIL - ISO-06 UPDATE]: GV01 đổi được student_id trong class_memberships sang HS02 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-06',
        'Chặn giáo viên gắn hoặc đánh tráo học sinh thuộc lớp khác vào lớp mình qua class_memberships (SQLSTATE=42501).'
    );

    -- [ISO-07]: GV01 cố ý lợi dụng trạng thái is_active = FALSE để chèn liên kết học sinh lớp khác
    v_sqlstate := NULL;
    BEGIN
        INSERT INTO public.class_memberships (class_id, student_id, is_active)
        VALUES (cid_lop1a, sid_hs02, FALSE);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' OR v_sqlerrm NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION '[FAIL - ISO-07]: GV01 lợi dụng is_active=FALSE để gắn học sinh lớp khác (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-07',
        'Chặn giáo viên lợi dụng trạng thái is_active = FALSE để liên kết học sinh lớp khác (SQLSTATE=42501).'
    );

    -- [ISO-08]: Kiểm tra chống dò quét quan hệ (Oracle/Enumeration) trên tất cả các hàm SECURITY DEFINER
    IF public.is_student_in_class(sid_hs02, cid_lop1b) IS DISTINCT FROM FALSE
       OR public.is_teacher_of_student(sid_hs02) IS DISTINCT FROM FALSE
       OR public.is_verified_parent(sid_hs02) IS DISTINCT FROM FALSE
       OR public.is_verified_parent_in_class(cid_lop1b) IS DISTINCT FROM FALSE
       OR public.is_teacher_of_parent(uid_ph02) IS DISTINCT FROM FALSE
       OR public.is_verified_parent_of_teacher(uid_gv02) IS DISTINCT FROM FALSE
       OR public.can_teacher_link_student(sid_hs02, cid_lop1a) IS DISTINCT FROM FALSE
       OR public.can_teacher_link_student(gen_random_uuid(), cid_lop1a) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '[FAIL - ISO-08]: Một hàm helper SECURITY DEFINER trả về TRUE cho thực thể ngoài phạm vi của người gọi!';
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-08',
        'Toàn bộ các hàm helper SECURITY DEFINER đều trả về FALSE đối với UUID của lớp/học sinh/phụ huynh khác.'
    );
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho ISO-03 (đảm bảo HS02 vẫn nguyên vẹn trong DB)
DO $$
DECLARE
    sid_hs02 UUID := '20000000-0000-0000-0000-000000000002';
    v_name   TEXT;
BEGIN
    SELECT full_name INTO v_name FROM public.students WHERE id = sid_hs02;
    IF v_name IS DISTINCT FROM 'Học Sinh Lớp 1B' THEN
        RAISE EXCEPTION '[FAIL - ISO-03 POST-CHECK]: Học sinh Lớp 1B đã bị sửa hoặc xóa!';
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-03',
        'Chặn GV01 sửa/xóa học sinh Lớp 1B (ROW_COUNT=0) và hậu kiểm dữ liệu HS02 nguyên vẹn.'
    );
END $$;

-- ------------------------------------------------------------------------------
-- 4. KIỂM THỬ KHÓA QUYỀN VAI TRÒ anon & KHÓA GỌI TRỰC TIẾP TRIGGER FUNCTION (ISO-09, ISO-10)
-- ------------------------------------------------------------------------------
SET LOCAL ROLE anon;

DO $$
DECLARE
    v_sqlstate TEXT;
BEGIN
    v_sqlstate := NULL;
    BEGIN
        PERFORM public.is_admin();
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - ISO-09]: Vai trò anon gọi được public.is_admin() (SQLSTATE=%)!', v_sqlstate;
    END IF;

    v_sqlstate := NULL;
    BEGIN
        PERFORM public.is_teacher_of_student(gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - ISO-09]: Vai trò anon gọi được public.is_teacher_of_student() (SQLSTATE=%)!', v_sqlstate;
    END IF;
END $$;

RESET ROLE;

DO $$
BEGIN
    PERFORM pg_temp.record_iso_pass(
        'ISO-09',
        'Vai trò anon bị thu hồi quyền EXECUTE trên các hàm helper SECURITY DEFINER (SQLSTATE=42501).'
    );
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_sqlstate TEXT;
BEGIN
    v_sqlstate := NULL;
    BEGIN
        EXECUTE 'SELECT public.handle_comment_status_and_consistency()';
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - ISO-10]: Vai trò authenticated gọi trực tiếp được trigger function (SQLSTATE=%)!', v_sqlstate;
    END IF;

    PERFORM pg_temp.record_iso_pass(
        'ISO-10',
        'Chặn vai trò authenticated gọi trực tiếp các hàm trigger SECURITY DEFINER (SQLSTATE=42501).'
    );
END $$;

RESET ROLE;

-- ------------------------------------------------------------------------------
-- 5. TỔNG KẾT 10/10 CA KIỂM THỬ CÔ LẬP QUYỀN
-- ------------------------------------------------------------------------------
DO $$
DECLARE
    v_pass_cnt INT;
    r          RECORD;
BEGIN
    SELECT COUNT(*) FILTER (WHERE passed IS TRUE) INTO v_pass_cnt FROM pg_temp.iso_test_results;

    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'BẢNG KẾT QUẢ KIỂM THỬ CÔ LẬP QUYỀN & BẢO MẬT HELPER (10 CA):';
    RAISE NOTICE '------------------------------------------------------------------------------';
    FOR r IN SELECT seq_no, test_id, passed, detail FROM pg_temp.iso_test_results ORDER BY seq_no LOOP
        RAISE NOTICE '#% | % | PASS=% | %', lpad(r.seq_no::text, 2, '0'), r.test_id, r.passed, r.detail;
    END LOOP;
    RAISE NOTICE '------------------------------------------------------------------------------';
    RAISE NOTICE 'TỔNG KẾT CÔ LẬP QUYỀN: %/10 CA ĐẠT', v_pass_cnt;
    RAISE NOTICE '==============================================================================';

    IF v_pass_cnt <> 10 THEN
        RAISE EXCEPTION '[ISOLATION SUITE INCOMPLETE]: Chưa đủ 10/10 ca PASS (thực tế: %).', v_pass_cnt;
    END IF;
END $$;

ROLLBACK;
