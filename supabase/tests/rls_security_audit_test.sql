-- ==============================================================================
-- PINK CLASSROOM - RLS & SECURITY AUDIT TEST SUITE (VERSION 3.5 - 17 TEST CASES)
-- Đối chiếu trực tiếp với: supabase/migrations/20261026000002_secure_schema_v3_hardened.sql
--
-- Nguyên tắc thiết kế V3.5:
-- 1. Toàn bộ kịch bản nằm trong một giao dịch duy nhất: BEGIN ... ROLLBACK;
--    Tuyệt đối không để lại dữ liệu rác hay hàm tạm sau khi kết thúc.
-- 2. Kiểm tra xung đột UUID trước khi tạo fixture: Nếu bất kỳ UUID kiểm thử nào
--    đã tồn tại trong DB, dừng ngay lập tức (RAISE EXCEPTION), không xóa/ghi đè.
-- 3. Tạo fixture đúng thứ tự khóa ngoại:
--    auth.users -> trigger on_auth_user_created tự sinh public.profiles (role='parent')
--    -> nâng role cho admin/teacher -> classes -> students -> class_memberships -> parent_students.
-- 4. Chuyển vai trò bằng câu lệnh SQL trực tiếp (SET LOCAL ROLE authenticated;)
--    kèm xác minh tiền điều kiện (current_user, session_user, auth.uid()) trước mỗi nhóm test.
-- 5. Kiểm tra mã lỗi SQLSTATE chính xác (42501 / P0001) cho từng ca âm để chống False-Pass,
--    kết hợp hậu kiểm (Post-check) trạng thái dữ liệu thực tế cho cả 17/17 ca (13 NEG + 4 POS).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 0. KHỞI TẠO BẢNG KẾT QUẢ TẠM & HÀM HỖ TRỢ TRONG SCHEMA TẠM (pg_temp)
-- ------------------------------------------------------------------------------
CREATE TEMP TABLE pg_temp.audit_test_results (
    seq_no      SERIAL PRIMARY KEY,
    test_id     TEXT UNIQUE NOT NULL,
    test_type   TEXT NOT NULL CHECK (test_type IN ('NEG', 'POS')),
    passed      BOOLEAN NOT NULL,
    detail      TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION pg_temp.set_test_jwt(
    p_user_id UUID,
    p_app_role TEXT DEFAULT 'authenticated',
    p_user_meta_role TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
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

CREATE OR REPLACE FUNCTION pg_temp.assert_auth_context(p_expected_uid UUID)
RETURNS VOID AS $$
BEGIN
    IF current_user <> 'authenticated' THEN
        RAISE EXCEPTION '[CONTEXT ERROR]: current_user phải là authenticated nhưng đang là %', current_user;
    END IF;
    IF session_user <> 'postgres' THEN
        RAISE EXCEPTION '[CONTEXT ERROR]: session_user phải là postgres nhưng đang là %', session_user;
    END IF;
    IF auth.uid() IS DISTINCT FROM p_expected_uid THEN
        RAISE EXCEPTION '[CONTEXT ERROR]: auth.uid() (%) không khớp với UUID kỳ vọng (%)', auth.uid(), p_expected_uid;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.record_pass(
    p_test_id TEXT,
    p_test_type TEXT,
    p_detail TEXT
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO pg_temp.audit_test_results (test_id, test_type, passed, detail)
    VALUES (p_test_id, p_test_type, TRUE, p_detail);
    RAISE NOTICE '[% - PASS]: %', p_test_id, p_detail;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_temp, pg_catalog;

-- Lưu trữ các biến ID dùng chung giữa các khối kiểm thử trong bảng cấu hình tạm
CREATE TEMP TABLE pg_temp.audit_test_state (
    key   TEXT PRIMARY KEY,
    val   TEXT NOT NULL
);

-- Cấp quyền truy cập schema tạm thực tế (pg_temp_<N>), bảng tạm và hàm hỗ trợ cho vai trò authenticated
DO $$
DECLARE
    v_temp_oid    OID;
    v_temp_schema TEXT;
BEGIN
    v_temp_oid := pg_catalog.pg_my_temp_schema();
    IF v_temp_oid IS NULL OR v_temp_oid = 0::oid THEN
        RAISE EXCEPTION '[SETUP ERROR]: Schema tạm (pg_temp) chưa được khởi tạo trong phiên hiện tại.';
    END IF;

    v_temp_schema := v_temp_oid::regnamespace::text;
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO authenticated', v_temp_schema);
    EXECUTE pg_catalog.format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated', v_temp_schema);
END $$;

GRANT SELECT, INSERT ON TABLE pg_temp.audit_test_results TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE pg_temp.audit_test_state TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.set_test_jwt(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.assert_auth_context(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.record_pass(TEXT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 1. KIỂM TRA XUNG ĐỘT UUID & KHỞI TẠO DỮ LIỆU FIXTURE (CHẠY DƯỚI ROLE postgres)
-- ------------------------------------------------------------------------------
RESET ROLE;

DO $$
DECLARE
    uid_admin UUID := '00000000-0000-0000-0000-000000000000';
    uid_gv01  UUID := '11111111-1111-1111-1111-111111111111'; -- Cô Mai (GV Lớp 1A)
    uid_gv02  UUID := '22222222-2222-2222-2222-222222222222'; -- Thầy Hùng (GV Lớp 1B)
    uid_ph01  UUID := '33333333-3333-3333-3333-333333333333'; -- Bố Nam (PH đã xác minh của HS01 - Lớp 1A)
    uid_ph02  UUID := '44444444-4444-4444-4444-444444444444'; -- Mẹ Lan (PH chưa xác minh của HS02 - Lớp 1B)

    cid_lop1a UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    cid_lop1b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    sid_hs01  UUID := '10000000-0000-0000-0000-000000000001'; -- Em Nam (Lớp 1A)
    sid_hs02  UUID := '20000000-0000-0000-0000-000000000002'; -- Em Lan (Lớp 1B)

    v_conflict_count INT;
    v_trigger_count  INT;
BEGIN
    RAISE NOTICE '>>> BƯỚC 1: KIỂM TRA AN TOÀN DỮ LIỆU & KHỞI TẠO FIXTURE...';

    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION '[SETUP ERROR]: Bước khởi tạo fixture phải chạy dưới quyền postgres (hiện tại: %).', current_user;
    END IF;

    -- 1.1 Kiểm tra xung đột UUID: Tuyệt đối không xóa hoặc ghi đè dữ liệu hiện có
    SELECT COUNT(*) INTO v_conflict_count
    FROM auth.users
    WHERE id IN (uid_admin, uid_gv01, uid_gv02, uid_ph01, uid_ph02)
       OR email IN (
           'audit_admin@tienclass.local',
           'audit_gv01@tienclass.local',
           'audit_gv02@tienclass.local',
           'audit_ph01@tienclass.local',
           'audit_ph02@tienclass.local'
       );
    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION '[ABORT - XUNG ĐỘT DỮ LIỆU]: Phát hiện % bản ghi trong auth.users trùng UUID/email kiểm thử. Dừng để bảo vệ dữ liệu!', v_conflict_count;
    END IF;

    SELECT COUNT(*) INTO v_conflict_count
    FROM public.profiles
    WHERE id IN (uid_admin, uid_gv01, uid_gv02, uid_ph01, uid_ph02);
    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION '[ABORT - XUNG ĐỘT DỮ LIỆU]: Phát hiện % bản ghi trong public.profiles trùng UUID kiểm thử!', v_conflict_count;
    END IF;

    SELECT COUNT(*) INTO v_conflict_count
    FROM public.classes
    WHERE id IN (cid_lop1a, cid_lop1b)
       OR (name IN ('Lớp 1A Audit', 'Lớp 1B Audit', 'Lớp Tự Phong') AND school_year = '2026-2027');
    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION '[ABORT - XUNG ĐỘT DỮ LIỆU]: Phát hiện % bản ghi trong public.classes trùng UUID/tên lớp kiểm thử!', v_conflict_count;
    END IF;

    SELECT COUNT(*) INTO v_conflict_count
    FROM public.students
    WHERE id IN (sid_hs01, sid_hs02)
       OR code IN ('AUDIT-HS-1A-001', 'AUDIT-HS-1B-002');
    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION '[ABORT - XUNG ĐỘT DỮ LIỆU]: Phát hiện % bản ghi trong public.students trùng UUID/mã học sinh kiểm thử!', v_conflict_count;
    END IF;

    -- 1.2 Chèn 5 người dùng vào auth.users (Trigger on_auth_user_created sẽ tự động tạo public.profiles với role = 'parent')
    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
    ) VALUES
        ('00000000-0000-0000-0000-000000000000', uid_admin, 'authenticated', 'authenticated', 'audit_admin@tienclass.local', '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Quản trị viên Audit","role":"admin"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_gv01,  'authenticated', 'authenticated', 'audit_gv01@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Cô Mai - GV 1A","role":"admin"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_gv02,  'authenticated', 'authenticated', 'audit_gv02@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Thầy Hùng - GV 1B"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph01,  'authenticated', 'authenticated', 'audit_ph01@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Bố Nam (PH 1A)","role":"admin"}'::jsonb, NOW(), NOW(), '', '', '', ''),
        ('00000000-0000-0000-0000-000000000000', uid_ph02,  'authenticated', 'authenticated', 'audit_ph02@tienclass.local',  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234', NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Mẹ Lan (PH 1B)"}'::jsonb, NOW(), NOW(), '', '', '', '');

    -- Xác minh trigger on_auth_user_created đã tạo đúng 5 hồ sơ đều có role mặc định là 'parent'
    -- (bất kể raw_user_meta_data có chứa "role":"admin")
    SELECT COUNT(*) INTO v_trigger_count
    FROM public.profiles
    WHERE id IN (uid_admin, uid_gv01, uid_gv02, uid_ph01, uid_ph02)
      AND role = 'parent';

    IF v_trigger_count <> 5 THEN
        RAISE EXCEPTION '[SETUP ERROR]: Trigger on_auth_user_created không tạo đủ 5 hồ sơ role=parent (thực tế: %).', v_trigger_count;
    END IF;

    -- 1.3 Nâng role cho Admin và 2 Giáo viên bằng quyền quản trị postgres (auth.uid() IS NULL)
    UPDATE public.profiles SET role = 'admin'   WHERE id = uid_admin;
    UPDATE public.profiles SET role = 'teacher' WHERE id IN (uid_gv01, uid_gv02);

    -- 1.4 Tạo 2 lớp học (không dùng ON CONFLICT DO NOTHING)
    INSERT INTO public.classes (id, name, school_year, teacher_id) VALUES
        (cid_lop1a, 'Lớp 1A Audit', '2026-2027', uid_gv01),
        (cid_lop1b, 'Lớp 1B Audit', '2026-2027', uid_gv02);

    -- 1.5 Tạo 2 học sinh
    INSERT INTO public.students (id, code, full_name) VALUES
        (sid_hs01, 'AUDIT-HS-1A-001', 'Nguyễn Văn Nam'),
        (sid_hs02, 'AUDIT-HS-1B-002', 'Trần Thị Lan');

    -- 1.6 Gắn học sinh vào lớp tương ứng
    INSERT INTO public.class_memberships (class_id, student_id, is_active) VALUES
        (cid_lop1a, sid_hs01, TRUE),
        (cid_lop1b, sid_hs02, TRUE);

    -- 1.7 Thiết lập quan hệ phụ huynh đã xác minh cho Bố Nam (uid_ph01 -> sid_hs01)
    INSERT INTO public.parent_students (parent_id, student_id, relationship, is_verified, verified_by, verified_at) VALUES
        (uid_ph01, sid_hs01, 'Bố', TRUE, uid_gv01, NOW());

    RAISE NOTICE '>>> BƯỚC 1 HOÀN TẤT: 5 auth.users, 5 profiles, 2 classes, 2 students, 2 memberships, 1 verified parent đã sẵn sàng.';
END $$;

-- ==============================================================================
-- 2. NHÓM KIỂM THỬ 1: PHỤ HUYNH 01 (uid_ph01) -> NEG-01, NEG-02
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_ph01    UUID := '33333333-3333-3333-3333-333333333333';
    v_sqlstate  TEXT;
    v_sqlerrm   TEXT;
    v_role      public.user_role;
    v_prof_cnt  INT;
BEGIN
    -- --------------------------------------------------------------------------
    -- [NEG-01]: Parent tự đặt user_metadata.role = 'admin' để leo quyền
    -- Kỳ vọng: public.is_admin() = FALSE, get_current_role() = 'parent',
    --          và không xem được toàn bộ 5 hồ sơ như admin.
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_test_jwt(uid_ph01, 'authenticated', 'admin');
    PERFORM pg_temp.assert_auth_context(uid_ph01);

    IF public.is_admin() IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '[FAIL - NEG-01]: Lỗ hổng leo quyền! public.is_admin() trả về TRUE khi user_metadata.role = admin.';
    END IF;

    IF public.get_current_role() IS DISTINCT FROM 'parent'::public.user_role THEN
        RAISE EXCEPTION '[FAIL - NEG-01]: get_current_role() không trả về parent (thực tế: %).', public.get_current_role();
    END IF;

    -- Hậu kiểm RLS: uid_ph01 chỉ thấy tối đa 2 hồ sơ (bản thân + GV dạy con mình), không thấy đủ 5 hồ sơ
    SELECT COUNT(*) INTO v_prof_cnt FROM public.profiles;
    IF v_prof_cnt <> 2 THEN
        RAISE EXCEPTION '[FAIL - NEG-01]: Phụ huynh có user_metadata.role=admin nhìn thấy % hồ sơ (kỳ vọng: 2).', v_prof_cnt;
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-01', 'NEG',
        'public.is_admin() = FALSE và RLS chặn đọc toàn bảng dù client tiêm user_metadata.role = admin.'
    );

    -- --------------------------------------------------------------------------
    -- [NEG-02]: Parent gửi lệnh UPDATE public.profiles SET role = 'admin'
    -- Kỳ vọng: Bị chặn bởi Column-Level Privilege với SQLSTATE = '42501',
    --          cột role trong DB giữ nguyên là 'parent'.
    -- --------------------------------------------------------------------------
    PERFORM pg_temp.set_test_jwt(uid_ph01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_ph01);

    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        UPDATE public.profiles SET role = 'admin' WHERE id = uid_ph01;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-02]: Lệnh UPDATE profiles.role không bị chặn bởi ngoại lệ bảo mật!';
    END IF;

    IF v_sqlstate <> '42501' THEN
        RAISE EXCEPTION '[FAIL - NEG-02]: Bị chặn bởi SQLSTATE bất thường (%) thay vì 42501 (Chi tiết: %).', v_sqlstate, v_sqlerrm;
    END IF;

    -- Hậu kiểm dữ liệu: role của uid_ph01 vẫn phải là 'parent'
    SELECT role INTO v_role FROM public.profiles WHERE id = uid_ph01;
    IF v_role IS DISTINCT FROM 'parent'::public.user_role THEN
        RAISE EXCEPTION '[FAIL - NEG-02]: Cột profiles.role đã bị thay đổi thành %!', v_role;
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-02', 'NEG',
        format('Chặn phụ huynh UPDATE profiles.role bằng Column Privilege (SQLSTATE=%s, MSG=%s).', v_sqlstate, v_sqlerrm)
    );
END $$;

RESET ROLE;

-- ==============================================================================
-- 3. NHÓM KIỂM THỬ 2: GIÁO VIÊN 01 (uid_gv01) -> NEG-03, POS-01, NEG-04
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01    UUID := '11111111-1111-1111-1111-111111111111';
    cid_lop1a   UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    cid_lop1b   UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    sid_hs01    UUID := '10000000-0000-0000-0000-000000000001';
    sid_hs02    UUID := '20000000-0000-0000-0000-000000000002';

    v_tok_cross TEXT := 'pink_cross_class_attack_token_123456';
    v_hash_cross VARCHAR(64);
    v_tok1      TEXT := 'pink_secret_valid_token_12345678';
    v_hash1     VARCHAR(64);
    v_hash_tamper VARCHAR(64);

    v_token_id  UUID;
    v_row_cnt   INT;
    v_sqlstate  TEXT;
    v_sqlerrm   TEXT;
    v_rec       RECORD;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv01);

    v_hash_cross  := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(v_tok_cross), 'UTF8')), 'hex');
    v_hash1       := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(v_tok1), 'UTF8')), 'hex');
    v_hash_tamper := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('tampered_token_hash_1234567890', 'UTF8')), 'hex');

    -- --------------------------------------------------------------------------
    -- [NEG-03]: GV01 (Lớp 1A) cố ý tạo token cho HS02 thuộc Lớp 1B
    -- Kỳ vọng: Trigger trg_validate_parent_invitation_token chặn với SQLSTATE = 'P0001'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
        VALUES (cid_lop1b, sid_hs02, v_hash_cross);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-03]: GV01 tạo được token trái phép cho học sinh Lớp 1B!';
    END IF;

    IF v_sqlstate <> 'P0001' OR v_sqlerrm NOT LIKE '%Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp%' THEN
        RAISE EXCEPTION '[FAIL - NEG-03]: Bị chặn bởi lỗi không đúng kỳ vọng (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    -- --------------------------------------------------------------------------
    -- [POS-01]: GV01 tạo token hợp lệ cho HS01 thuộc Lớp 1A của mình
    -- Kỳ vọng: INSERT thành công (ROW_COUNT = 1), trigger tự gán created_by = uid_gv01,
    --          is_revoked = FALSE, used_at IS NULL.
    -- --------------------------------------------------------------------------
    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
    VALUES (cid_lop1a, sid_hs01, v_hash1)
    RETURNING id INTO v_token_id;

    GET DIAGNOSTICS v_row_cnt = ROW_COUNT;
    IF v_row_cnt <> 1 OR v_token_id IS NULL THEN
        RAISE EXCEPTION '[FAIL - POS-01]: GV01 không tạo được token hợp lệ cho học sinh lớp mình.';
    END IF;

    SELECT * INTO v_rec FROM public.parent_invitation_tokens WHERE id = v_token_id;
    IF v_rec.created_by IS DISTINCT FROM uid_gv01
       OR v_rec.is_revoked IS DISTINCT FROM FALSE
       OR v_rec.revoked_at IS NOT NULL
       OR v_rec.used_at IS NOT NULL
       OR v_rec.used_by IS NOT NULL
       OR v_rec.token_hash IS DISTINCT FROM v_hash1 THEN
        RAISE EXCEPTION '[FAIL - POS-01]: Dữ liệu token sau khi tạo không khớp kỳ vọng: %', row_to_json(v_rec);
    END IF;

    INSERT INTO pg_temp.audit_test_state (key, val) VALUES
        ('v_token_id', v_token_id::text),
        ('v_tok1', v_tok1),
        ('v_hash1', v_hash1),
        ('v_hash_cross', v_hash_cross);

    PERFORM pg_temp.record_pass(
        'POS-01', 'POS',
        format('GV01 tạo token hợp lệ cho HS01 Lớp 1A thành công (id=%s, created_by=%s).', v_token_id, v_rec.created_by)
    );

    -- --------------------------------------------------------------------------
    -- [NEG-04]: GV01 cố ý UPDATE token_hash của token đã phát hành
    -- Kỳ vọng: Bị chặn bởi Column-Level Privilege với SQLSTATE = '42501',
    --          token_hash trong DB giữ nguyên là v_hash1.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        UPDATE public.parent_invitation_tokens
        SET token_hash = v_hash_tamper
        WHERE id = v_token_id;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-04]: Giáo viên sửa được cột token_hash của token đã phát hành!';
    END IF;

    IF v_sqlstate <> '42501' THEN
        RAISE EXCEPTION '[FAIL - NEG-04]: Bị chặn bởi SQLSTATE bất thường (%) thay vì 42501 (MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    SELECT * INTO v_rec FROM public.parent_invitation_tokens WHERE id = v_token_id;
    IF v_rec.token_hash IS DISTINCT FROM v_hash1 THEN
        RAISE EXCEPTION '[FAIL - NEG-04]: Giá trị token_hash đã bị thay đổi trái phép!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-04', 'NEG',
        format('Chặn GV sửa cột bất biến token_hash bằng Column Privilege (SQLSTATE=%s, MSG=%s).', v_sqlstate, v_sqlerrm)
    );
