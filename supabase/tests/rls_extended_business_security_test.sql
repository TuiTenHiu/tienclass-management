-- ==============================================================================
-- PINK CLASSROOM - EXTENDED BUSINESS & SECURITY AUDIT TEST SUITE (15 TEST CASES)
-- Đối chiếu trực tiếp với: supabase/migrations/20261026000002_secure_schema_v3_hardened.sql
--
-- Phạm vi kiểm thử bổ sung (5 nhóm nghiệp vụ & bảo mật chuyên sâu):
-- 1. RPC create_student_in_class (EXT-01 .. EXT-03):
--    - Giáo viên đúng lớp được phép tạo học sinh kèm class_memberships nguyên tử.
--    - Giáo viên khác lớp và phụ huynh bị từ chối (SQLSTATE = P0001).
-- 2. Phân quyền Admin & Thao tác quản trị quan trọng (EXT-04 .. EXT-06):
--    - Xác minh is_admin() qua profiles.role = 'admin' và JWT app_metadata.role = 'admin'.
--    - Admin thực thi các đặc quyền: tạo HS liên lớp, thu hồi token liên lớp,
--      hoàn tác nhận xét sent -> draft và xóa nhận xét sent.
--    - Kiểm chứng phân tách quyền cập nhật profiles của Admin dưới ROLE authenticated
--      (sửa được thông tin hồ sơ bất kỳ, nhưng cột role bị khóa ở Column Privilege 42501).
-- 3. Chuyển học sinh giữa các lớp cùng giáo viên và khác giáo viên (EXT-07 .. EXT-09):
--    - Cùng giáo viên (Lớp 1A -> Lớp 2A): Giáo viên chuyển lớp thành công.
--    - Khác giáo viên (Lớp 1A <-> Lớp 1B): Chặn giáo viên tự đẩy hoặc tự kéo học sinh (42501).
--    - Khác giáo viên do Admin thực hiện: Thành công và chuyển giao quyền quản lý RLS.
-- 4. Trigger điểm danh (attendance) & điểm thưởng (student_points) (EXT-10 .. EXT-12):
--    - Chặn điểm danh sai lớp hoặc sai học sinh (SQLSTATE = P0001).
--    - Chặn chấm điểm sai lớp, sai học sinh hoặc dùng criterion_id của lớp khác (SQLSTATE = P0001).
--    - Điểm danh và chấm điểm hợp lệ tự động gán recorded_by / actor_id = auth.uid().
-- 5. Vòng đời mã mời phụ huynh (EXT-13 .. EXT-15):
--    - Từ chối mã mời đã hết hạn (expires_at <= NOW()).
--    - Từ chối mã mời đã thu hồi (is_revoked = TRUE) hoặc học sinh đã nghỉ học (is_active = FALSE).
--    - Chống Replay Attack trên mã mời đã sử dụng (used_at IS NOT NULL) và chặn thu hồi lại.
--
-- Toàn bộ kịch bản chạy trong giao dịch BEGIN ... ROLLBACK, không để lại dữ liệu.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 0. KHỞI TẠO BẢNG KẾT QUẢ TẠM & HÀM HỖ TRỢ TRONG SCHEMA TẠM (pg_temp)
-- ------------------------------------------------------------------------------
CREATE TEMP TABLE pg_temp.ext_test_results (
    seq_no      SERIAL PRIMARY KEY,
    test_id     TEXT UNIQUE NOT NULL,
    test_type   TEXT NOT NULL CHECK (test_type IN ('NEG', 'POS')),
    passed      BOOLEAN NOT NULL,
    detail      TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TEMP TABLE pg_temp.ext_test_state (
    key   TEXT PRIMARY KEY,
    val   TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION pg_temp.set_ext_jwt(
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

CREATE OR REPLACE FUNCTION pg_temp.assert_ext_auth(p_expected_uid UUID)
RETURNS VOID AS $$
BEGIN
    IF current_user <> 'authenticated' THEN
        RAISE EXCEPTION '[CONTEXT ERROR]: current_user phải là authenticated (hiện tại: %)', current_user;
    END IF;
    IF session_user <> 'postgres' THEN
        RAISE EXCEPTION '[CONTEXT ERROR]: session_user phải là postgres (hiện tại: %)', session_user;
    END IF;
    IF auth.uid() IS DISTINCT FROM p_expected_uid THEN
        RAISE EXCEPTION '[CONTEXT ERROR]: auth.uid() (%) không khớp với UUID kỳ vọng (%)', auth.uid(), p_expected_uid;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.record_ext_pass(
    p_test_id TEXT,
    p_test_type TEXT,
    p_detail TEXT
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO pg_temp.ext_test_results (test_id, test_type, passed, detail)
    VALUES (p_test_id, p_test_type, TRUE, p_detail);
    RAISE NOTICE '[% - PASS]: %', p_test_id, p_detail;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_temp, pg_catalog;

DO $$
DECLARE
    v_temp_oid    OID;
    v_temp_schema TEXT;
BEGIN
    v_temp_oid := pg_catalog.pg_my_temp_schema();
    IF v_temp_oid IS NULL OR v_temp_oid = 0::oid THEN
        RAISE EXCEPTION '[SETUP ERROR]: Schema tạm (pg_temp) chưa được khởi tạo.';
    END IF;
    v_temp_schema := v_temp_oid::regnamespace::text;
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO authenticated', v_temp_schema);
    EXECUTE pg_catalog.format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated', v_temp_schema);
END $$;

GRANT SELECT, INSERT ON TABLE pg_temp.ext_test_results TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE pg_temp.ext_test_state TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.set_ext_jwt(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.assert_ext_auth(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.record_ext_pass(TEXT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 1. KIỂM TRA XUNG ĐỘT UUID & KHỞI TẠO FIXTURE (CHẠY DƯỚI ROLE postgres)
-- ------------------------------------------------------------------------------
RESET ROLE;

DO $$
DECLARE
    uid_admin   UUID := '00000000-0000-0000-0000-000000000099';
    uid_gv01    UUID := '11111111-1111-1111-1111-111111111199'; -- GV phụ trách Lớp 1A & Lớp 2A
    uid_gv02    UUID := '22222222-2222-2222-2222-222222222299'; -- GV phụ trách Lớp 1B
    uid_ph01    UUID := '33333333-3333-3333-3333-333333333399'; -- PH đã xác minh của HS01 (Lớp 1A)
    uid_ph02    UUID := '44444444-4444-4444-4444-444444444499'; -- PH chưa liên kết (dùng test token)
    uid_ph03    UUID := '55555555-5555-5555-5555-555555555599'; -- PH thứ 3 (dùng test replay token)

    cid_lop1a   UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99'; -- Lớp 1A của GV01
    cid_lop2a   UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc99'; -- Lớp 2A cũng của GV01 (cùng giáo viên)
    cid_lop1b   UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb99'; -- Lớp 1B của GV02 (khác giáo viên)

    sid_hs01    UUID := '10000000-0000-0000-0000-000000000091'; -- Học sinh Lớp 1A
    sid_hs02    UUID := '20000000-0000-0000-0000-000000000092'; -- Học sinh Lớp 1B

    crit_lop1a  UUID := 'c1111111-1111-1111-1111-111111111191'; -- Tiêu chí thuộc Lớp 1A
    crit_lop1b  UUID := 'c2222222-2222-2222-2222-222222222292'; -- Tiêu chí thuộc Lớp 1B

    v_conflict  INT;
BEGIN
    SELECT COUNT(*) INTO v_conflict
    FROM auth.users
    WHERE id IN (uid_admin, uid_gv01, uid_gv02, uid_ph01, uid_ph02, uid_ph03);
    IF v_conflict > 0 THEN
        RAISE EXCEPTION '[ABORT]: Phát hiện % bản ghi trùng UUID kiểm thử trong auth.users!', v_conflict;
    END IF;

    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
    ) VALUES
        ('00000000-0000-0000-0000-000000000000', uid_admin, 'authenticated', 'authenticated', 'ext_admin@tienclass.local', '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Admin Mở Rộng"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_gv01,  'authenticated', 'authenticated', 'ext_gv01@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Cô Mai GV01"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_gv02,  'authenticated', 'authenticated', 'ext_gv02@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Thầy Hùng GV02"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph01,  'authenticated', 'authenticated', 'ext_ph01@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Bố Nam PH01"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph02,  'authenticated', 'authenticated', 'ext_ph02@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Mẹ Lan PH02"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph03,  'authenticated', 'authenticated', 'ext_ph03@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email"}'::jsonb, '{"full_name":"Bố Minh PH03"}'::jsonb, NOW(), NOW(), '', '', '', '');

    UPDATE public.profiles SET role = 'admin'   WHERE id = uid_admin;
    UPDATE public.profiles SET role = 'teacher' WHERE id IN (uid_gv01, uid_gv02);

    INSERT INTO public.classes (id, name, school_year, teacher_id) VALUES
        (cid_lop1a, 'Lớp 1A EXT', '2026-2027', uid_gv01),
        (cid_lop2a, 'Lớp 2A EXT', '2026-2027', uid_gv01),
        (cid_lop1b, 'Lớp 1B EXT', '2026-2027', uid_gv02);

    INSERT INTO public.students (id, code, full_name) VALUES
        (sid_hs01, 'EXT-HS-1A-001', 'Nguyễn Văn Nam'),
        (sid_hs02, 'EXT-HS-1B-002', 'Trần Thị Lan');

    INSERT INTO public.class_memberships (class_id, student_id, is_active) VALUES
        (cid_lop1a, sid_hs01, TRUE),
        (cid_lop1b, sid_hs02, TRUE);

    INSERT INTO public.parent_students (parent_id, student_id, relationship, is_verified, verified_by, verified_at) VALUES
        (uid_ph01, sid_hs01, 'Bố', TRUE, uid_gv01, NOW());

    INSERT INTO public.criteria (id, class_id, name, points, type) VALUES
        (crit_lop1a, cid_lop1a, 'Phát biểu bài 1A', 5, 'reward'),
        (crit_lop1b, cid_lop1b, 'Phát biểu bài 1B', 5, 'reward');

    INSERT INTO public.weekly_comments (class_id, student_id, school_year, week_number, date, content, status, teacher_id) VALUES
        (cid_lop1a, sid_hs01, '2026-2027', 1, CURRENT_DATE, 'Nhận xét nháp 1A', 'draft', uid_gv01),
        (cid_lop1b, sid_hs02, '2026-2027', 1, CURRENT_DATE, 'Nhận xét đã gửi 1B', 'sent', uid_gv02);
END $$;

-- ==============================================================================
-- 2. NHÓM 1: KIỂM THỬ RPC create_student_in_class (EXT-01, EXT-02, EXT-03)
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01       UUID := '11111111-1111-1111-1111-111111111199';
    uid_ph01       UUID := '33333333-3333-3333-3333-333333333399';
    cid_lop1a      UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99';
    cid_lop1b      UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb99';

    v_res          JSONB;
    v_new_sid      UUID;
    v_stu_cnt      INT;
    v_mem_cnt      INT;
    v_sqlstate     TEXT;
    v_sqlerrm      TEXT;
BEGIN
    -- --------------------------------------------------------------------------
    -- [EXT-01 (POS)]: Giáo viên đúng lớp (uid_gv01 -> cid_lop1a) gọi create_student_in_class
    -- Kỳ vọng: Tạo thành công học sinh + liên kết class_memberships (is_active=TRUE),
    --          giáo viên đọc và sửa được ngay học sinh mới qua RLS.
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_gv01);

    v_res := public.create_student_in_class(
        cid_lop1a,
        'EXT-HS-NEW-01',
        'Lê Hoàng Bảo',
        'male'::public.gender_type,
        '2018-06-01'::date,
        'bear-sky',
        'Học sinh mới tạo qua RPC',
        'Lê Văn Hùng (Bố Bảo)',
        '0912345678'
    );

    IF v_res IS NULL OR (v_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - EXT-01]: GV01 gọi create_student_in_class thất bại: %', v_res;
    END IF;

    v_new_sid := (v_res->>'student_id')::uuid;
    IF v_new_sid IS NULL THEN
        RAISE EXCEPTION '[FAIL - EXT-01]: create_student_in_class không trả về student_id hợp lệ!';
    END IF;

    -- Hậu kiểm dưới quyền GV01: Đọc được học sinh mới (kèm parent_name, parent_phone) và bản ghi class_memberships
    SELECT COUNT(*) INTO v_stu_cnt
    FROM public.students
    WHERE id = v_new_sid
      AND code = 'EXT-HS-NEW-01'
      AND parent_name = 'Lê Văn Hùng (Bố Bảo)'
      AND parent_phone = '0912345678';
    SELECT COUNT(*) INTO v_mem_cnt FROM public.class_memberships WHERE class_id = cid_lop1a AND student_id = v_new_sid AND is_active = TRUE;

    IF v_stu_cnt <> 1 OR v_mem_cnt <> 1 THEN
        RAISE EXCEPTION '[FAIL - EXT-01]: GV01 không đọc được học sinh mới tạo (kèm parent_name/parent_phone) hoặc thiếu class_memberships (stu=%, mem=%).', v_stu_cnt, v_mem_cnt;
    END IF;

    -- GV01 cập nhật được ngay học sinh vừa tạo
    UPDATE public.students SET note = 'Đã cập nhật hồ sơ' WHERE id = v_new_sid;
    IF NOT FOUND THEN
        RAISE EXCEPTION '[FAIL - EXT-01]: GV01 không UPDATE được học sinh vừa tạo qua create_student_in_class!';
    END IF;

    INSERT INTO pg_temp.ext_test_state (key, val) VALUES ('v_new_sid', v_new_sid::text);

    PERFORM pg_temp.record_ext_pass(
        'EXT-01', 'POS',
        format('GV01 tạo học sinh mới qua create_student_in_class thành công (student_id=%s) kèm class_memberships.', v_new_sid)
    );

    -- --------------------------------------------------------------------------
    -- [EXT-02 (NEG)]: Giáo viên khác lớp (uid_gv01 -> cid_lop1b của GV02) gọi create_student_in_class
    -- Kỳ vọng: Bị chặn với SQLSTATE = 'P0001'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        PERFORM public.create_student_in_class(
            cid_lop1b,
            'EXT-HS-ILLEGAL-01',
            'Học Sinh Trái Phép GV',
            'female'::public.gender_type
        );
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Bạn không phải là giáo viên phụ trách lớp này%' THEN
        RAISE EXCEPTION '[FAIL - EXT-02]: GV01 tạo học sinh vào Lớp 1B không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    -- --------------------------------------------------------------------------
    -- [EXT-03 (NEG)]: Phụ huynh (uid_ph01) gọi create_student_in_class
    -- Kỳ vọng: Bị chặn với SQLSTATE = 'P0001'.
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_ph01, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_ph01);

    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        PERFORM public.create_student_in_class(
            cid_lop1a,
            'EXT-HS-ILLEGAL-02',
            'Học Sinh Trái Phép PH',
            'male'::public.gender_type
        );
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Bạn không phải là giáo viên phụ trách lớp này%' THEN
        RAISE EXCEPTION '[FAIL - EXT-03]: Phụ huynh gọi create_student_in_class không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho EXT-02 và EXT-03
DO $$
DECLARE
    v_cnt INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt
    FROM public.students
    WHERE code IN ('EXT-HS-ILLEGAL-01', 'EXT-HS-ILLEGAL-02');

    IF v_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - EXT-02/03 POST-CHECK]: Tồn tại % học sinh tạo trái phép trong DB!', v_cnt;
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-02', 'NEG',
        'Chặn giáo viên Lớp 1A gọi create_student_in_class vào Lớp 1B (SQLSTATE=P0001) và hậu kiểm 0 bản ghi.'
    );
    PERFORM pg_temp.record_ext_pass(
        'EXT-03', 'NEG',
        'Chặn phụ huynh gọi create_student_in_class (SQLSTATE=P0001) và hậu kiểm 0 bản ghi.'
    );
END $$;

-- ==============================================================================
-- 3. NHÓM 2: KIỂM THỬ PHÂN QUYỀN ADMIN & THAO TÁC QUẢN TRỊ (EXT-04, EXT-05, EXT-06)
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_admin      UUID := '00000000-0000-0000-0000-000000000099';
    uid_gv01       UUID := '11111111-1111-1111-1111-111111111199';
    uid_ph02       UUID := '44444444-4444-4444-4444-444444444499';
    cid_lop1b      UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb99';
    sid_hs02       UUID := '20000000-0000-0000-0000-000000000092';

    v_res          JSONB;
    v_admin_sid    UUID;
    v_tok_admin_id UUID;
    v_cmt_1b_id    UUID;
    v_sqlstate     TEXT;
    v_sqlerrm      TEXT;
    v_phone        TEXT;
BEGIN
    -- --------------------------------------------------------------------------
    -- [EXT-04 (POS)]: Kiểm tra nhận diện Admin (qua profiles.role = 'admin' và qua app_metadata.role = 'admin')
    --                 và quyền đọc toàn cục trên tất cả các bảng (kể cả nhận xét draft của mọi lớp)
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_admin, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_admin);

    IF public.is_admin() IS DISTINCT FROM TRUE OR public.get_current_role() IS DISTINCT FROM 'admin'::public.user_role THEN
        RAISE EXCEPTION '[FAIL - EXT-04]: Không nhận diện đúng quyền admin từ bảng profiles!';
    END IF;

    -- Kiểm tra nhánh app_metadata.role = 'admin' (khi JWT được cấp bởi service_role)
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'admin', NULL);
    IF public.is_admin() IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - EXT-04]: Không nhận diện đúng quyền admin từ JWT app_metadata.role = admin!';
    END IF;

    -- Trả lại ngữ cảnh chuẩn của uid_admin
    PERFORM pg_temp.set_ext_jwt(uid_admin, 'authenticated', NULL);

    IF (SELECT COUNT(*) FROM public.profiles) <> 6
       OR (SELECT COUNT(*) FROM public.classes) <> 3
       OR (SELECT COUNT(*) FROM public.weekly_comments WHERE status = 'draft') < 1 THEN
        RAISE EXCEPTION '[FAIL - EXT-04]: Admin không đọc được toàn bộ profiles, classes hoặc nhận xét draft!';
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-04', 'POS',
        'Xác minh public.is_admin() = TRUE (qua profiles.role và app_metadata) và Admin đọc được toàn bộ dữ liệu liên lớp.'
    );

    -- --------------------------------------------------------------------------
    -- [EXT-05 (POS)]: Admin thực hiện các thao tác quản trị đặc quyền:
    --   (a) Tạo học sinh vào Lớp 1B qua create_student_in_class
    --   (b) Tạo và thu hồi token của Lớp 1B qua revoke_parent_invitation
    --   (c) Hoàn tác nhận xét đã gửi (sent -> draft) và xóa nhận xét đã gửi
    -- --------------------------------------------------------------------------
    v_res := public.create_student_in_class(
        cid_lop1b,
        'EXT-HS-ADMIN-01',
        'Học Sinh Do Admin Thêm',
        'female'::public.gender_type
    );
    v_admin_sid := (v_res->>'student_id')::uuid;
    IF (v_res->>'ok')::boolean IS DISTINCT FROM TRUE OR v_admin_sid IS NULL THEN
        RAISE EXCEPTION '[FAIL - EXT-05A]: Admin không tạo được học sinh vào Lớp 1B qua RPC!';
    END IF;

    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
    VALUES (
        cid_lop1b,
        sid_hs02,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('admin_managed_token_1234567890', 'UTF8')), 'hex')
    )
    RETURNING id INTO v_tok_admin_id;

    v_res := public.revoke_parent_invitation(v_tok_admin_id);
    IF (v_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - EXT-05B]: Admin không thu hồi được token qua revoke_parent_invitation: %', v_res;
    END IF;

    -- Lấy nhận xét đã gửi (status = 'sent') của Lớp 1B để Admin hoàn tác về 'draft' rồi gửi lại và xóa
    SELECT id INTO v_cmt_1b_id FROM public.weekly_comments WHERE class_id = cid_lop1b AND status = 'sent' LIMIT 1;
    IF v_cmt_1b_id IS NULL THEN
        RAISE EXCEPTION '[FAIL - EXT-05C]: Không tìm thấy nhận xét sent của Lớp 1B!';
    END IF;

    UPDATE public.weekly_comments SET status = 'draft' WHERE id = v_cmt_1b_id;
    IF (SELECT status FROM public.weekly_comments WHERE id = v_cmt_1b_id) IS DISTINCT FROM 'draft'::public.comment_status THEN
        RAISE EXCEPTION '[FAIL - EXT-05C]: Admin không hoàn tác được nhận xét sent về draft!';
    END IF;

    UPDATE public.weekly_comments SET status = 'sent' WHERE id = v_cmt_1b_id;
    DELETE FROM public.weekly_comments WHERE id = v_cmt_1b_id;
    IF EXISTS (SELECT 1 FROM public.weekly_comments WHERE id = v_cmt_1b_id) THEN
        RAISE EXCEPTION '[FAIL - EXT-05C]: Admin không xóa được nhận xét đã gửi (status = sent)!';
    END IF;

    -- Khôi phục lại 1 nhận xét sent cho Lớp 1B để giữ nguyên trạng thái fixture
    INSERT INTO public.weekly_comments (id, class_id, student_id, school_year, week_number, date, content, status, teacher_id)
    VALUES (v_cmt_1b_id, cid_lop1b, sid_hs02, '2026-2027', 1, CURRENT_DATE, 'Nhận xét đã gửi 1B', 'sent', uid_admin);

    PERFORM pg_temp.record_ext_pass(
        'EXT-05', 'POS',
        'Admin thực thi thành công các đặc quyền: tạo HS liên lớp, thu hồi token liên lớp, hoàn tác sent->draft và xóa nhận xét sent.'
    );

    -- --------------------------------------------------------------------------
    -- [EXT-06 (NEG/AUDIT)]: Kiểm tra cập nhật profiles dưới quyền Admin (ROLE authenticated):
    --   - Admin sửa được thông tin cá nhân (phone, full_name) của người dùng khác nhờ profiles_admin_all.
    --   - Cột role vẫn bị khóa bởi Column-Level Privilege (42501) đối với ROLE authenticated
    --     (chỉ postgres / service_role mới có quyền UPDATE trực tiếp cột profiles.role).
    -- --------------------------------------------------------------------------
    UPDATE public.profiles SET phone = '0988777666' WHERE id = uid_ph02;
    SELECT phone INTO v_phone FROM public.profiles WHERE id = uid_ph02;
    IF v_phone IS DISTINCT FROM '0988777666' THEN
        RAISE EXCEPTION '[FAIL - EXT-06]: Admin không cập nhật được cột phone trên hồ sơ của người dùng khác!';
    END IF;

    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        UPDATE public.profiles SET role = 'teacher' WHERE id = uid_ph02;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - EXT-06]: Cột profiles.role không bị khóa bởi Column Privilege 42501 dưới ROLE authenticated (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-06', 'NEG',
        'Admin (ROLE authenticated) sửa được thông tin hồ sơ bất kỳ nhưng cột profiles.role được khóa cứng ở Column Privilege (SQLSTATE=42501).'
    );
