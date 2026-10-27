-- Migration: 20261027000004_idempotent_migration_support.sql
-- Mục đích: Hỗ trợ tính lũy đẳng cấp Database cho student_points và RPC create_student_in_class trong Bước 3.6

BEGIN;

-- 1. Bổ sung source_id cho student_points để chống nhân đôi điểm thi đua ở cấp Database
ALTER TABLE public.student_points ADD COLUMN IF NOT EXISTS source_id VARCHAR(100);

-- Tạo unique partial index trên source_id (chỉ áp dụng khi source_id có giá trị)
CREATE UNIQUE INDEX IF NOT EXISTS unique_student_points_source_id 
    ON public.student_points (source_id) 
    WHERE source_id IS NOT NULL;

-- 2. Nâng cấp RPC create_student_in_class để hỗ trợ:
--    - p_id UUID (ổn định định danh khi di trú)
--    - p_is_active BOOLEAN (bảo toàn trạng thái active/archived của học sinh)
--    - p_status student_status (mặc định 'active')
--    - Tính lũy đẳng (idempotency) khi gọi lại sau lỗi mạng
-- Hủy overload cũ 9 tham số nếu tồn tại để tránh xung đột chữ ký gọi hàm
DROP FUNCTION IF EXISTS public.create_student_in_class(
    uuid, character varying, character varying, gender_type, date, character varying, text, character varying, character varying
);

CREATE OR REPLACE FUNCTION public.create_student_in_class(
    p_class_id uuid,
    p_code character varying,
    p_full_name character varying,
    p_gender gender_type DEFAULT NULL::gender_type,
    p_birth_date date DEFAULT NULL::date,
    p_avatar character varying DEFAULT 'cat-pink'::character varying,
    p_note text DEFAULT NULL::text,
    p_parent_name character varying DEFAULT NULL::character varying,
    p_parent_phone character varying DEFAULT NULL::character varying,
    p_id uuid DEFAULT NULL::uuid,
    p_is_active boolean DEFAULT true,
    p_status student_status DEFAULT 'active'::student_status
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_student_id UUID;
    v_existing_id UUID;
    v_existing_class_id UUID;
    v_clean_code VARCHAR;
    v_clean_name VARCHAR;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Yêu cầu đăng nhập.';
    END IF;

    IF NOT (public.is_class_teacher(p_class_id) OR public.is_admin()) THEN
        RAISE EXCEPTION 'Bạn không phải là giáo viên phụ trách lớp này.';
    END IF;

    v_clean_code := btrim(p_code);
    v_clean_name := btrim(p_full_name);

    IF v_clean_code IS NULL OR v_clean_code = '' THEN
        RAISE EXCEPTION 'Mã học sinh không được để trống.';
    END IF;
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        RAISE EXCEPTION 'Họ tên học sinh không được để trống.';
    END IF;

    -- Kiểm tra xem học sinh có mã này đã tồn tại chưa (so sánh chính xác, không phân biệt hoa thường)
    SELECT s.id INTO v_existing_id
    FROM public.students s
    WHERE upper(s.code) = upper(v_clean_code)
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        -- Học sinh đã tồn tại: kiểm tra tính lũy đẳng
        IF p_id IS NOT NULL AND v_existing_id <> p_id THEN
            RAISE EXCEPTION 'Mã học sinh % đã thuộc về một học sinh khác có ID khác.', v_clean_code;
        END IF;

        -- Kiểm tra liên kết lớp hiện có của học sinh
        SELECT cm.class_id INTO v_existing_class_id
        FROM public.class_memberships cm
        WHERE cm.student_id = v_existing_id AND cm.class_id = p_class_id
        LIMIT 1;

        IF v_existing_class_id IS NOT NULL THEN
            -- Đã có cả học sinh và membership trong lớp này: Idempotent return!
            UPDATE public.class_memberships
            SET is_active = p_is_active
            WHERE class_id = p_class_id AND student_id = v_existing_id;

            RETURN jsonb_build_object(
                'ok', true, 
                'student_id', v_existing_id, 
                'already_exists', true
            );
        ELSE
            -- Học sinh tồn tại nhưng chưa có liên kết với lớp này
            IF NOT public.can_teacher_link_student(v_existing_id, p_class_id) THEN
                RAISE EXCEPTION 'Không có quyền liên kết học sinh % vào lớp %.', v_clean_code, p_class_id;
            END IF;

            INSERT INTO public.class_memberships (class_id, student_id, is_active)
            VALUES (p_class_id, v_existing_id, p_is_active);

            RETURN jsonb_build_object(
                'ok', true, 
                'student_id', v_existing_id, 
                'linked_existing', true
            );
        END IF;
    END IF;

    -- Chưa tồn tại học sinh: Tạo mới
    v_student_id := COALESCE(p_id, gen_random_uuid());

    INSERT INTO public.students (
        id,
        code, 
        full_name, 
        gender, 
        birth_date, 
        avatar, 
        note, 
        parent_name, 
        parent_phone, 
        status
    )
    VALUES (
        v_student_id,
        v_clean_code,
        v_clean_name,
        p_gender,
        p_birth_date,
        COALESCE(NULLIF(btrim(p_avatar), ''), 'cat-pink'),
        p_note,
        NULLIF(btrim(p_parent_name), ''),
        NULLIF(btrim(p_parent_phone), ''),
        COALESCE(p_status, 'active'::student_status)
    );

    -- Gắn học sinh vào lớp trong cùng transaction
    INSERT INTO public.class_memberships (class_id, student_id, is_active)
    VALUES (p_class_id, v_student_id, p_is_active);

    RETURN jsonb_build_object(
        'ok', true, 
        'student_id', v_student_id, 
        'created_new', true
    );
END;
$function$;

-- Đảm bảo phân quyền an toàn
REVOKE ALL ON FUNCTION public.create_student_in_class(uuid, character varying, character varying, gender_type, date, character varying, text, character varying, character varying, uuid, boolean, student_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_student_in_class(uuid, character varying, character varying, gender_type, date, character varying, text, character varying, character varying, uuid, boolean, student_status) TO authenticated, service_role;

COMMIT;