END $$;

RESET ROLE;

-- Hậu kiểm toàn cục dưới quyền postgres cho NEG-03 (đảm bảo không có bản ghi lọt lưới RLS)
DO $$
DECLARE
    v_hash_cross TEXT;
    v_cnt        INT;
BEGIN
    SELECT val INTO v_hash_cross FROM pg_temp.audit_test_state WHERE key = 'v_hash_cross';
    SELECT COUNT(*) INTO v_cnt FROM public.parent_invitation_tokens WHERE token_hash = v_hash_cross;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - NEG-03 POST-CHECK]: Tồn tại % bản ghi token trái phép trong DB!', v_cnt;
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-03', 'NEG',
        'Chặn GV01 tạo token cho học sinh Lớp 1B (SQLSTATE=P0001) và hậu kiểm 0 bản ghi trong DB.'
    );
END $$;

-- ==============================================================================
-- 4. NHÓM KIỂM THỬ 3: GIÁO VIÊN 02 (uid_gv02) -> NEG-05
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv02   UUID := '22222222-2222-2222-2222-222222222222';
    v_token_id UUID;
    v_res      JSONB;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv02, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv02);

    SELECT val::uuid INTO v_token_id FROM pg_temp.audit_test_state WHERE key = 'v_token_id';

    -- --------------------------------------------------------------------------
    -- [NEG-05]: GV02 (Lớp 1B) gọi RPC revoke_parent_invitation trên token của Lớp 1A
    -- Kỳ vọng: RPC trả về {"ok": false, "message": "Quyền bị từ chối..."}
    -- --------------------------------------------------------------------------
    v_res := public.revoke_parent_invitation(v_token_id);

    IF v_res IS NULL OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '[FAIL - NEG-05]: GV02 thu hồi được token của Lớp 1A! Phản hồi: %', v_res;
    END IF;

    IF COALESCE(v_res->>'message', '') NOT LIKE '%Quyền bị từ chối%' THEN
        RAISE EXCEPTION '[FAIL - NEG-05]: Thông báo từ chối của RPC không đúng kỳ vọng: %', v_res;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho NEG-05: Token của Lớp 1A vẫn phải có is_revoked = FALSE