END $$;

RESET ROLE;

-- ==============================================================================
-- 4. NHÓM 3: KIỂM THỬ CHUYỂN HỌC SINH CÙNG GIÁO VIÊN & KHÁC GIÁO VIÊN (EXT-07 .. EXT-09)
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_admin   UUID := '00000000-0000-0000-0000-000000000099';
    uid_gv01    UUID := '11111111-1111-1111-1111-111111111199';
    uid_gv02    UUID := '22222222-2222-2222-2222-222222222299';
    cid_lop1a   UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99';
    cid_lop2a   UUID := 'cccccccc-cccc-cccc-cccc-cccccccccc99';
    cid_lop1b   UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb99';

    v_new_sid   UUID;
    v_sqlstate  TEXT;
    v_sqlerrm   TEXT;
BEGIN
    SELECT val::uuid INTO v_new_sid FROM pg_temp.ext_test_state WHERE key = 'v_new_sid';

    -- --------------------------------------------------------------------------
    -- [EXT-07 (POS)]: Giáo viên (uid_gv01) chuyển học sinh (v_new_sid) từ Lớp 1A sang Lớp 2A
    --                 (cả 2 lớp đều do uid_gv01 phụ trách)
    -- Kỳ vọng: UPDATE class_memberships thành công, học sinh thuộc Lớp 2A và GV01 vẫn quản lý được.
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_gv01);

    UPDATE public.class_memberships
    SET class_id = cid_lop2a
    WHERE class_id = cid_lop1a AND student_id = v_new_sid;

    IF NOT FOUND THEN
        RAISE EXCEPTION '[FAIL - EXT-07]: GV01 không chuyển được học sinh giữa hai lớp cùng do mình phụ trách (1A -> 2A)!';
    END IF;

    IF public.is_student_in_class(v_new_sid, cid_lop2a) IS DISTINCT FROM TRUE
       OR public.is_student_in_class(v_new_sid, cid_lop1a) IS DISTINCT FROM FALSE
       OR public.is_teacher_of_student(v_new_sid) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - EXT-07]: Trạng thái thành viên lớp sau khi chuyển cùng giáo viên (1A -> 2A) không chính xác!';
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-07', 'POS',
        'Giáo viên chuyển học sinh giữa hai lớp do chính mình phụ trách (Lớp 1A -> Lớp 2A) thành công.'
    );

    -- --------------------------------------------------------------------------
    -- [EXT-08 (NEG)]: Chuyển học sinh giữa hai lớp KHÁC giáo viên do giáo viên tự thực hiện:
    --   (a) GV01 cố đẩy học sinh từ Lớp 2A sang Lớp 1B của GV02 -> chặn 42501
    --   (b) GV02 cố kéo học sinh đang ở Lớp 2A của GV01 về Lớp 1B -> chặn 42501
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    BEGIN
        UPDATE public.class_memberships
        SET class_id = cid_lop1b
        WHERE class_id = cid_lop2a AND student_id = v_new_sid;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - EXT-08A]: GV01 đẩy được học sinh sang Lớp 1B của GV02 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    -- Chuyển sang ngữ cảnh GV02 cố kéo v_new_sid vào Lớp 1B
    PERFORM pg_temp.set_ext_jwt(uid_gv02, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_gv02);

    v_sqlstate := NULL;
    BEGIN
        INSERT INTO public.class_memberships (class_id, student_id, is_active)
        VALUES (cid_lop1b, v_new_sid, TRUE);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION '[FAIL - EXT-08B]: GV02 tự kéo được học sinh của GV01 vào Lớp 1B (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-08', 'NEG',
        'Chặn cả hai chiều giáo viên tự ý đẩy hoặc kéo học sinh giữa các lớp khác giáo viên (SQLSTATE=42501).'
    );

    -- --------------------------------------------------------------------------
    -- [EXT-09 (POS)]: Admin (uid_admin) thực hiện chuyển học sinh (v_new_sid)
    --                 từ Lớp 2A (của GV01) sang Lớp 1B (của GV02)
    -- Kỳ vọng: Thành công; sau khi chuyển, GV02 có quyền quản lý v_new_sid, còn GV01 hết quyền.
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_admin, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_admin);

    UPDATE public.class_memberships
    SET class_id = cid_lop1b
    WHERE class_id = cid_lop2a AND student_id = v_new_sid;

    IF NOT FOUND THEN
        RAISE EXCEPTION '[FAIL - EXT-09]: Admin không chuyển được học sinh từ Lớp 2A (GV01) sang Lớp 1B (GV02)!';
    END IF;

    -- Kiểm tra dưới quyền GV02: Đã nhìn thấy và quản lý được v_new_sid
    PERFORM pg_temp.set_ext_jwt(uid_gv02, 'authenticated', NULL);
    IF public.is_teacher_of_student(v_new_sid) IS DISTINCT FROM TRUE
       OR (SELECT COUNT(*) FROM public.students WHERE id = v_new_sid) <> 1 THEN
        RAISE EXCEPTION '[FAIL - EXT-09]: Sau khi Admin chuyển lớp, GV02 vẫn không thấy học sinh mới chuyển đến!';
    END IF;

    -- Kiểm tra dưới quyền GV01: Không còn quyền trên v_new_sid
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    IF public.is_teacher_of_student(v_new_sid) IS DISTINCT FROM FALSE
       OR (SELECT COUNT(*) FROM public.students WHERE id = v_new_sid) <> 0 THEN
        RAISE EXCEPTION '[FAIL - EXT-09]: Sau khi Admin chuyển học sinh sang Lớp 1B, GV01 vẫn còn quyền truy cập!';
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-09', 'POS',
        'Admin chuyển học sinh giữa hai lớp khác giáo viên (Lớp 2A -> Lớp 1B) thành công và chuyển giao đúng quyền RLS.'
    );
