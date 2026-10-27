-- ==============================================================================
-- PINK CLASSROOM - MIGRATION V3.2: ADD STUDENT PARENT CONTACT COLUMNS
-- Mục đích:
-- 1. Bổ sung 2 cột thông tin liên hệ phụ huynh (parent_name, parent_phone) vào
--    bảng public.students một cách an toàn, idempotent (ADD COLUMN IF NOT EXISTS).
-- 2. Mở rộng hàm RPC nguyên tử public.create_student_in_class với 2 tham số tùy chọn
--    (p_parent_name DEFAULT NULL, p_parent_phone DEFAULT NULL), tương thích ngược
--    100% với các lời gọi hiện có.
-- 3. Giữ nguyên toàn bộ chính sách RLS trên public.students: chỉ giáo viên phụ trách
--    lớp đang hoạt động của học sinh (is_teacher_of_student), phụ huynh đã xác minh
--    của chính học sinh đó (is_verified_parent) và quản trị viên (is_admin) mới được
--    đọc dữ liệu; tuyệt đối không lộ parent_name / parent_phone sang lớp khác.
-- ==============================================================================

-- 1. Bổ sung cột parent_name và parent_phone vào bảng public.students
ALTER TABLE public.students
    ADD COLUMN IF NOT EXISTS parent_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS parent_phone VARCHAR(20);

-- 2. Cập nhật RPC create_student_in_class (Xóa chữ ký 7 tham số cũ trước để tránh trùng overload)
DROP FUNCTION IF EXISTS public.create_student_in_class(
    UUID, VARCHAR, VARCHAR, public.gender_type, DATE, VARCHAR, TEXT
);

CREATE OR REPLACE FUNCTION public.create_student_in_class(
    p_class_id UUID,
    p_code VARCHAR,
    p_full_name VARCHAR,
    p_gender public.gender_type DEFAULT NULL,
    p_birth_date DATE DEFAULT NULL,
    p_avatar VARCHAR DEFAULT 'cat-pink',
    p_note TEXT DEFAULT NULL,
    p_parent_name VARCHAR DEFAULT NULL,
    p_parent_phone VARCHAR DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_student_id UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    IF NOT (public.is_class_teacher(p_class_id) OR public.is_admin()) THEN
        RAISE EXCEPTION 'Bạn không phải là giáo viên phụ trách lớp này.';
    END IF;

    -- Tạo học sinh mới kèm thông tin liên hệ phụ huynh (nếu có)
    INSERT INTO public.students (
        code, full_name, gender, birth_date, avatar, note, parent_name, parent_phone, status
    )
    VALUES (
        p_code,
        p_full_name,
        p_gender,
        p_birth_date,
        COALESCE(NULLIF(btrim(p_avatar), ''), 'cat-pink'),
        p_note,
        NULLIF(btrim(p_parent_name), ''),
        NULLIF(btrim(p_parent_phone), ''),
        'active'
    )
    RETURNING id INTO v_student_id;

    -- Gắn học sinh vào lớp trong cùng transaction
    INSERT INTO public.class_memberships (class_id, student_id, is_active)
    VALUES (p_class_id, v_student_id, TRUE);

    RETURN jsonb_build_object('ok', true, 'student_id', v_student_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_student_in_class(
    UUID, VARCHAR, VARCHAR, public.gender_type, DATE, VARCHAR, TEXT, VARCHAR, VARCHAR
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_student_in_class(
    UUID, VARCHAR, VARCHAR, public.gender_type, DATE, VARCHAR, TEXT, VARCHAR, VARCHAR
) TO authenticated;