DO $$
DECLARE
    v_token_id   UUID;
    v_is_revoked BOOLEAN;
    v_revoked_at TIMESTAMPTZ;
BEGIN
    SELECT val::uuid INTO v_token_id FROM pg_temp.audit_test_state WHERE key = 'v_token_id';
    SELECT is_revoked, revoked_at INTO v_is_revoked, v_revoked_at
    FROM public.parent_invitation_tokens WHERE id = v_token_id;

    IF v_is_revoked IS DISTINCT FROM FALSE OR v_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-05 POST-CHECK]: Token Lớp 1A đã bị đánh dấu thu hồi trái phép!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-05', 'NEG',
        'RPC revoke_parent_invitation từ chối GV02 thu hồi token của Lớp 1A và giữ nguyên is_revoked = FALSE.'
    );
END $$;

-- ==============================================================================
-- 5. NHÓM KIỂM THỬ 4: PHỤ HUYNH 02 (uid_ph02) -> NEG-06
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv02   UUID := '22222222-2222-2222-2222-222222222222';
    uid_ph02   UUID := '44444444-4444-4444-4444-444444444444';
    sid_hs02   UUID := '20000000-0000-0000-0000-000000000002';
    v_sqlstate TEXT;
    v_sqlerrm  TEXT;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_ph02, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_ph02);

    -- --------------------------------------------------------------------------
    -- [NEG-06]: Phụ huynh tự INSERT trực tiếp vào bảng parent_students để tự xác minh
    -- Kỳ vọng: Bị chặn bởi Table-Level Privilege (REVOKE INSERT) với SQLSTATE = '42501'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.parent_students (parent_id, student_id, is_verified, verified_by, relationship)
        VALUES (uid_ph02, sid_hs02, TRUE, uid_gv02, 'Mẹ');
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-06]: Phụ huynh tự INSERT trực tiếp vào parent_students thành công!';
    END IF;

    IF v_sqlstate <> '42501' THEN
        RAISE EXCEPTION '[FAIL - NEG-06]: Bị chặn bởi SQLSTATE bất thường (%) thay vì 42501 (MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho NEG-06: Không có dòng nào của (uid_ph02, sid_hs02) trong parent_students