END $$;

RESET ROLE;

-- ==============================================================================
-- 5. NHÓM 4: TRIGGER ĐIỂM DANH & ĐIỂM THƯỞNG SAI LỚP / SAI TIÊU CHÍ (EXT-10 .. EXT-12)
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01    UUID := '11111111-1111-1111-1111-111111111199';
    cid_lop1a   UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99';
    cid_lop1b   UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb99';
    sid_hs01    UUID := '10000000-0000-0000-0000-000000000091';
    sid_hs02    UUID := '20000000-0000-0000-0000-000000000092';
    crit_lop1a  UUID := 'c1111111-1111-1111-1111-111111111191';
    crit_lop1b  UUID := 'c2222222-2222-2222-2222-222222222292';

    v_att_id    UUID;
    v_pt_id     UUID;
    v_rec_by    UUID;
    v_actor_id  UUID;
    v_sqlstate  TEXT;
    v_sqlerrm   TEXT;
BEGIN
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_gv01);

    -- --------------------------------------------------------------------------
    -- [EXT-10 (NEG)]: Trigger điểm danh (trg_validate_attendance_consistency)
    --   (a) GV01 điểm danh vào Lớp 1B (sai lớp) -> chặn P0001
    --   (b) GV01 điểm danh tại Lớp 1A nhưng truyền student_id = sid_hs02 (học sinh Lớp 1B) -> chặn P0001
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.attendance (class_id, student_id, date, session, status)
        VALUES (cid_lop1b, sid_hs02, CURRENT_DATE, 'morning', 'present');
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Bạn không phải giáo viên phụ trách lớp này để điểm danh%' THEN
        RAISE EXCEPTION '[FAIL - EXT-10A]: Điểm danh sai lớp không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.attendance (class_id, student_id, date, session, status)
        VALUES (cid_lop1a, sid_hs02, CURRENT_DATE, 'morning', 'present');
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Học sinh không thuộc lớp học này%' THEN
        RAISE EXCEPTION '[FAIL - EXT-10B]: Điểm danh học sinh lớp khác vào lớp mình không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    -- --------------------------------------------------------------------------
    -- [EXT-11 (NEG)]: Trigger điểm thưởng (trg_validate_student_points_consistency)
    --   (a) GV01 chấm điểm vào Lớp 1B (sai lớp) -> chặn P0001
    --   (b) GV01 chấm điểm tại Lớp 1A nhưng truyền student_id = sid_hs02 (sai học sinh) -> chặn P0001
    --   (c) GV01 chấm điểm tại Lớp 1A cho sid_hs01 nhưng dùng criterion_id = crit_lop1b (tiêu chí lớp khác) -> chặn P0001
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta)
        VALUES (cid_lop1b, sid_hs02, crit_lop1b, 'Phát biểu bài 1B', 5);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Bạn không phải giáo viên phụ trách lớp này để chấm điểm%' THEN
        RAISE EXCEPTION '[FAIL - EXT-11A]: Chấm điểm sai lớp không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta)
        VALUES (cid_lop1a, sid_hs02, crit_lop1a, 'Phát biểu bài 1A', 5);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Học sinh không thuộc lớp học được chấm điểm%' THEN
        RAISE EXCEPTION '[FAIL - EXT-11B]: Chấm điểm cho học sinh lớp khác không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta)
        VALUES (cid_lop1a, sid_hs01, crit_lop1b, 'Tiêu chí mượn từ Lớp 1B', 5);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_sqlerrm NOT LIKE '%Tiêu chí thi đua được chọn không thuộc lớp học này%' THEN
        RAISE EXCEPTION '[FAIL - EXT-11C]: Chấm điểm với criterion_id của lớp khác không bị chặn đúng P0001 (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    -- --------------------------------------------------------------------------
    -- [EXT-12 (POS)]: GV01 điểm danh và chấm điểm hợp lệ cho sid_hs01 tại Lớp 1A với crit_lop1a
    -- Kỳ vọng: Thành công, trigger tự động gán recorded_by = uid_gv01 và actor_id = uid_gv01.
    -- --------------------------------------------------------------------------
    INSERT INTO public.attendance (class_id, student_id, date, session, status, note)
    VALUES (cid_lop1a, sid_hs01, CURRENT_DATE, 'morning', 'present', 'Đi học đúng giờ')
    RETURNING id, recorded_by INTO v_att_id, v_rec_by;

    IF v_att_id IS NULL OR v_rec_by IS DISTINCT FROM uid_gv01 THEN
        RAISE EXCEPTION '[FAIL - EXT-12A]: Điểm danh hợp lệ thất bại hoặc recorded_by (%) <> uid_gv01!', v_rec_by;
    END IF;

    INSERT INTO public.student_points (class_id, student_id, criterion_id, criterion_name, delta, note)
    VALUES (cid_lop1a, sid_hs01, crit_lop1a, 'Phát biểu bài 1A', 5, 'Xung phong lên bảng')
    RETURNING id, actor_id INTO v_pt_id, v_actor_id;

    IF v_pt_id IS NULL OR v_actor_id IS DISTINCT FROM uid_gv01 THEN
        RAISE EXCEPTION '[FAIL - EXT-12B]: Chấm điểm hợp lệ thất bại hoặc actor_id (%) <> uid_gv01!', v_actor_id;
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-12', 'POS',
        'Điểm danh và chấm điểm hợp lệ thành công, trigger tự động điền recorded_by và actor_id = auth.uid().'
    );
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho EXT-10 và EXT-11
DO $$
DECLARE
    cid_lop1a  UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99';
    cid_lop1b  UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb99';
    sid_hs02   UUID := '20000000-0000-0000-0000-000000000092';
    crit_lop1b UUID := 'c2222222-2222-2222-2222-222222222292';
    v_bad_att  INT;
    v_bad_pt   INT;
