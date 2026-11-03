-- ==============================================================================
-- Migration: 20261028000014_backend_parent_rate_limiting.sql
-- Mục đích: Kiểm soát Rate Limiting chống vét cạn mã mời phụ huynh ở cấp Database
-- Đảm bảo:
--   1. Giới hạn lưu ở cấp backend (Database), chia sẻ trên mọi tab, trình duyệt và RPC.
--   2. Không thể bypass bằng tải lại trang, mở tab mới hay gọi trực tiếp RPC.
--   3. Áp dụng theo auth.uid() của tài khoản phụ huynh đang đăng nhập.
--   4. Khóa FOR UPDATE bảo vệ chống hai kết nối đồng thời vượt qua giới hạn.
--   5. Thu hồi toàn bộ quyền INSERT/UPDATE/DELETE từ anon và authenticated.
--   6. Reset giới hạn khi kích hoạt thành công mã hợp lệ.
-- ==============================================================================

BEGIN;

-- 1. BẢNG QUẢN LÝ RATE LIMIT DÀNH CHO KÍCH HOẠT MÃ MỜI
CREATE TABLE IF NOT EXISTS public.parent_invitation_rate_limits (
    parent_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    failed_attempts INT NOT NULL DEFAULT 0,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cooldown_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Kích hoạt Row Level Security
ALTER TABLE public.parent_invitation_rate_limits ENABLE ROW LEVEL SECURITY;

-- Thu hồi toàn bộ quyền trực tiếp; chỉ cho phép RPC SECURITY DEFINER và service_role truy cập
REVOKE ALL ON TABLE public.parent_invitation_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.parent_invitation_rate_limits TO service_role;

-- 2. CẬP NHẬT RPC: claim_parent_invitation TÍCH HỢP RATE LIMITING Ở CẤP DATABASE
CREATE OR REPLACE FUNCTION public.claim_parent_invitation(raw_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_token_hash VARCHAR(64);
    v_record RECORD;
    v_parent_id UUID;
    v_existing_verified BOOLEAN;
    v_existing_verifier UUID;
    v_rate_rec RECORD;
    v_remaining_sec INT;
    v_window_seconds CONSTANT INT := 300; -- Cửa sổ 5 phút
    v_max_attempts CONSTANT INT := 5;     -- Tối đa 5 lần thử sai
    v_cooldown_seconds CONSTANT INT := 60; -- Cooldown 60 giây
BEGIN
    v_parent_id := auth.uid();
    IF v_parent_id IS NULL THEN
        RAISE EXCEPTION 'Chưa được xác thực: Vui lòng đăng nhập trước khi kích hoạt mã liên kết.';
    END IF;

    -- 1. KHÓA VÀ KIỂM TRA RATE LIMIT CỦA TÀI KHOẢN PHỤ HUYNH (CHỐNG CONCURRENCY BYPASS)
    SELECT * INTO v_rate_rec
    FROM public.parent_invitation_rate_limits
    WHERE parent_id = v_parent_id
    FOR UPDATE;

    IF v_rate_rec.parent_id IS NOT NULL THEN
        -- Nếu đang trong thời gian cooldown
        IF v_rate_rec.cooldown_until IS NOT NULL AND v_rate_rec.cooldown_until > NOW() THEN
            v_remaining_sec := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_rate_rec.cooldown_until - NOW()))));
            RETURN jsonb_build_object(
                'ok', false,
                'code', 'RATE_LIMITED',
                'message', format('Bạn đã thử sai quá nhiều lần. Vui lòng chờ %s giây trước khi thử lại.', v_remaining_sec)
            );
        END IF;
    END IF;

    -- 2. KIỂM TRA ĐỊNH DẠNG TOKEN
    IF raw_token IS NULL OR length(trim(raw_token)) < 16 THEN
        -- Ghi nhận lỗi định dạng vào rate limit
        IF v_rate_rec.parent_id IS NULL THEN
            INSERT INTO public.parent_invitation_rate_limits (parent_id, failed_attempts, first_failed_at, last_failed_at)
            VALUES (v_parent_id, 1, NOW(), NOW());
        ELSIF NOW() - v_rate_rec.first_failed_at > (v_window_seconds || ' seconds')::INTERVAL THEN
            UPDATE public.parent_invitation_rate_limits
            SET failed_attempts = 1, first_failed_at = NOW(), last_failed_at = NOW(), cooldown_until = NULL, updated_at = NOW()
            WHERE parent_id = v_parent_id;
        ELSE
            UPDATE public.parent_invitation_rate_limits
            SET failed_attempts = failed_attempts + 1, last_failed_at = NOW(), updated_at = NOW()
            WHERE parent_id = v_parent_id;
        END IF;

        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết không đúng định dạng hoặc quá ngắn.');
    END IF;

    -- 3. TÍNH BĂM SHA-256 CỦA TOKEN
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(raw_token), 'UTF8')),
        'hex'
    );

    -- 4. KHÓA BẢN GHI TOKEN TRONG SỔ CÁI
    SELECT * INTO v_record
    FROM public.parent_invitation_tokens
    WHERE token_hash = v_token_hash
    FOR UPDATE;

    -- Xử lý trường hợp mã không tồn tại / không hợp lệ
    IF v_record.id IS NULL OR v_record.is_revoked OR v_record.expires_at < NOW() OR v_record.used_at IS NOT NULL THEN
        -- Cập nhật số lần thử sai
        IF v_rate_rec.parent_id IS NULL THEN
            INSERT INTO public.parent_invitation_rate_limits (parent_id, failed_attempts, first_failed_at, last_failed_at)
            VALUES (v_parent_id, 1, NOW(), NOW());
        ELSIF NOW() - v_rate_rec.first_failed_at > (v_window_seconds || ' seconds')::INTERVAL THEN
            UPDATE public.parent_invitation_rate_limits
            SET failed_attempts = 1, first_failed_at = NOW(), last_failed_at = NOW(), cooldown_until = NULL, updated_at = NOW()
            WHERE parent_id = v_parent_id;
        ELSE
            IF (v_rate_rec.failed_attempts + 1) >= v_max_attempts THEN
                UPDATE public.parent_invitation_rate_limits
                SET failed_attempts = failed_attempts + 1,
                    last_failed_at = NOW(),
                    cooldown_until = NOW() + (v_cooldown_seconds || ' seconds')::INTERVAL,
                    updated_at = NOW()
                WHERE parent_id = v_parent_id;

                RETURN jsonb_build_object(
                    'ok', false,
                    'code', 'RATE_LIMITED',
                    'message', format('Bạn đã thử sai liên tiếp %s lần. Vui lòng chờ %s giây trước khi thử lại.', v_max_attempts, v_cooldown_seconds)
                );
            ELSE
                UPDATE public.parent_invitation_rate_limits
                SET failed_attempts = failed_attempts + 1, last_failed_at = NOW(), updated_at = NOW()
                WHERE parent_id = v_parent_id;
            END IF;
        END IF;

        IF v_record.id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết không tồn tại trong hệ thống.');
        ELSIF v_record.is_revoked THEN
            RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã bị giáo viên thu hồi hoặc cấp mới.');
        ELSIF v_record.expires_at < NOW() THEN
            RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã hết hạn hiệu lực.');
        ELSIF v_record.used_at IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã được sử dụng trước đó.');
        END IF;
    END IF;

    -- Kiểm tra học sinh còn active trong lớp liên kết
    IF NOT EXISTS (
        SELECT 1 FROM public.class_memberships cm
        WHERE cm.student_id = v_record.student_id
          AND cm.class_id = v_record.class_id
          AND cm.is_active = TRUE
    ) THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Học sinh không còn hoạt động trong lớp học liên kết.');
    END IF;

    -- 5. KÍCH HOẠT THÀNH CÔNG: XÓA SẠCH RATE LIMIT CHO TÀI KHOẢN PHỤ HUYNH NÀY
    DELETE FROM public.parent_invitation_rate_limits WHERE parent_id = v_parent_id;

    -- Kiểm tra liên kết đã tồn tại trước đó của phụ huynh này
    SELECT is_verified, verified_by INTO v_existing_verified, v_existing_verifier
    FROM public.parent_students
    WHERE student_id = v_record.student_id AND parent_id = v_parent_id;

    IF v_existing_verified IS TRUE THEN
        -- Đánh dấu tiêu thụ token để tránh token bị tái sử dụng
        UPDATE public.parent_invitation_tokens
        SET used_at = NOW(), used_by = v_parent_id, updated_at = NOW()
        WHERE id = v_record.id;

        RETURN jsonb_build_object(
            'ok', true,
            'message', 'Tài khoản của bạn đã được liên kết với học sinh này từ trước.',
            'student_id', v_record.student_id
        );
    END IF;

    -- Thiết lập quan hệ parent_students xác minh trong cùng transaction
    INSERT INTO public.parent_students (parent_id, student_id, relationship, is_verified, verified_at, verified_by)
    VALUES (v_parent_id, v_record.student_id, 'Phụ huynh', TRUE, NOW(), v_record.created_by)
    ON CONFLICT (parent_id, student_id)
    DO UPDATE SET is_verified = TRUE, verified_at = NOW(), verified_by = v_record.created_by
    WHERE parent_students.is_verified = FALSE;

    -- Đánh dấu token đã tiêu thụ thành công
    UPDATE public.parent_invitation_tokens
    SET used_at = NOW(), used_by = v_parent_id, updated_at = NOW()
    WHERE id = v_record.id;

    RETURN jsonb_build_object(
        'ok', true,
        'message', 'Xác minh và liên kết học sinh thành công!',
        'student_id', v_record.student_id
    );
END;
$$;

-- Phân quyền thực thi RPC
REVOKE ALL ON FUNCTION public.claim_parent_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_parent_invitation(text) TO authenticated, service_role;

COMMIT;