DO $$
DECLARE
    uid_ph02 UUID := '44444444-4444-4444-4444-444444444444';
    sid_hs02 UUID := '20000000-0000-0000-0000-000000000002';
    v_cnt    INT;
BEGIN
    SELECT COUNT(*) INTO v_cnt
    FROM public.parent_students
    WHERE parent_id = uid_ph02 AND student_id = sid_hs02;

    IF v_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - NEG-06 POST-CHECK]: Phát hiện % bản ghi parent_students trái phép!', v_cnt;
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-06', 'NEG',
        'Chặn phụ huynh tự INSERT vào parent_students bằng Table Privilege (SQLSTATE=42501) và hậu kiểm 0 bản ghi.'
    );
END $$;

-- ==============================================================================
-- 6. NHÓM KIỂM THỬ 5: GIÁO VIÊN 01 (uid_gv01) -> POS-02, NEG-07
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01   UUID := '11111111-1111-1111-1111-111111111111';
    v_token_id UUID;
    v_res      JSONB;
    v_rec      RECORD;
    v_sqlstate TEXT;
    v_sqlerrm  TEXT;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv01);

    SELECT val::uuid INTO v_token_id FROM pg_temp.audit_test_state WHERE key = 'v_token_id';

    -- --------------------------------------------------------------------------
    -- [POS-02]: GV01 gọi RPC revoke_parent_invitation để thu hồi token hợp lệ của lớp mình
    -- Kỳ vọng: RPC trả về {"ok": true}, bản ghi có is_revoked = TRUE và revoked_at IS NOT NULL.
    -- --------------------------------------------------------------------------
    v_res := public.revoke_parent_invitation(v_token_id);

    IF v_res IS NULL OR (v_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - POS-02]: GV01 thu hồi token hợp lệ thất bại: %', v_res;
    END IF;

    SELECT * INTO v_rec FROM public.parent_invitation_tokens WHERE id = v_token_id;
    IF v_rec.is_revoked IS DISTINCT FROM TRUE OR v_rec.revoked_at IS NULL THEN
        RAISE EXCEPTION '[FAIL - POS-02]: Cột is_revoked/revoked_at không được cập nhật sau khi thu hồi!';
    END IF;

    PERFORM pg_temp.record_pass(
        'POS-02', 'POS',
        format('GV01 thu hồi token hợp lệ qua RPC thành công (is_revoked=TRUE, revoked_at=%s).', v_rec.revoked_at)
    );

    -- --------------------------------------------------------------------------
    -- [NEG-07]: GV01 cố ý hoàn tác thu hồi token (UPDATE is_revoked = FALSE)
    -- Kỳ vọng: Trigger trg_validate_parent_invitation_token chặn với SQLSTATE = 'P0001'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        UPDATE public.parent_invitation_tokens
        SET is_revoked = FALSE
        WHERE id = v_token_id;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-07]: Giáo viên hoàn tác thu hồi token (is_revoked -> FALSE) thành công!';
    END IF;

    IF v_sqlstate <> 'P0001' OR v_sqlerrm NOT LIKE '%Không được phép kích hoạt lại mã liên kết đã bị thu hồi%' THEN
        RAISE EXCEPTION '[FAIL - NEG-07]: Bị chặn bởi lỗi không đúng kỳ vọng (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    SELECT * INTO v_rec FROM public.parent_invitation_tokens WHERE id = v_token_id;
    IF v_rec.is_revoked IS DISTINCT FROM TRUE OR v_rec.revoked_at IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-07 POST-CHECK]: Trạng thái is_revoked của token đã bị hoàn tác!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-07', 'NEG',
        format('Trigger chặn hoàn tác thu hồi token (SQLSTATE=%s, MSG=%s).', v_sqlstate, v_sqlerrm)
    );