BEGIN
    SELECT COUNT(*) INTO v_bad_att
    FROM public.attendance
    WHERE class_id = cid_lop1b OR student_id = sid_hs02;

    SELECT COUNT(*) INTO v_bad_pt
    FROM public.student_points
    WHERE class_id = cid_lop1b OR student_id = sid_hs02 OR criterion_id = crit_lop1b;

    IF v_bad_att <> 0 OR v_bad_pt <> 0 THEN
        RAISE EXCEPTION '[FAIL - EXT-10/11 POST-CHECK]: Phát hiện dữ liệu điểm danh/điểm thưởng sai phạm lọt vào DB (att=%, pt=%)!', v_bad_att, v_bad_pt;
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-10', 'NEG',
        'Trigger trg_validate_attendance_consistency chặn điểm danh sai lớp / sai học sinh (P0001) và hậu kiểm 0 bản ghi.'
    );
    PERFORM pg_temp.record_ext_pass(
        'EXT-11', 'NEG',
        'Trigger trg_validate_student_points_consistency chặn chấm điểm sai lớp / sai học sinh / sai tiêu chí (P0001) và hậu kiểm 0 bản ghi.'
    );
END $$;

-- ==============================================================================
-- 6. NHÓM 5: VÒNG ĐỜI MÃ MỜI PHỤ HUYNH — HẾT HẠN, THU HỒI, ĐÃ DÙNG (EXT-13 .. EXT-15)
-- ==============================================================================
-- Bước 6A: GV01 phát hành 4 mã mời cho sid_hs01 (Lớp 1A):
--   1. Mã đã hết hạn (expires_at = NOW() - INTERVAL '2 hours')
--   2. Mã bị thu hồi (is_revoked = TRUE qua revoke_parent_invitation)
--   3. Mã hợp lệ để PH02 tiêu thụ, sau đó PH03 thử dùng lại (Replay Attack)
--   4. Mã cho học sinh sau đó bị chuyển sang trạng thái ngừng hoạt động (class_memberships.is_active = FALSE)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01         UUID := '11111111-1111-1111-1111-111111111199';
    cid_lop1a        UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99';
    sid_hs01         UUID := '10000000-0000-0000-0000-000000000091';

    v_raw_expired    TEXT := 'ext_token_expired_1234567890abcdef';
    v_raw_revoked    TEXT := 'ext_token_revoked_1234567890abcdef';
    v_raw_used       TEXT := 'ext_token_used_once_1234567890abcd';
    v_raw_inactive   TEXT := 'ext_token_inactive_stu_1234567890';

    v_id_expired     UUID;
    v_id_revoked     UUID;
    v_id_used        UUID;
    v_id_inactive    UUID;
    v_rev_res        JSONB;
