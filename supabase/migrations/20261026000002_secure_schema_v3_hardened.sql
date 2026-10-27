-- ==============================================================================
-- PINK CLASSROOM - SUPABASE POSTGRESQL SCHEMA MIGRATION V3 (HARDENED REVISED V3.1)
-- Mục đích: Bản thiết kế bảo mật chuyên sâu khắc phục triệt để các phát hiện kiểm toán:
-- 1. LOẠI BỎ HOÀN TOÀN việc sử dụng auth.jwt() -> 'user_metadata' ->> 'role'.
--    user_metadata do client gửi lên (có thể bị giả mạo qua supabase.auth.updateUser()).
--    Chỉ dùng nguồn phân quyền do máy chủ/quản trị viên kiểm soát: app_metadata và bảng profiles.
-- 2. Kiểm soát chặt chẽ hàm public.is_admin(): Triệt tiêu đệ quy, không tin cậy client metadata.
-- 3. Chống leo quyền: Parent không thể can thiệp user_metadata để nhận quyền admin, không thể
--    UPDATE profiles.role (chặn ở Column-Level Privileges + Trigger + RLS).
-- 4. Hạn chế cập nhật parent_invitation_tokens:
--    - Chỉ cấp quyền UPDATE trên (is_revoked, revoked_at, updated_at).
--    - Cấm sửa token_hash, class_id, student_id, used_at, used_by, created_by.
--    - Bổ sung RPC thu hồi chuyên biệt: revoke_parent_invitation(UUID).
--    - Trigger máy chủ kiểm soát máy trạng thái (state machine): không thể hoàn tác thu hồi,
--      không thể thu hồi token đã sử dụng.
-- 5. RPC claim_parent_invitation: Khóa dòng FOR UPDATE, atomic transaction, chống replay.
-- 6. Phân quyền đầy đủ cấp bảng và cấp cột (GRANT/REVOKE) kết hợp RLS đồng bộ.
-- 7. Tương thích Idempotent: Tuyệt đối không xóa bảng, không xóa dữ liệu, không dùng DROP ... CASCADE.
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. ENUMS (Tạo an toàn, không báo lỗi nếu đã tồn tại)
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin', 'teacher', 'parent');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE gender_type AS ENUM ('male', 'female', 'other');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE student_status AS ENUM ('active', 'archived');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE attendance_status AS ENUM ('present', 'late', 'excused', 'unexcused');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE class_session AS ENUM ('morning', 'afternoon', 'all');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE point_criterion_type AS ENUM ('reward', 'penalty');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE comment_status AS ENUM ('draft', 'sent');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ==============================================================================
-- 3. TABLES DEFINITION (CREATE IF NOT EXISTS + ALTER COLUMN SAFELY)
-- ==============================================================================

-- 3.1 PROFILES
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'parent',
    phone TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.2 CLASSES
CREATE TABLE IF NOT EXISTS public.classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    school_year VARCHAR(20) NOT NULL,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    subject VARCHAR(50),
    note TEXT,
    color VARCHAR(20) NOT NULL DEFAULT '#F7A8C4',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_class_per_year UNIQUE (name, school_year)
);

-- 3.3 STUDENTS
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    birth_date DATE,
    gender gender_type,
    avatar VARCHAR(50) NOT NULL DEFAULT 'cat-pink',
    note TEXT,
    status student_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.4 CLASS_MEMBERSHIPS
CREATE TABLE IF NOT EXISTS public.class_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    joined_at DATE NOT NULL DEFAULT CURRENT_DATE,
    left_at DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_student_active_class UNIQUE (student_id, class_id)
);

-- 3.5 PARENT_INVITATION_TOKENS
CREATE TABLE IF NOT EXISTS public.parent_invitation_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    parent_phone VARCHAR(20),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    used_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.6 PARENT_STUDENTS
CREATE TABLE IF NOT EXISTS public.parent_students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    relationship VARCHAR(30) DEFAULT 'Phụ huynh',
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_parent_student UNIQUE (parent_id, student_id)
);

-- 3.7 CRITERIA
CREATE TABLE IF NOT EXISTS public.criteria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    points INT NOT NULL,
    type point_criterion_type NOT NULL,
    icon VARCHAR(30) NOT NULL DEFAULT 'star',
    display_order INT NOT NULL DEFAULT 0,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.8 ATTENDANCE
CREATE TABLE IF NOT EXISTS public.attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    session class_session NOT NULL DEFAULT 'morning',
    status attendance_status NOT NULL DEFAULT 'present',
    note TEXT,
    recorded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_attendance_record UNIQUE (class_id, student_id, date, session)
);

-- 3.9 STUDENT_POINTS
CREATE TABLE IF NOT EXISTS public.student_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    criterion_id UUID REFERENCES public.criteria(id) ON DELETE SET NULL,
    criterion_name VARCHAR(100) NOT NULL,
    delta INT NOT NULL,
    note TEXT,
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
    undone BOOLEAN NOT NULL DEFAULT FALSE,
    undone_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.10 WEEKLY_COMMENTS
CREATE TABLE IF NOT EXISTS public.weekly_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    week_number INT,
    school_year VARCHAR(20) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    content TEXT NOT NULL,
    status comment_status NOT NULL DEFAULT 'draft',
    sent_at TIMESTAMPTZ,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_student_weekly_comment UNIQUE (student_id, class_id, school_year, week_number, date)
);