END $$;

RESET ROLE;

-- ==============================================================================
-- 7. NHÓM KIỂM THỬ 6: PHỤ HUYNH 01 (uid_ph01) -> NEG-08, NEG-09
-- ==============================================================================
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_ph01   UUID := '33333333-3333-3333-3333-333333333333';
    v_tok1     TEXT;
    v_res      JSONB;
    v_sqlstate TEXT;
    v_sqlerrm  TEXT;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_ph01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_ph01);

    SELECT val INTO v_tok1 FROM pg_temp.audit_test_state WHERE key = 'v_tok1';

    -- --------------------------------------------------------------------------
    -- [NEG-08]: Phụ huynh kích hoạt token đã bị thu hồi qua RPC claim_parent_invitation
    -- Kỳ vọng: RPC trả về {"ok": false, "message": "...đã bị giáo viên thu hồi..."}
    -- --------------------------------------------------------------------------
    v_res := public.claim_parent_invitation(v_tok1);

    IF v_res IS NULL OR (v_res->>'ok')::boolean IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '[FAIL - NEG-08]: Kích hoạt thành công token đã bị thu hồi! Phản hồi: %', v_res;
    END IF;

    IF COALESCE(v_res->>'message', '') NOT LIKE '%thu hồi%' THEN
        RAISE EXCEPTION '[FAIL - NEG-08]: Thông báo từ chối của RPC không đúng kỳ vọng: %', v_res;
    END IF;

    -- --------------------------------------------------------------------------
    -- [NEG-09]: Phụ huynh tự INSERT vào bảng classes với teacher_id = auth.uid()
    -- Kỳ vọng: Bị chặn bởi RLS Policy classes_teacher_manage với SQLSTATE = '42501'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        INSERT INTO public.classes (name, school_year, teacher_id)
        VALUES ('Lớp Tự Phong', '2026-2027', uid_ph01);
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-09]: Phụ huynh tự tạo được lớp học với teacher_id là chính mình!';
    END IF;

    IF v_sqlstate <> '42501' OR v_sqlerrm NOT LIKE '%row-level security%' THEN
        RAISE EXCEPTION '[FAIL - NEG-09]: Bị chặn bởi lỗi không đúng RLS policy trên bảng classes (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho NEG-08 và NEG-09
DO $$
DECLARE
    v_token_id UUID;
    v_used_at  TIMESTAMPTZ;
    v_used_by  UUID;
    v_cls_cnt  INT;
BEGIN
    SELECT val::uuid INTO v_token_id FROM pg_temp.audit_test_state WHERE key = 'v_token_id';
    SELECT used_at, used_by INTO v_used_at, v_used_by
    FROM public.parent_invitation_tokens WHERE id = v_token_id;

    IF v_used_at IS NOT NULL OR v_used_by IS NOT NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-08 POST-CHECK]: Token đã thu hồi lại bị ghi nhận used_at/used_by!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-08', 'NEG',
        'RPC claim_parent_invitation từ chối kích hoạt token đã bị thu hồi và giữ nguyên used_at IS NULL.'
    );

    SELECT COUNT(*) INTO v_cls_cnt
    FROM public.classes
    WHERE name = 'Lớp Tự Phong' AND school_year = '2026-2027';

    IF v_cls_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - NEG-09 POST-CHECK]: Tồn tại % lớp học tự phong trong DB!', v_cls_cnt;
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-09', 'NEG',
        'RLS policy classes_teacher_manage chặn phụ huynh tạo lớp học (SQLSTATE=42501) và hậu kiểm 0 bản ghi.'
    );
END $$;

-- ==============================================================================
-- 8. NHÓM KIỂM THỬ 7: GV02 TẠO TOKEN & PH02 KÍCH HOẠT -> POS-03, NEG-10
-- ==============================================================================
-- Bước 8A: GV02 tạo token hợp lệ cho HS02 (Lớp 1B)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv02        UUID := '22222222-2222-2222-2222-222222222222';
    cid_lop1b       UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    sid_hs02        UUID := '20000000-0000-0000-0000-000000000002';
    v_tok_used      TEXT := 'pink_secret_used_token_987654321';
    v_hash_used     VARCHAR(64);
    v_token_used_id UUID;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv02, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv02);

    v_hash_used := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(v_tok_used), 'UTF8')), 'hex');

    INSERT INTO public.parent_invitation_tokens (class_id, student_id, token_hash)
    VALUES (cid_lop1b, sid_hs02, v_hash_used)
    RETURNING id INTO v_token_used_id;

    IF v_token_used_id IS NULL THEN
        RAISE EXCEPTION '[FAIL - POS-03 SETUP]: GV02 không tạo được token cho HS02 Lớp 1B.';
    END IF;

    INSERT INTO pg_temp.audit_test_state (key, val) VALUES
        ('v_tok_used', v_tok_used),
        ('v_token_used_id', v_token_used_id::text);