BEGIN
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_gv01);

    -- 1. Tạo token đã hết hạn
    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash, expires_at)
    VALUES (
        cid_lop1a,
        sid_hs01,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_raw_expired, 'UTF8')), 'hex'),
        NOW() - INTERVAL '2 hours'
    )
    RETURNING id INTO v_id_expired;

    -- 2. Tạo token rồi thu hồi ngay qua RPC revoke_parent_invitation
    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
    VALUES (
        cid_lop1a,
        sid_hs01,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_raw_revoked, 'UTF8')), 'hex')
    )
    RETURNING id INTO v_id_revoked;

    v_rev_res := public.revoke_parent_invitation(v_id_revoked);
    IF (v_rev_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[SETUP ERROR]: Không thu hồi được token v_id_revoked: %', v_rev_res;
    END IF;

    -- 3. Tạo token hợp lệ để kiểm thử sử dụng 1 lần & chống Replay
    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
    VALUES (
        cid_lop1a,
        sid_hs01,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_raw_used, 'UTF8')), 'hex')
    )
    RETURNING id INTO v_id_used;

    -- 4. Tạo token cho kịch bản học sinh ngừng hoạt động trong lớp
    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
    VALUES (
        cid_lop1a,
        sid_hs01,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_raw_inactive, 'UTF8')), 'hex')
    )
    RETURNING id INTO v_id_inactive;

    INSERT INTO pg_temp.ext_test_state (key, val) VALUES
        ('v_raw_expired',  v_raw_expired),
        ('v_raw_revoked',  v_raw_revoked),
        ('v_raw_used',     v_raw_used),
        ('v_raw_inactive', v_raw_inactive),
        ('v_id_expired',   v_id_expired::text),
        ('v_id_revoked',   v_id_revoked::text),
        ('v_id_used',      v_id_used::text),
        ('v_id_inactive',  v_id_inactive::text);