-- Nâng cấp an toàn từ schema cũ (Thêm cột nếu chưa tồn tại)
ALTER TABLE public.parent_invitation_tokens ADD COLUMN IF NOT EXISTS is_revoked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.parent_invitation_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE public.parent_invitation_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
ALTER TABLE public.parent_invitation_tokens ADD COLUMN IF NOT EXISTS used_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.parent_invitation_tokens ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.weekly_comments ADD COLUMN IF NOT EXISTS status comment_status NOT NULL DEFAULT 'draft';
ALTER TABLE public.weekly_comments ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE public.weekly_comments ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ==============================================================================
-- 4. INDEXES
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON public.classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_memberships_class ON public.class_memberships(class_id);
CREATE INDEX IF NOT EXISTS idx_memberships_student ON public.class_memberships(student_id);
CREATE INDEX IF NOT EXISTS idx_memberships_active_lookup ON public.class_memberships(class_id, student_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON public.parent_invitation_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_class_student ON public.parent_invitation_tokens(class_id, student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_query ON public.attendance(class_id, date, session);
CREATE INDEX IF NOT EXISTS idx_student_points_class ON public.student_points(class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_parent_students_parent ON public.parent_students(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_student ON public.parent_students(student_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_lookup ON public.parent_students(student_id, parent_id, is_verified);
CREATE INDEX IF NOT EXISTS idx_weekly_comments_student ON public.weekly_comments(student_id, school_year);
CREATE INDEX IF NOT EXISTS idx_weekly_comments_class_status ON public.weekly_comments(class_id, status);

-- ==============================================================================
-- 5. HELPER FUNCTIONS (SECURITY DEFINER + search_path CỐ ĐỊNH + NGUỒN QUYỀN ĐÁNG TIN CẬY)
-- ==============================================================================

-- 5.1 Kiểm tra vai trò admin ĐÁNG TIN CẬY
-- CẢNH BÁO BẢO MẬT: TUYỆT ĐỐI KHÔNG đọc từ user_metadata vì người dùng client có thể
-- tự sửa đổi qua supabase.auth.updateUser({ data: { role: 'admin' } }).
-- Nguồn hợp lệ duy nhất:
-- a) auth.jwt() -> 'app_metadata' ->> 'role' (do Supabase service_role quản lý máy chủ đặt)
-- b) Bảng public.profiles (vai trò đã được hệ thống/admin phê duyệt)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
    -- 1. Kiểm tra JWT app_metadata (chỉ gán bởi Service Role / Admin API)
    IF (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' THEN
        RETURN TRUE;
    END IF;

    -- 2. Kiểm tra bản ghi profiles của người dùng hiện tại
    RETURN EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.2 Lấy vai trò tài khoản hiện tại từ bảng profiles
CREATE OR REPLACE FUNCTION public.get_current_role()
RETURNS user_role AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.3 Kiểm tra user hiện tại có phải giáo viên phụ trách lớp
CREATE OR REPLACE FUNCTION public.is_class_teacher(target_class_id UUID)
RETURNS BOOLEAN AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.classes
        WHERE id = target_class_id AND teacher_id = auth.uid()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.4 Kiểm tra user hiện tại có phải phụ huynh đã xác minh của học sinh
CREATE OR REPLACE FUNCTION public.is_verified_parent(target_student_id UUID)
RETURNS BOOLEAN AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.parent_students
        WHERE student_id = target_student_id
          AND parent_id = auth.uid()
          AND is_verified = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.5 Kiểm tra tính nhất quán thành viên: Học sinh có đang hoạt động trong lớp không
-- Chỉ trả về TRUE khi người gọi có thẩm quyền hợp lệ trên lớp hoặc học sinh đó (chống dò quét UUID tùy ý)
CREATE OR REPLACE FUNCTION public.is_student_in_class(target_student_id UUID, target_class_id UUID)
RETURNS BOOLEAN AS $$
    SELECT (
        auth.uid() IS NULL
        OR public.is_class_teacher(target_class_id)
        OR public.is_verified_parent(target_student_id)
        OR public.is_admin()
    ) AND EXISTS (
        SELECT 1 FROM public.class_memberships cm
        WHERE cm.class_id = target_class_id
          AND cm.student_id = target_student_id
          AND cm.is_active = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.6 Kiểm tra user hiện tại có phải giáo viên phụ trách lớp đang hoạt động của học sinh
CREATE OR REPLACE FUNCTION public.is_teacher_of_student(target_student_id UUID)
RETURNS BOOLEAN AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.class_memberships cm
        JOIN public.classes c ON c.id = cm.class_id
        WHERE cm.student_id = target_student_id
          AND cm.is_active = TRUE
          AND c.teacher_id = auth.uid()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.7 Kiểm tra user hiện tại có phải phụ huynh đã xác minh của học sinh đang học trong lớp
CREATE OR REPLACE FUNCTION public.is_verified_parent_in_class(target_class_id UUID)
RETURNS BOOLEAN AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.class_memberships cm
        JOIN public.parent_students ps ON ps.student_id = cm.student_id
        WHERE cm.class_id = target_class_id
          AND cm.is_active = TRUE
          AND ps.parent_id = auth.uid()
          AND ps.is_verified = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.8 Kiểm tra user hiện tại có phải giáo viên dạy con (đã xác minh) của phụ huynh target_parent_id
CREATE OR REPLACE FUNCTION public.is_teacher_of_parent(target_parent_id UUID)
RETURNS BOOLEAN AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.parent_students ps
        JOIN public.class_memberships cm ON cm.student_id = ps.student_id
        JOIN public.classes c ON c.id = cm.class_id
        WHERE ps.parent_id = target_parent_id
          AND ps.is_verified = TRUE
          AND cm.is_active = TRUE
          AND c.teacher_id = auth.uid()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.9 Kiểm tra user hiện tại có phải phụ huynh đã xác minh của học sinh do giáo viên target_teacher_id phụ trách
CREATE OR REPLACE FUNCTION public.is_verified_parent_of_teacher(target_teacher_id UUID)
RETURNS BOOLEAN AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.classes c
        JOIN public.class_memberships cm ON cm.class_id = c.id
        JOIN public.parent_students ps ON ps.student_id = cm.student_id
        WHERE c.teacher_id = target_teacher_id
          AND cm.is_active = TRUE
          AND ps.parent_id = auth.uid()
          AND ps.is_verified = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- 5.10 Kiểm tra giáo viên hiện tại có quyền gắn/quản lý liên kết học sinh vào lớp của mình không
-- (Chặn giáo viên tự ý gắn học sinh đang thuộc lớp của giáo viên khác vào lớp mình để vượt quyền)
CREATE OR REPLACE FUNCTION public.can_teacher_link_student(target_student_id UUID, target_class_id UUID)
RETURNS BOOLEAN AS $$
    SELECT public.is_class_teacher(target_class_id)
       AND EXISTS (
           SELECT 1 FROM public.students s WHERE s.id = target_student_id
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.class_memberships cm
           LEFT JOIN public.classes c ON c.id = cm.class_id
           WHERE cm.student_id = target_student_id
             AND c.teacher_id IS DISTINCT FROM auth.uid()
       );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Phân quyền thực thi các hàm Helper: Thu hồi từ PUBLIC/anon, chỉ cấp cho authenticated
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_current_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_role() TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_class_teacher(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_class_teacher(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_verified_parent(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_verified_parent(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_student_in_class(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_student_in_class(UUID, UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_teacher_of_student(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_teacher_of_student(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_verified_parent_in_class(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_verified_parent_in_class(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_teacher_of_parent(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_teacher_of_parent(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_verified_parent_of_teacher(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_verified_parent_of_teacher(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.can_teacher_link_student(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_teacher_link_student(UUID, UUID) TO authenticated;

-- ==============================================================================
-- 6. TRIGGER FUNCTIONS & BẢO VỆ CHẶN ĐỨNG GIAO TÁC SAI PHẠM
-- (Toàn bộ là SECURITY DEFINER + search_path cố định; Thu hồi EXECUTE trực tiếp)
-- ==============================================================================

-- 6.1 Tự động tạo profiles khi người dùng đăng ký qua auth.users (Mặc định: parent)
-- KHÔNG chấp nhận bất kỳ role nào từ raw_user_meta_data của client!
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, role)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', 'Người dùng mới'),
        'parent' -- Bất kể client gửi gì, mặc định BẮT BUỘC là parent
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- 6.2 Chống tự ý leo quyền role trên profiles (Trigger chặn tầng sâu)
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        -- Chỉ có admin thực sự (qua app_metadata hoặc profiles.role = admin) mới được đổi
        IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
            RAISE EXCEPTION 'Quyền bị từ chối: Người dùng không được phép thay đổi cột vai trò (role).';
        END IF;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_prevent_profile_role_escalation ON public.profiles;
CREATE TRIGGER trg_prevent_profile_role_escalation
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_profile_role_escalation();

-- 6.3 Ràng buộc token liên kết: Bất biến cấu trúc và kiểm soát máy trạng thái
CREATE OR REPLACE FUNCTION public.validate_parent_invitation_token()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- 1. Chỉ giáo viên phụ trách lớp hoặc admin mới được tạo mã (Kiểm tra quyền trước để chống dò thành viên lớp)
        IF auth.uid() IS NOT NULL AND NOT (public.is_class_teacher(NEW.class_id) OR public.is_admin()) THEN
            RAISE EXCEPTION 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp %.', NEW.class_id;
        END IF;

        -- 2. Học sinh phải đang hoạt động trong lớp
        IF NOT public.is_student_in_class(NEW.student_id, NEW.class_id) THEN
            RAISE EXCEPTION 'Ràng buộc không hợp lệ: Học sinh (id: %) không thuộc lớp (id: %) hoặc đã nghỉ học.', NEW.student_id, NEW.class_id;
        END IF;

        -- 3. Khởi tạo giá trị ban đầu hợp lệ
        NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
        NEW.is_revoked := FALSE;
        NEW.revoked_at := NULL;
        NEW.used_at := NULL;
        NEW.used_by := NULL;
        NEW.created_at := NOW();
        NEW.updated_at := NOW();

    ELSIF TG_OP = 'UPDATE' THEN
        -- 1. BẤT BIẾN CẤU TRÚC: Cấm sửa class_id, student_id, token_hash, created_by
        IF NEW.class_id IS DISTINCT FROM OLD.class_id OR 
           NEW.student_id IS DISTINCT FROM OLD.student_id OR 
           NEW.token_hash IS DISTINCT FROM OLD.token_hash OR 
           NEW.created_by IS DISTINCT FROM OLD.created_by THEN
            RAISE EXCEPTION 'Không được phép thay đổi cấu trúc mã liên kết (lớp, học sinh, mã băm, người tạo).';
        END IF;

        -- 2. MÁY TRẠNG THÁI: Token đã sử dụng là bất biến (không thể thu hồi hoặc sửa)
        IF OLD.used_at IS NOT NULL THEN
            IF NEW.is_revoked IS DISTINCT FROM OLD.is_revoked
               OR NEW.used_at IS DISTINCT FROM OLD.used_at
               OR NEW.used_by IS DISTINCT FROM OLD.used_by THEN
                RAISE EXCEPTION 'Không thể sửa đổi hoặc thu hồi mã liên kết đã qua sử dụng.';
            END IF;
        END IF;

        -- 3. Phân nhánh kiểm tra quyền theo loại chuyển đổi trạng thái:
        -- Nhánh A: Đánh dấu tiêu thụ token qua RPC claim_parent_invitation (cột used_at/used_by đã khóa quyền UPDATE trực tiếp)
        IF NEW.used_at IS NOT NULL AND OLD.used_at IS NULL
           AND NEW.is_revoked IS NOT DISTINCT FROM OLD.is_revoked
           AND (auth.uid() IS NULL OR NEW.used_by = auth.uid() OR public.is_admin()) THEN
            IF OLD.is_revoked THEN
                RAISE EXCEPTION 'Mã liên kết đã bị thu hồi, không thể đánh dấu sử dụng.';
            END IF;
            IF OLD.expires_at <= NOW() THEN
                RAISE EXCEPTION 'Mã liên kết đã hết hạn, không thể đánh dấu sử dụng.';
            END IF;
        ELSE
            -- Nhánh B: Mọi cập nhật quản lý khác (thu hồi token...) bắt buộc phải là giáo viên phụ trách lớp hoặc admin
            IF auth.uid() IS NOT NULL AND NOT (public.is_class_teacher(OLD.class_id) OR public.is_admin()) THEN
                RAISE EXCEPTION 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp của token này.';
            END IF;

            -- Xử lý thu hồi
            IF NEW.is_revoked = TRUE AND OLD.is_revoked = FALSE THEN
                NEW.revoked_at := COALESCE(NEW.revoked_at, NOW());
            ELSIF NEW.is_revoked = FALSE AND OLD.is_revoked = TRUE THEN
                -- Chặn đứng việc hoàn tác thu hồi trái phép
                RAISE EXCEPTION 'Không được phép kích hoạt lại mã liên kết đã bị thu hồi.';
            END IF;
        END IF;

        NEW.updated_at := NOW();

    ELSIF TG_OP = 'DELETE' THEN
        -- Bảo vệ nhật ký kiểm toán: Cấm xóa token đã sử dụng
        IF OLD.used_at IS NOT NULL THEN
            RAISE EXCEPTION 'Không được phép xóa mã liên kết đã qua sử dụng (bảo vệ nhật ký kiểm toán).';
        END IF;
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_validate_parent_invitation_token ON public.parent_invitation_tokens;
CREATE TRIGGER trg_validate_parent_invitation_token
    BEFORE INSERT OR UPDATE OR DELETE ON public.parent_invitation_tokens
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_parent_invitation_token();

-- 6.4 Bảo vệ tính bất biến của quan hệ xác minh trên parent_students
CREATE OR REPLACE FUNCTION public.protect_parent_students()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Chỉ cho phép cập nhật nếu là admin hoặc chuyển từ unverified sang verified hợp lệ
        IF (NEW.is_verified IS DISTINCT FROM OLD.is_verified OR 
            NEW.verified_by IS DISTINCT FROM OLD.verified_by OR 
            NEW.verified_at IS DISTINCT FROM OLD.verified_at) AND 
           NOT public.is_admin() AND 
           NOT (NEW.is_verified = TRUE AND OLD.is_verified = FALSE) THEN
            RAISE EXCEPTION 'Không có quyền tự ý sửa đổi trạng thái xác minh phụ huynh.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_protect_parent_students ON public.parent_students;
CREATE TRIGGER trg_protect_parent_students
    BEFORE UPDATE ON public.parent_students
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_parent_students();

-- 6.5 Kiểm soát nhận xét hàng tuần: Kiểm tra tư cách lớp & tự động quản lý sent_at
CREATE OR REPLACE FUNCTION public.handle_comment_status_and_consistency()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Bảo vệ lưu trữ sư phạm: Giáo viên không được tự xóa nhận xét đã phát hành
        IF OLD.status = 'sent' AND NOT public.is_admin() THEN
            RAISE EXCEPTION 'Không được phép xóa nhận xét đã gửi tới phụ huynh (bảo vệ lưu trữ sư phạm).';
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

    -- 3. Xử lý thời điểm phát hành sang 'sent' (Tách riêng INSERT và UPDATE để không đọc OLD khi INSERT)
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
            -- Bất biến: Không được phép sửa lùi/tiến dấu thời gian sent_at hoặc đổi người gửi
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.handle_comment_status_and_consistency() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comment_status_and_consistency ON public.weekly_comments;
CREATE TRIGGER trg_comment_status_and_consistency
    BEFORE INSERT OR UPDATE OR DELETE ON public.weekly_comments
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_comment_status_and_consistency();

-- 6.6 Ràng buộc điểm danh: Không ghi đè hoặc chèn dữ liệu sang lớp khác
CREATE OR REPLACE FUNCTION public.validate_attendance_consistency()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND NOT (public.is_class_teacher(NEW.class_id) OR public.is_admin()) THEN
        RAISE EXCEPTION 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp này để điểm danh.';
    END IF;

    IF NOT public.is_student_in_class(NEW.student_id, NEW.class_id) THEN
        RAISE EXCEPTION 'Ràng buộc điểm danh thất bại: Học sinh không thuộc lớp học này.';
    END IF;

    NEW.recorded_by := COALESCE(auth.uid(), NEW.recorded_by);
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_validate_attendance_consistency ON public.attendance;
CREATE TRIGGER trg_validate_attendance_consistency
    BEFORE INSERT OR UPDATE ON public.attendance
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_attendance_consistency();

-- 6.7 Ràng buộc điểm thi đua: Kiểm tra học sinh & tiêu chí phải đúng lớp
CREATE OR REPLACE FUNCTION public.validate_student_points_consistency()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND NOT (public.is_class_teacher(NEW.class_id) OR public.is_admin()) THEN
        RAISE EXCEPTION 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp này để chấm điểm.';
    END IF;

    IF NOT public.is_student_in_class(NEW.student_id, NEW.class_id) THEN
        RAISE EXCEPTION 'Ràng buộc điểm thất bại: Học sinh không thuộc lớp học được chấm điểm.';
    END IF;

    IF NEW.criterion_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.criteria
            WHERE id = NEW.criterion_id AND class_id = NEW.class_id
        ) THEN
            RAISE EXCEPTION 'Tiêu chí thi đua được chọn không thuộc lớp học này.';
        END IF;
    END IF;

    NEW.actor_id := COALESCE(auth.uid(), NEW.actor_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_validate_student_points_consistency ON public.student_points;
CREATE TRIGGER trg_validate_student_points_consistency
    BEFORE INSERT OR UPDATE ON public.student_points
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_student_points_consistency();

-- Thu hồi quyền EXECUTE trực tiếp của các trigger function để chống user gọi lậu
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_profile_role_escalation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_parent_invitation_token() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_parent_students() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_comment_status_and_consistency() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_attendance_consistency() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_student_points_consistency() FROM PUBLIC, anon, authenticated;

-- ==============================================================================
-- 7. RPC FUNCTIONS (NGHIỆP VỤ MÁY CHỦ BẢO MẬT)
-- ==============================================================================

-- 7.1 RPC: Thu hồi token liên kết chuyên biệt (Chỉ giáo viên phụ trách lớp hoặc admin)
CREATE OR REPLACE FUNCTION public.revoke_parent_invitation(p_token_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_record RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Chưa được xác thực: Vui lòng đăng nhập.';
    END IF;

    -- Khóa hàng kiểm tra
    SELECT * INTO v_record
    FROM public.parent_invitation_tokens
    WHERE id = p_token_id
    FOR UPDATE;

    IF v_record.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết không tồn tại.');
    END IF;

    IF NOT (public.is_class_teacher(v_record.class_id) OR public.is_admin()) THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Quyền bị từ chối: Bạn không phải giáo viên phụ trách lớp này.');
    END IF;

    IF v_record.used_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã được phụ huynh sử dụng, không thể thu hồi.');
    END IF;

    IF v_record.is_revoked THEN
        RETURN jsonb_build_object('ok', true, 'message', 'Mã liên kết này đã được thu hồi từ trước.');
    END IF;

    UPDATE public.parent_invitation_tokens
    SET is_revoked = TRUE, revoked_at = NOW(), updated_at = NOW()
    WHERE id = p_token_id;

    RETURN jsonb_build_object('ok', true, 'message', 'Thu hồi mã liên kết thành công.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.revoke_parent_invitation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_parent_invitation(UUID) TO authenticated;

-- 7.2 RPC: Xác minh token liên kết phụ huynh
-- Khóa hàng FOR UPDATE để chống Race Condition, chạy nguyên tử trong 1 transaction
CREATE OR REPLACE FUNCTION public.claim_parent_invitation(raw_token TEXT)
RETURNS JSONB AS $$
DECLARE
    v_token_hash VARCHAR(64);
    v_record RECORD;
    v_parent_id UUID;
    v_existing_verified BOOLEAN;
    v_existing_verifier UUID;
BEGIN
    v_parent_id := auth.uid();
    IF v_parent_id IS NULL THEN
        RAISE EXCEPTION 'Chưa được xác thực: Vui lòng đăng nhập trước khi kích hoạt mã liên kết.';
    END IF;

    -- Kiểm tra sơ bộ định dạng token
    IF raw_token IS NULL OR length(trim(raw_token)) < 16 THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết không đúng định dạng hoặc quá ngắn.');
    END IF;

    -- Tính mã băm SHA-256 bằng hàm gốc pg_catalog (không phụ thuộc search_path hay pgcrypto)
    v_token_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(raw_token), 'UTF8')),
        'hex'
    );

    -- Khóa hàng token đang xử lý
    SELECT * INTO v_record
    FROM public.parent_invitation_tokens
    WHERE token_hash = v_token_hash
    FOR UPDATE;

    IF v_record.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết không tồn tại trong hệ thống.');
    END IF;

    IF v_record.is_revoked THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã bị giáo viên thu hồi hoặc cấp mới.');
    END IF;

    IF v_record.used_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã được sử dụng trước đó.');
    END IF;

    IF v_record.expires_at <= NOW() THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết này đã hết hạn hiệu lực.');
    END IF;

    -- Kiểm tra học sinh có còn thuộc lớp này không
    IF NOT EXISTS (
        SELECT 1 FROM public.class_memberships cm
        WHERE cm.class_id = v_record.class_id
          AND cm.student_id = v_record.student_id
          AND cm.is_active = TRUE
    ) THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Học sinh không còn hoạt động trong lớp học liên kết.');
    END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_parent_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_parent_invitation(TEXT) TO authenticated;

-- 7.3 RPC: Tạo học sinh và gắn vào lớp học nguyên tử
CREATE OR REPLACE FUNCTION public.create_student_in_class(
    p_class_id UUID,
    p_code VARCHAR,
    p_full_name VARCHAR,
    p_gender gender_type DEFAULT NULL,
    p_birth_date DATE DEFAULT NULL,
    p_avatar VARCHAR DEFAULT 'cat-pink',
    p_note TEXT DEFAULT NULL
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

    -- Tạo học sinh mới
    INSERT INTO public.students (code, full_name, gender, birth_date, avatar, note, status)
    VALUES (p_code, p_full_name, p_gender, p_birth_date, p_avatar, p_note, 'active')
    RETURNING id INTO v_student_id;

    -- Gắn học sinh vào lớp trong cùng transaction
    INSERT INTO public.class_memberships (class_id, student_id, is_active)
    VALUES (p_class_id, v_student_id, TRUE);

    RETURN jsonb_build_object('ok', true, 'student_id', v_student_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_student_in_class(UUID, VARCHAR, VARCHAR, gender_type, DATE, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_student_in_class(UUID, VARCHAR, VARCHAR, gender_type, DATE, VARCHAR, TEXT) TO authenticated;

-- ==============================================================================
-- 8. QUYỀN TRUY CẬP CẤP BẢNG VÀ CẤP CỘT (TABLE & COLUMN-LEVEL PRIVILEGES)
-- ==============================================================================

-- Thu hồi toàn bộ quyền mặc định từ PUBLIC và anon trên tất cả các bảng
REVOKE ALL ON public.profiles FROM PUBLIC, anon;
REVOKE ALL ON public.classes FROM PUBLIC, anon;
REVOKE ALL ON public.students FROM PUBLIC, anon;
REVOKE ALL ON public.class_memberships FROM PUBLIC, anon;
REVOKE ALL ON public.parent_invitation_tokens FROM PUBLIC, anon;
REVOKE ALL ON public.parent_students FROM PUBLIC, anon;
REVOKE ALL ON public.criteria FROM PUBLIC, anon;
REVOKE ALL ON public.attendance FROM PUBLIC, anon;
REVOKE ALL ON public.student_points FROM PUBLIC, anon;
REVOKE ALL ON public.weekly_comments FROM PUBLIC, anon;

-- Bảng profiles: Người dùng authenticated chỉ được SELECT và UPDATE các cột an toàn
REVOKE ALL ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT INSERT (id, full_name, avatar_url, phone, role) ON public.profiles TO authenticated;
GRANT UPDATE (full_name, phone, avatar_url, updated_at) ON public.profiles TO authenticated;
-- Chú ý: TUYỆT ĐỐI không cấp quyền UPDATE trên cột 'role', 'id', 'created_at' cho authenticated!

-- Bảng parent_invitation_tokens:
-- Authenticated chỉ được SELECT, INSERT, DELETE và CHỈ ĐƯỢC UPDATE CỘT THU HỒI
REVOKE ALL ON public.parent_invitation_tokens FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.parent_invitation_tokens TO authenticated;
GRANT UPDATE (is_revoked, revoked_at, updated_at) ON public.parent_invitation_tokens TO authenticated;
-- TUYỆT ĐỐI không cấp quyền UPDATE trên token_hash, class_id, student_id, used_at, used_by, created_by!

-- Bảng parent_students: Không cho phép authenticated INSERT/UPDATE trực tiếp
REVOKE ALL ON public.parent_students FROM authenticated;
GRANT SELECT, DELETE ON public.parent_students TO authenticated;
-- Thao tác tạo liên kết được thực thi an toàn thông qua RPC claim_parent_invitation

-- Các bảng dữ liệu nghiệp vụ: Cấp quyền cơ sở cho authenticated (RLS kiểm soát quyền thực tế)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.classes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.students TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.criteria TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_points TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_comments TO authenticated;

-- ==============================================================================
-- 9. ROW LEVEL SECURITY (RLS) POLICIES
-- Mặc định DENY ALL cho toàn bộ bảng nếu không khớp policy tường minh
-- ==============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_invitation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_comments ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 9.1 PROFILES POLICIES (Loại bỏ hoàn toàn đệ quy)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_teacher_select_parents" ON public.profiles;
DROP POLICY IF EXISTS "profiles_parent_select_teacher" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own_as_parent_only" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own_no_role_change" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_all" ON public.profiles;

-- Bản thân xem hồ sơ của mình
CREATE POLICY "profiles_select_own"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

-- Giáo viên xem hồ sơ phụ huynh trong lớp mình quản lý
CREATE POLICY "profiles_teacher_select_parents"
    ON public.profiles FOR SELECT
    USING (public.is_teacher_of_parent(profiles.id));

-- Phụ huynh xem hồ sơ giáo viên đang dạy con mình
CREATE POLICY "profiles_parent_select_teacher"
    ON public.profiles FOR SELECT
    USING (public.is_verified_parent_of_teacher(profiles.id));

-- Admin xem toàn bộ hồ sơ
CREATE POLICY "profiles_admin_select"
    ON public.profiles FOR SELECT
    USING (public.is_admin());

-- Insert hồ sơ của bản thân (mặc định parent)
CREATE POLICY "profiles_insert_own_as_parent_only"
    ON public.profiles FOR INSERT
    WITH CHECK (auth.uid() = id AND role = 'parent');

-- Update hồ sơ của bản thân (không có đệ quy, cột role đã bị chặn ở column privileges + trigger)
CREATE POLICY "profiles_update_own"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Admin toàn quyền trên profiles
CREATE POLICY "profiles_admin_all"
    ON public.profiles FOR ALL
    USING (public.is_admin());

-- ------------------------------------------------------------------------------
-- 9.2 CLASSES POLICIES
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "classes_admin_all" ON public.classes;
DROP POLICY IF EXISTS "classes_teacher_manage" ON public.classes;
DROP POLICY IF EXISTS "classes_parent_select" ON public.classes;

CREATE POLICY "classes_admin_all"
    ON public.classes FOR ALL
    USING (public.is_admin());

CREATE POLICY "classes_teacher_manage"
    ON public.classes FOR ALL
    USING (teacher_id = auth.uid() AND public.get_current_role() IN ('teacher', 'admin'))
    WITH CHECK (teacher_id = auth.uid() AND public.get_current_role() IN ('teacher', 'admin'));

CREATE POLICY "classes_parent_select"
    ON public.classes FOR SELECT
    USING (public.is_verified_parent_in_class(classes.id));

-- ------------------------------------------------------------------------------
-- 9.3 STUDENTS POLICIES
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "students_admin_all" ON public.students;
DROP POLICY IF EXISTS "students_teacher_select" ON public.students;
DROP POLICY IF EXISTS "students_teacher_insert" ON public.students;
DROP POLICY IF EXISTS "students_teacher_update" ON public.students;
DROP POLICY IF EXISTS "students_teacher_delete" ON public.students;
DROP POLICY IF EXISTS "students_teacher_manage" ON public.students;
DROP POLICY IF EXISTS "students_parent_select" ON public.students;

CREATE POLICY "students_admin_all"
    ON public.students FOR ALL
    USING (public.is_admin());

-- Giáo viên xem danh sách học sinh thuộc lớp mình
CREATE POLICY "students_teacher_select"
    ON public.students FOR SELECT
    USING (public.is_teacher_of_student(students.id));

-- Giáo viên/admin được thêm học sinh
CREATE POLICY "students_teacher_insert"
    ON public.students FOR INSERT
    WITH CHECK (public.get_current_role() IN ('teacher', 'admin'));

-- Giáo viên sửa học sinh lớp mình
CREATE POLICY "students_teacher_update"
    ON public.students FOR UPDATE
    USING (public.is_teacher_of_student(students.id))
    WITH CHECK (public.is_teacher_of_student(students.id));

-- Giáo viên xóa học sinh lớp mình
CREATE POLICY "students_teacher_delete"
    ON public.students FOR DELETE
    USING (public.is_teacher_of_student(students.id));

-- Phụ huynh chỉ xem học sinh đã xác minh của mình
CREATE POLICY "students_parent_select"
    ON public.students FOR SELECT
    USING (public.is_verified_parent(students.id));

-- ------------------------------------------------------------------------------
-- 9.4 CLASS_MEMBERSHIPS POLICIES
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "memberships_admin_all" ON public.class_memberships;
DROP POLICY IF EXISTS "memberships_teacher_manage" ON public.class_memberships;
DROP POLICY IF EXISTS "memberships_parent_select" ON public.class_memberships;

CREATE POLICY "memberships_admin_all"
    ON public.class_memberships FOR ALL
    USING (public.is_admin());

CREATE POLICY "memberships_teacher_manage"
    ON public.class_memberships FOR ALL
    USING (
        public.is_class_teacher(class_id)
        AND public.can_teacher_link_student(student_id, class_id)
    )
    WITH CHECK (
        public.is_class_teacher(class_id)
        AND public.can_teacher_link_student(student_id, class_id)
    );

CREATE POLICY "memberships_parent_select"
    ON public.class_memberships FOR SELECT
    USING (public.is_verified_parent(student_id));

-- ------------------------------------------------------------------------------
-- 9.5 PARENT_INVITATION_TOKENS POLICIES (Ràng buộc nghiêm ngặt lớp - học sinh)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "tokens_admin_all" ON public.parent_invitation_tokens;
DROP POLICY IF EXISTS "tokens_teacher_manage" ON public.parent_invitation_tokens;
DROP POLICY IF EXISTS "tokens_teacher_select" ON public.parent_invitation_tokens;
DROP POLICY IF EXISTS "tokens_teacher_insert" ON public.parent_invitation_tokens;
DROP POLICY IF EXISTS "tokens_teacher_update" ON public.parent_invitation_tokens;
DROP POLICY IF EXISTS "tokens_teacher_delete" ON public.parent_invitation_tokens;

CREATE POLICY "tokens_admin_all"
    ON public.parent_invitation_tokens FOR ALL
    USING (public.is_admin());

-- Giáo viên xem danh sách token của học sinh thuộc lớp mình
CREATE POLICY "tokens_teacher_select"
    ON public.parent_invitation_tokens FOR SELECT
    USING (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    );

-- Giáo viên tạo token cho học sinh trong lớp mình
CREATE POLICY "tokens_teacher_insert"
    ON public.parent_invitation_tokens FOR INSERT
    WITH CHECK (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
        AND (created_by = auth.uid() OR created_by IS NULL)
    );

-- Giáo viên thu hồi token trong lớp mình
CREATE POLICY "tokens_teacher_update"
    ON public.parent_invitation_tokens FOR UPDATE
    USING (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    )
    WITH CHECK (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    );

-- Giáo viên xóa token chưa dùng trong lớp mình (Không thể xóa token đã dùng)
CREATE POLICY "tokens_teacher_delete"
    ON public.parent_invitation_tokens FOR DELETE
    USING (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
        AND used_at IS NULL
    );

-- ------------------------------------------------------------------------------
-- 9.6 PARENT_STUDENTS POLICIES
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "parent_students_admin_all" ON public.parent_students;
DROP POLICY IF EXISTS "parent_students_teacher_manage" ON public.parent_students;
DROP POLICY IF EXISTS "parent_students_teacher_select" ON public.parent_students;
DROP POLICY IF EXISTS "parent_students_teacher_delete" ON public.parent_students;
DROP POLICY IF EXISTS "parent_students_parent_select" ON public.parent_students;

CREATE POLICY "parent_students_admin_all"
    ON public.parent_students FOR ALL
    USING (public.is_admin());

CREATE POLICY "parent_students_teacher_select"
    ON public.parent_students FOR SELECT
    USING (public.is_teacher_of_student(parent_students.student_id));

CREATE POLICY "parent_students_teacher_delete"
    ON public.parent_students FOR DELETE
    USING (public.is_teacher_of_student(parent_students.student_id));

CREATE POLICY "parent_students_parent_select"
    ON public.parent_students FOR SELECT
    USING (parent_id = auth.uid());

-- ------------------------------------------------------------------------------
-- 9.7 CRITERIA POLICIES
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "criteria_admin_all" ON public.criteria;
DROP POLICY IF EXISTS "criteria_teacher_manage" ON public.criteria;
DROP POLICY IF EXISTS "criteria_parent_select" ON public.criteria;

CREATE POLICY "criteria_admin_all"
    ON public.criteria FOR ALL
    USING (public.is_admin());

CREATE POLICY "criteria_teacher_manage"
    ON public.criteria FOR ALL
    USING (public.is_class_teacher(class_id))
    WITH CHECK (public.is_class_teacher(class_id));

CREATE POLICY "criteria_parent_select"
    ON public.criteria FOR SELECT
    USING (
        public.is_class_teacher(class_id)
        OR public.is_verified_parent_in_class(criteria.class_id)
    );

-- ------------------------------------------------------------------------------
-- 9.8 ATTENDANCE POLICIES (Cách ly lớp học)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "attendance_admin_all" ON public.attendance;
DROP POLICY IF EXISTS "attendance_teacher_manage" ON public.attendance;
DROP POLICY IF EXISTS "attendance_parent_select" ON public.attendance;

CREATE POLICY "attendance_admin_all"
    ON public.attendance FOR ALL
    USING (public.is_admin());

CREATE POLICY "attendance_teacher_manage"
    ON public.attendance FOR ALL
    USING (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    )
    WITH CHECK (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    );

CREATE POLICY "attendance_parent_select"
    ON public.attendance FOR SELECT
    USING (public.is_verified_parent(student_id));

-- ------------------------------------------------------------------------------
-- 9.9 STUDENT_POINTS POLICIES (Cách ly lớp học)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "points_admin_all" ON public.student_points;
DROP POLICY IF EXISTS "points_teacher_manage" ON public.student_points;
DROP POLICY IF EXISTS "points_parent_select" ON public.student_points;

CREATE POLICY "points_admin_all"
    ON public.student_points FOR ALL
    USING (public.is_admin());

CREATE POLICY "points_teacher_manage"
    ON public.student_points FOR ALL
    USING (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    )
    WITH CHECK (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    );

CREATE POLICY "points_parent_select"
    ON public.student_points FOR SELECT
    USING (public.is_verified_parent(student_id));

-- ------------------------------------------------------------------------------
-- 9.10 WEEKLY_COMMENTS POLICIES (Phụ huynh CHỈ đọc nhận xét ĐÃ GỬI)
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "comments_admin_all" ON public.weekly_comments;
DROP POLICY IF EXISTS "comments_teacher_manage" ON public.weekly_comments;
DROP POLICY IF EXISTS "comments_parent_select_sent_only" ON public.weekly_comments;

CREATE POLICY "comments_admin_all"
    ON public.weekly_comments FOR ALL
    USING (public.is_admin());

-- Giáo viên xem/sửa toàn bộ nhận xét (nháp lẫn đã gửi) của học sinh lớp mình
CREATE POLICY "comments_teacher_manage"
    ON public.weekly_comments FOR ALL
    USING (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    )
    WITH CHECK (
        public.is_class_teacher(class_id)
        AND public.is_student_in_class(student_id, class_id)
    );

-- Phụ huynh CHỈ đọc nhận xét của con đã xác minh VÀ nhận xét đó phải ở trạng thái 'sent'
CREATE POLICY "comments_parent_select_sent_only"
    ON public.weekly_comments FOR SELECT
    USING (
        public.is_verified_parent(student_id)
        AND status = 'sent'
    );