END $$;

RESET ROLE;

-- Bước 8B: PH02 kích hoạt token qua RPC claim_parent_invitation (POS-03)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv02    UUID := '22222222-2222-2222-2222-222222222222';
    uid_ph02    UUID := '44444444-4444-4444-4444-444444444444';
    sid_hs02    UUID := '20000000-0000-0000-0000-000000000002';
    v_tok_used  TEXT;
    v_res       JSONB;
    v_pre_cnt   INT;
    v_post_cnt  INT;
    v_ps_rec    RECORD;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_ph02, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_ph02);

    SELECT val INTO v_tok_used FROM pg_temp.audit_test_state WHERE key = 'v_tok_used';

    -- Tiền kiểm RLS: Trước khi claim token, PH02 chưa thể nhìn thấy HS02
    SELECT COUNT(*) INTO v_pre_cnt FROM public.students WHERE id = sid_hs02;
    IF v_pre_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - POS-03 PRE-CHECK]: PH02 chưa xác minh nhưng đã nhìn thấy HS02!';
    END IF;

    -- --------------------------------------------------------------------------
    -- [POS-03]: PH02 kích hoạt mã liên kết hợp lệ qua RPC claim_parent_invitation
    -- Kỳ vọng: RPC trả về {"ok": true, "student_id": sid_hs02}, tạo bản ghi
    --          parent_students (is_verified=TRUE, verified_by=uid_gv02) và PH02 xem được HS02.
    -- --------------------------------------------------------------------------
    v_res := public.claim_parent_invitation(v_tok_used);

    IF v_res IS NULL OR (v_res->>'ok')::boolean IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '[FAIL - POS-03]: PH02 claim token hợp lệ thất bại: %', v_res;
    END IF;

    IF (v_res->>'student_id')::uuid IS DISTINCT FROM sid_hs02 THEN
        RAISE EXCEPTION '[FAIL - POS-03]: student_id trả về (%) không khớp với sid_hs02 (%).', v_res->>'student_id', sid_hs02;
    END IF;

    -- Hậu kiểm dưới quyền PH02: Đọc được bản ghi parent_students đã xác minh và đọc được HS02
    SELECT * INTO v_ps_rec
    FROM public.parent_students
    WHERE parent_id = uid_ph02 AND student_id = sid_hs02;

    IF v_ps_rec.id IS NULL
       OR v_ps_rec.is_verified IS DISTINCT FROM TRUE
       OR v_ps_rec.verified_by IS DISTINCT FROM uid_gv02
       OR v_ps_rec.verified_at IS NULL THEN
        RAISE EXCEPTION '[FAIL - POS-03 POST-CHECK]: Bản ghi parent_students sau khi claim không hợp lệ: %', row_to_json(v_ps_rec);
    END IF;

    SELECT COUNT(*) INTO v_post_cnt FROM public.students WHERE id = sid_hs02;
    IF v_post_cnt <> 1 THEN
        RAISE EXCEPTION '[FAIL - POS-03 POST-CHECK]: Sau khi claim thành công, PH02 vẫn không xem được HS02!';
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho POS-03: Kiểm tra used_at & used_by trên parent_invitation_tokens
DO $$
DECLARE
    uid_ph02        UUID := '44444444-4444-4444-4444-444444444444';
    v_token_used_id UUID;
    v_tok_rec       RECORD;
BEGIN
    SELECT val::uuid INTO v_token_used_id FROM pg_temp.audit_test_state WHERE key = 'v_token_used_id';
    SELECT * INTO v_tok_rec FROM public.parent_invitation_tokens WHERE id = v_token_used_id;

    IF v_tok_rec.used_at IS NULL OR v_tok_rec.used_by IS DISTINCT FROM uid_ph02 THEN
        RAISE EXCEPTION '[FAIL - POS-03 POST-CHECK]: Token sau khi claim không ghi nhận used_at/used_by đúng chuẩn!';
    END IF;

    PERFORM pg_temp.record_pass(
        'POS-03', 'POS',
        format('PH02 claim token thành công (used_by=%s, is_verified=TRUE) và mở khóa quyền đọc RLS trên HS02.', uid_ph02)
    );
END $$;

-- Bước 8C: GV02 cố ý xóa token đã qua sử dụng (NEG-10)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv02        UUID := '22222222-2222-2222-2222-222222222222';
    v_token_used_id UUID;
    v_row_cnt       INT := 0;
    v_sqlstate      TEXT := NULL;
    v_sqlerrm       TEXT := NULL;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv02, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv02);

    SELECT val::uuid INTO v_token_used_id FROM pg_temp.audit_test_state WHERE key = 'v_token_used_id';
    IF v_token_used_id IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-10 PRE-CHECK]: v_token_used_id bị NULL trước khi thực hiện kiểm thử DELETE!';
    END IF;

    -- --------------------------------------------------------------------------
    -- [NEG-10]: GV02 cố ý DELETE token đã sử dụng
    -- Kỳ vọng: Bị chặn bởi RLS Policy tokens_teacher_delete (USING used_at IS NULL -> ROW_COUNT = 0)
    --          hoặc bởi Trigger trg_validate_parent_invitation_token (SQLSTATE = 'P0001'
    --          kèm thông báo bảo vệ nhật ký kiểm toán).
    -- --------------------------------------------------------------------------
    BEGIN
        DELETE FROM public.parent_invitation_tokens WHERE id = v_token_used_id;
        GET DIAGNOSTICS v_row_cnt = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NOT NULL THEN
        IF v_sqlstate <> 'P0001' OR v_sqlerrm NOT LIKE '%Không được phép xóa mã liên kết đã qua sử dụng%' THEN
            RAISE EXCEPTION '[FAIL - NEG-10]: Xóa token gặp lỗi bất thường (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
        END IF;
    END IF;

    IF v_row_cnt > 0 THEN
        RAISE EXCEPTION '[FAIL - NEG-10]: GV02 đã xóa được % bản ghi token đã qua sử dụng!', v_row_cnt;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho NEG-10: Bản ghi token đã sử dụng phải còn nguyên vẹn và không bị thay đổi