END $$;

RESET ROLE;

-- Bước 6B: Thực thi kiểm thử EXT-13, EXT-14, EXT-15
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01         UUID := '11111111-1111-1111-1111-111111111199';
    uid_ph02         UUID := '44444444-4444-4444-4444-444444444499';
    uid_ph03         UUID := '55555555-5555-5555-5555-555555555599';
    cid_lop1a        UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99';
    sid_hs01         UUID := '10000000-0000-0000-0000-000000000091';

    v_raw_expired    TEXT;
    v_raw_revoked    TEXT;
    v_raw_used       TEXT;
    v_raw_inactive   TEXT;
    v_id_used        UUID;

    v_res            JSONB;
BEGIN
    SELECT val INTO v_raw_expired  FROM pg_temp.ext_test_state WHERE key = 'v_raw_expired';
    SELECT val INTO v_raw_revoked  FROM pg_temp.ext_test_state WHERE key = 'v_raw_revoked';
    SELECT val INTO v_raw_used     FROM pg_temp.ext_test_state WHERE key = 'v_raw_used';
    SELECT val INTO v_raw_inactive FROM pg_temp.ext_test_state WHERE key = 'v_raw_inactive';
    SELECT val::uuid INTO v_id_used FROM pg_temp.ext_test_state WHERE key = 'v_id_used';

    -- --------------------------------------------------------------------------
    -- [EXT-13 (NEG)]: PH02 gọi claim_parent_invitation với mã mời ĐÃ HẾT HẠN
    -- Kỳ vọng: {"ok": false, "message": "Mã liên kết này đã hết hạn hiệu lực."}
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_ph02, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_ph02);

    v_res := public.claim_parent_invitation(v_raw_expired);
    IF v_res IS NULL
       OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE
       OR COALESCE(v_res->>'message', '') NOT LIKE '%hết hạn%' THEN
        RAISE EXCEPTION '[FAIL - EXT-13]: Mã mời hết hạn không bị từ chối đúng kỳ vọng: %', v_res;
    END IF;

    -- --------------------------------------------------------------------------
    -- [EXT-14 (NEG)]: PH02 gọi claim_parent_invitation với:
    --   (a) Mã mời ĐÃ BỊ THU HỒI (is_revoked = TRUE)
    --   (b) Mã mời của học sinh đang ngừng hoạt động trong lớp (is_active = FALSE)
    -- --------------------------------------------------------------------------
    v_res := public.claim_parent_invitation(v_raw_revoked);
    IF v_res IS NULL
       OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE
       OR COALESCE(v_res->>'message', '') NOT LIKE '%thu hồi%' THEN
        RAISE EXCEPTION '[FAIL - EXT-14A]: Mã mời đã thu hồi không bị từ chối đúng kỳ vọng: %', v_res;
    END IF;

    -- Tạm thời đặt class_memberships.is_active = FALSE dưới quyền GV01 để kiểm tra nhánh học sinh nghỉ học
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    UPDATE public.class_memberships SET is_active = FALSE WHERE class_id = cid_lop1a AND student_id = sid_hs01;

    PERFORM pg_temp.set_ext_jwt(uid_ph02, 'authenticated', NULL);
    v_res := public.claim_parent_invitation(v_raw_inactive);
    IF v_res IS NULL
       OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE
       OR COALESCE(v_res->>'message', '') NOT LIKE '%không còn hoạt động%' THEN
        RAISE EXCEPTION '[FAIL - EXT-14B]: Mã mời của học sinh ngừng hoạt động không bị từ chối đúng kỳ vọng: %', v_res;
    END IF;

    -- Khôi phục lại is_active = TRUE dưới quyền GV01
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    UPDATE public.class_memberships SET is_active = TRUE WHERE class_id = cid_lop1a AND student_id = sid_hs01;

    -- --------------------------------------------------------------------------
    -- [EXT-15 (NEG)]: Kiểm thử mã mời ĐÃ QUA SỬ DỤNG (Replay Attack & Chặn thu hồi lại):
    --   1. PH02 kích hoạt v_raw_used lần đầu -> Thành công (ok = true).
    --   2. PH03 dùng lại chính v_raw_used -> Bị từ chối ("...đã được sử dụng trước đó.").
    --   3. GV01 gọi revoke_parent_invitation(v_id_used) -> Bị từ chối ("...đã được phụ huynh sử dụng, không thể thu hồi.").
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_ext_jwt(uid_ph02, 'authenticated', NULL);
    v_res := public.claim_parent_invitation(v_raw_used);
    IF v_res IS NULL OR (v_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - EXT-15 STEP 1]: PH02 kích hoạt token hợp lệ lần đầu thất bại: %', v_res;
    END IF;

    -- PH03 thử kích hoạt lại token đã dùng
    PERFORM pg_temp.set_ext_jwt(uid_ph03, 'authenticated', NULL);
    PERFORM pg_temp.assert_ext_auth(uid_ph03);

    v_res := public.claim_parent_invitation(v_raw_used);
    IF v_res IS NULL
       OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE
       OR COALESCE(v_res->>'message', '') NOT LIKE '%đã được sử dụng trước đó%' THEN
        RAISE EXCEPTION '[FAIL - EXT-15 STEP 2]: PH03 dùng lại token đã sử dụng không bị chặn đúng kỳ vọng: %', v_res;
    END IF;

    -- GV01 thử thu hồi token đã sử dụng
    PERFORM pg_temp.set_ext_jwt(uid_gv01, 'authenticated', NULL);
    v_res := public.revoke_parent_invitation(v_id_used);
    IF v_res IS NULL
       OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE
       OR COALESCE(v_res->>'message', '') NOT LIKE '%đã được phụ huynh sử dụng, không thể thu hồi%' THEN
        RAISE EXCEPTION '[FAIL - EXT-15 STEP 3]: GV01 thu hồi token đã qua sử dụng không bị chặn đúng kỳ vọng: %', v_res;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho EXT-13, EXT-14, EXT-15