DO $$
DECLARE
    uid_ph02        UUID := '44444444-4444-4444-4444-444444444444';
    v_token_used_id UUID;
    v_tok_rec       RECORD;
BEGIN
    SELECT val::uuid INTO v_token_used_id FROM pg_temp.audit_test_state WHERE key = 'v_token_used_id';
    SELECT * INTO v_tok_rec
    FROM public.parent_invitation_tokens
    WHERE id = v_token_used_id;

    IF v_tok_rec.id IS NULL
       OR v_tok_rec.used_at IS NULL
       OR v_tok_rec.used_by IS DISTINCT FROM uid_ph02
       OR v_tok_rec.is_revoked IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '[FAIL - NEG-10 POST-CHECK]: Bản ghi token đã sử dụng không còn tồn tại hoặc đã bị thay đổi trái phép!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-10', 'NEG',
        'Chặn GV02 xóa token đã qua sử dụng (RLS lọc 0 dòng + Trigger bảo vệ) và hậu kiểm bản ghi còn nguyên vẹn.'
    );
END $$;

-- ==============================================================================
-- 9. NHÓM KIỂM THỬ 8: NHẬN XÉT TUẦN -> POS-04, NEG-11, NEG-12, NEG-13
-- ==============================================================================
-- Bước 9A: GV01 tạo nhận xét ở trạng thái 'draft' cho HS01 (Lớp 1A)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01     UUID := '11111111-1111-1111-1111-111111111111';
    cid_lop1a    UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    sid_hs01     UUID := '10000000-0000-0000-0000-000000000001';
    v_comment_id UUID;
    v_rec        RECORD;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv01);

    INSERT INTO public.weekly_comments (class_id, student_id, school_year, week_number, date, content, status)
    VALUES (cid_lop1a, sid_hs01, '2026-2027', 1, CURRENT_DATE, 'Nhận xét tuần 1: Con học tập tích cực.', 'draft')
    RETURNING id INTO v_comment_id;

    IF v_comment_id IS NULL THEN
        RAISE EXCEPTION '[FAIL - POS-04 STEP A]: GV01 không tạo được nhận xét nháp (draft).';
    END IF;

    SELECT * INTO v_rec FROM public.weekly_comments WHERE id = v_comment_id;
    IF v_rec.status IS DISTINCT FROM 'draft'::public.comment_status
       OR v_rec.sent_at IS NOT NULL THEN
        RAISE EXCEPTION '[FAIL - POS-04 STEP A]: Nhận xét draft vừa tạo có trạng thái/sent_at không hợp lệ: %', row_to_json(v_rec);
    END IF;

    INSERT INTO pg_temp.audit_test_state (key, val) VALUES ('v_comment_id', v_comment_id::text);
END $$;

RESET ROLE;

-- Bước 9B: Kiểm tra dưới quyền PH01 (đã xác minh của HS01) -> KHÔNG được thấy nhận xét đang ở trạng thái 'draft'
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_ph01     UUID := '33333333-3333-3333-3333-333333333333';
    v_comment_id UUID;
    v_cnt        INT;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_ph01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_ph01);

    SELECT val::uuid INTO v_comment_id FROM pg_temp.audit_test_state WHERE key = 'v_comment_id';

    SELECT COUNT(*) INTO v_cnt FROM public.weekly_comments WHERE id = v_comment_id;
    IF v_cnt <> 0 THEN
        RAISE EXCEPTION '[FAIL - POS-04 STEP B]: Phụ huynh đọc được nhận xét đang ở trạng thái nháp (draft)!';
    END IF;
END $$;

RESET ROLE;

-- Bước 9C: GV01 chuyển trạng thái nhận xét từ 'draft' sang 'sent'
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01     UUID := '11111111-1111-1111-1111-111111111111';
    v_comment_id UUID;
    v_rec        RECORD;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv01);

    SELECT val::uuid INTO v_comment_id FROM pg_temp.audit_test_state WHERE key = 'v_comment_id';

    UPDATE public.weekly_comments
    SET status = 'sent', content = 'Nhận xét tuần 1 (Chính thức): Con học rất tốt.'
    WHERE id = v_comment_id;

    SELECT * INTO v_rec FROM public.weekly_comments WHERE id = v_comment_id;
    IF v_rec.status IS DISTINCT FROM 'sent'::public.comment_status
       OR v_rec.sent_at IS NULL
       OR v_rec.teacher_id IS DISTINCT FROM uid_gv01 THEN
        RAISE EXCEPTION '[FAIL - POS-04 STEP C]: Trigger không tự động gán sent_at/teacher_id khi phát hành nhận xét!';
    END IF;

    INSERT INTO pg_temp.audit_test_state (key, val) VALUES ('v_orig_sent_at', v_rec.sent_at::text);
END $$;

RESET ROLE;

-- Bước 9D: Kiểm tra dưới quyền PH01 -> Đọc được nhận xét sau khi đã chuyển sang 'sent' (Hoàn tất POS-04)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_ph01     UUID := '33333333-3333-3333-3333-333333333333';
    v_comment_id UUID;
    v_cnt        INT;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_ph01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_ph01);

    SELECT val::uuid INTO v_comment_id FROM pg_temp.audit_test_state WHERE key = 'v_comment_id';

    SELECT COUNT(*) INTO v_cnt FROM public.weekly_comments WHERE id = v_comment_id AND status = 'sent';
    IF v_cnt <> 1 THEN
        RAISE EXCEPTION '[FAIL - POS-04 STEP D]: Phụ huynh đã xác minh không đọc được nhận xét đã phát hành (sent)!';
    END IF;

    PERFORM pg_temp.record_pass(
        'POS-04', 'POS',
        'GV01 tạo nháp (PH01 không thấy) -> phát hành sang sent (tự gán sent_at, teacher_id, PH01 đọc được).'
    );
END $$;

RESET ROLE;

-- Bước 9E: GV01 thực hiện 3 ca kiểm thử âm trên nhận xét đã phát hành (NEG-11, NEG-12, NEG-13)
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    uid_gv01       UUID := '11111111-1111-1111-1111-111111111111';
    v_comment_id   UUID;
    v_orig_sent_at TIMESTAMPTZ;
    v_after_sent   TIMESTAMPTZ;
    v_fake_sent_at TIMESTAMPTZ := '2016-01-01 00:00:00+00'::timestamptz;
    v_sqlstate     TEXT;
    v_sqlerrm      TEXT;