DO $$
DECLARE
    uid_ph02       UUID := '44444444-4444-4444-4444-444444444499';
    uid_ph03       UUID := '55555555-5555-5555-5555-555555555599';
    v_id_expired   UUID;
    v_id_revoked   UUID;
    v_id_used      UUID;
    v_id_inactive  UUID;
    v_rec_exp      RECORD;
    v_rec_rev      RECORD;
    v_rec_inact    RECORD;
    v_rec_used     RECORD;
    v_ph03_cnt     INT;
BEGIN
    SELECT val::uuid INTO v_id_expired  FROM pg_temp.ext_test_state WHERE key = 'v_id_expired';
    SELECT val::uuid INTO v_id_revoked  FROM pg_temp.ext_test_state WHERE key = 'v_id_revoked';
    SELECT val::uuid INTO v_id_used     FROM pg_temp.ext_test_state WHERE key = 'v_id_used';
    SELECT val::uuid INTO v_id_inactive FROM pg_temp.ext_test_state WHERE key = 'v_id_inactive';

    SELECT * INTO v_rec_exp   FROM public.parent_invitation_tokens WHERE id = v_id_expired;
    SELECT * INTO v_rec_rev   FROM public.parent_invitation_tokens WHERE id = v_id_revoked;
    SELECT * INTO v_rec_inact FROM public.parent_invitation_tokens WHERE id = v_id_inactive;
    SELECT * INTO v_rec_used  FROM public.parent_invitation_tokens WHERE id = v_id_used;

    IF v_rec_exp.used_at IS NOT NULL OR v_rec_exp.used_by IS NOT NULL THEN
        RAISE EXCEPTION '[FAIL - EXT-13 POST-CHECK]: Token hết hạn lại bị ghi nhận used_at/used_by!';
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-13', 'NEG',
        'Từ chối kích hoạt mã mời phụ huynh đã hết hạn (expires_at <= NOW()) và giữ nguyên used_at IS NULL.'
    );

    IF v_rec_rev.used_at IS NOT NULL OR v_rec_inact.used_at IS NOT NULL THEN
        RAISE EXCEPTION '[FAIL - EXT-14 POST-CHECK]: Token đã thu hồi hoặc của HS nghỉ học lại bị ghi nhận used_at!';
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-14', 'NEG',
        'Từ chối kích hoạt mã mời đã thu hồi (is_revoked=TRUE) hoặc khi học sinh ngừng hoạt động trong lớp (is_active=FALSE).'
    );

    SELECT COUNT(*) INTO v_ph03_cnt FROM public.parent_students WHERE parent_id = uid_ph03;
    IF v_ph03_cnt <> 0
       OR v_rec_used.used_by IS DISTINCT FROM uid_ph02
       OR v_rec_used.is_revoked IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '[FAIL - EXT-15 POST-CHECK]: Token đã sử dụng bị ghi đè used_by/is_revoked hoặc PH03 tạo được liên kết trái phép!';
    END IF;

    PERFORM pg_temp.record_ext_pass(
        'EXT-15', 'NEG',
        'Chặn dùng lại mã mời đã qua sử dụng (Replay Attack bởi PH03) và chặn giáo viên thu hồi mã mời đã sử dụng.'
    );
END $$;

-- ==============================================================================
-- 7. TỔNG KẾT BẮT BUỘC ĐỦ 15/15 CA KIỂM THỬ MỞ RỘNG (6 POS + 9 NEG)
-- ==============================================================================
RESET ROLE;

DO $$
DECLARE
    v_total_pass INT;
    v_neg_pass   INT;
    v_pos_pass   INT;
    r            RECORD;
BEGIN
    SELECT COUNT(*) FILTER (WHERE passed IS TRUE),
           COUNT(*) FILTER (WHERE passed IS TRUE AND test_type = 'NEG'),
           COUNT(*) FILTER (WHERE passed IS TRUE AND test_type = 'POS')
    INTO v_total_pass, v_neg_pass, v_pos_pass
    FROM pg_temp.ext_test_results;

    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'BẢNG KẾT QUẢ KIỂM THỬ NGHIỆP VỤ & BẢO MẬT MỞ RỘNG (15 CA KIỂM THỬ):';
    RAISE NOTICE '------------------------------------------------------------------------------';
    FOR r IN
        SELECT seq_no, test_id, test_type, passed, detail
        FROM pg_temp.ext_test_results
        ORDER BY seq_no
    LOOP
        RAISE NOTICE '#% | % (%) | PASS=% | %',
            lpad(r.seq_no::text, 2, '0'), rpad(r.test_id, 6, ' '), r.test_type, r.passed, r.detail;
    END LOOP;
    RAISE NOTICE '------------------------------------------------------------------------------';
    RAISE NOTICE 'TỔNG KẾT MỞ RỘNG: %/15 CA ĐẠT (NEG: %/9, POS: %/6)', v_total_pass, v_neg_pass, v_pos_pass;
    RAISE NOTICE '==============================================================================';

    IF v_total_pass <> 15 OR v_neg_pass <> 9 OR v_pos_pass <> 6 THEN
        RAISE EXCEPTION '[EXTENDED SUITE INCOMPLETE]: Chưa đủ 15/15 ca PASS (Total=%, NEG=%, POS=%).',
            v_total_pass, v_neg_pass, v_pos_pass;
    END IF;
END $$;

ROLLBACK;