BEGIN
    PERFORM pg_temp.set_test_jwt(uid_gv01, 'authenticated', NULL);
    PERFORM pg_temp.assert_auth_context(uid_gv01);

    SELECT val::uuid INTO v_comment_id FROM pg_temp.audit_test_state WHERE key = 'v_comment_id';
    SELECT val::timestamptz INTO v_orig_sent_at FROM pg_temp.audit_test_state WHERE key = 'v_orig_sent_at';

    -- --------------------------------------------------------------------------
    -- [NEG-11]: GV01 cố ý sửa lùi dấu thời gian sent_at của nhận xét đã gửi
    -- Kỳ vọng: Trigger trg_comment_status_and_consistency bảo tồn nguyên vẹn OLD.sent_at.
    -- --------------------------------------------------------------------------
    UPDATE public.weekly_comments
    SET sent_at = v_fake_sent_at
    WHERE id = v_comment_id;

    SELECT sent_at INTO v_after_sent FROM public.weekly_comments WHERE id = v_comment_id;
    IF v_after_sent = v_fake_sent_at OR v_after_sent IS DISTINCT FROM v_orig_sent_at THEN
        RAISE EXCEPTION '[FAIL - NEG-11]: Dấu thời gian sent_at bị thay đổi từ % thành %!', v_orig_sent_at, v_after_sent;
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-11', 'NEG',
        format('Trigger bảo tồn bất biến dấu thời gian sent_at gốc (%s) khi cập nhật nhận xét đã gửi.', v_after_sent)
    );

    -- --------------------------------------------------------------------------
    -- [NEG-12]: GV01 cố ý DELETE nhận xét đã gửi cho phụ huynh
    -- Kỳ vọng: Trigger trg_comment_status_and_consistency chặn với SQLSTATE = 'P0001'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        DELETE FROM public.weekly_comments WHERE id = v_comment_id;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-12]: Giáo viên xóa được nhận xét đã gửi tới phụ huynh!';
    END IF;

    IF v_sqlstate <> 'P0001' OR v_sqlerrm NOT LIKE '%Không được phép xóa nhận xét đã gửi tới phụ huynh%' THEN
        RAISE EXCEPTION '[FAIL - NEG-12]: Bị chặn bởi lỗi không đúng kỳ vọng (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;

    -- --------------------------------------------------------------------------
    -- [NEG-13]: GV01 cố ý hoàn tác nhận xét đã gửi về trạng thái 'draft'
    -- Kỳ vọng: Trigger trg_comment_status_and_consistency chặn với SQLSTATE = 'P0001'.
    -- --------------------------------------------------------------------------
    v_sqlstate := NULL;
    v_sqlerrm  := NULL;
    BEGIN
        UPDATE public.weekly_comments
        SET status = 'draft'
        WHERE id = v_comment_id;
    EXCEPTION WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_sqlerrm  := SQLERRM;
    END;

    IF v_sqlstate IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-13]: Giáo viên hoàn tác được nhận xét đã gửi về trạng thái draft!';
    END IF;

    IF v_sqlstate <> 'P0001' OR v_sqlerrm NOT LIKE '%Không được phép hoàn tác nhận xét đã gửi về trạng thái nháp%' THEN
        RAISE EXCEPTION '[FAIL - NEG-13]: Bị chặn bởi lỗi không đúng kỳ vọng (SQLSTATE=%, MSG=%).', v_sqlstate, v_sqlerrm;
    END IF;
END $$;

RESET ROLE;

-- Hậu kiểm dưới quyền postgres cho NEG-12 và NEG-13: Nhận xét vẫn tồn tại và giữ nguyên status = 'sent'
DO $$
DECLARE
    v_comment_id   UUID;
    v_orig_sent_at TIMESTAMPTZ;
    v_rec          RECORD;
BEGIN
    SELECT val::uuid INTO v_comment_id FROM pg_temp.audit_test_state WHERE key = 'v_comment_id';
    SELECT val::timestamptz INTO v_orig_sent_at FROM pg_temp.audit_test_state WHERE key = 'v_orig_sent_at';

    SELECT * INTO v_rec FROM public.weekly_comments WHERE id = v_comment_id;
    IF v_rec.id IS NULL THEN
        RAISE EXCEPTION '[FAIL - NEG-12 POST-CHECK]: Bản ghi nhận xét đã gửi bị xóa mất khỏi DB!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-12', 'NEG',
        'Trigger chặn GV01 xóa nhận xét đã phát hành (SQLSTATE=P0001) và hậu kiểm bản ghi còn nguyên vẹn.'
    );

    IF v_rec.status IS DISTINCT FROM 'sent'::public.comment_status
       OR v_rec.sent_at IS DISTINCT FROM v_orig_sent_at THEN
        RAISE EXCEPTION '[FAIL - NEG-13 POST-CHECK]: Trạng thái hoặc sent_at của nhận xét đã gửi bị biến đổi!';
    END IF;

    PERFORM pg_temp.record_pass(
        'NEG-13', 'NEG',
        'Trigger chặn GV01 hoàn tác nhận xét đã gửi về draft (SQLSTATE=P0001) và hậu kiểm status = sent.'
    );
END $$;

-- ==============================================================================
-- 10. TỔNG KẾT & KIỂM ĐẾM BẮT BUỘC ĐỦ 17/17 CA KIỂM THỬ (13 NEG + 4 POS)
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
    FROM pg_temp.audit_test_results;

    RAISE NOTICE '==============================================================================';
    RAISE NOTICE 'BẢNG TỔNG HỢP KẾT QUẢ KIỂM THỬ BẢO MẬT RLS V3.5 (17 CA KIỂM THỬ):';
    RAISE NOTICE '------------------------------------------------------------------------------';
    FOR r IN
        SELECT seq_no, test_id, test_type, passed, detail
        FROM pg_temp.audit_test_results
        ORDER BY seq_no
    LOOP
        RAISE NOTICE '#% | % (%) | PASS=% | %',
            lpad(r.seq_no::text, 2, '0'), rpad(r.test_id, 6, ' '), r.test_type, r.passed, r.detail;
    END LOOP;
    RAISE NOTICE '------------------------------------------------------------------------------';
    RAISE NOTICE 'TỔNG KẾT: %/17 CA ĐẠT (NEG: %/13, POS: %/4)', v_total_pass, v_neg_pass, v_pos_pass;
    RAISE NOTICE '==============================================================================';

    IF v_total_pass <> 17 OR v_neg_pass <> 13 OR v_pos_pass <> 4 THEN
        RAISE EXCEPTION '[AUDIT SUITE INCOMPLETE]: Chưa đủ 17/17 ca PASS (Total=%, NEG=%, POS=%).',
            v_total_pass, v_neg_pass, v_pos_pass;
    END IF;
END $$;

ROLLBACK;
