-- ==============================================================================
-- PINK CLASSROOM - SUPABASE POSTGRESQL SCHEMA MIGRATION (PROPOSED V2 FOR REVIEW)
-- Giai đoạn: Chuẩn bị tích hợp an toàn - Thiết kế Token & RLS chặt chẽ
-- LƯU Ý: ĐÂY LÀ BẢN THẢO XEM XÉT. CHƯA THỰC THI TRÊN SUPABASE.
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. ENUMS
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
-- 3. TABLES DEFINITION
-- ==============================================================================

-- 3.1 PROFILES: Liên kết auth.users, bảo vệ role
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'parent', -- Mặc định là parent, không thể tự nâng role
    phone TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.2 CLASSES: Lớp học
CREATE TABLE IF NOT EXISTS public.classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    school_year VARCHAR(20) NOT NULL, -- vd: "2026-2027"
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    subject VARCHAR(50),
    note TEXT,
    color VARCHAR(20) NOT NULL DEFAULT '#F7A8C4',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_class_per_year UNIQUE (name, school_year)
);

-- 3.3 STUDENTS: Học sinh (Ngày sinh bảo vệ RLS)
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    birth_date DATE, -- Dữ liệu cá nhân, không công khai
    gender gender_type,
    avatar VARCHAR(50) NOT NULL DEFAULT 'cat-pink',
    note TEXT,
    status student_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.4 CLASS_MEMBERSHIPS: Quan hệ lớp - học sinh
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

-- 3.5 PARENT_INVITATION_TOKENS: Quản lý token liên kết phụ huynh do giáo viên tạo
CREATE TABLE IF NOT EXISTS public.parent_invitation_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL, -- Lưu trữ SHA-256 hash của token (không lưu token thô)
    parent_phone VARCHAR(20), -- Số điện thoại đăng ký nhận mã xác minh
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3.6 PARENT_STUDENTS: Quan hệ phụ huynh - học sinh sau khi đã xác minh
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

-- 3.7 CRITERIA: Tiêu chí thi đua
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

-- 3.8 ATTENDANCE: Điểm danh (Tránh trùng bằng unique constraint)
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

-- 3.9 STUDENT_POINTS: Điểm thi đua
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

-- 3.10 WEEKLY_COMMENTS: Nhận xét học sinh (Bổ sung trạng thái draft/sent & sent_at)
CREATE TABLE IF NOT EXISTS public.weekly_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    week_number INT,
    school_year VARCHAR(20) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    content TEXT NOT NULL,
    status comment_status NOT NULL DEFAULT 'sent', -- 'draft' (nháp) hoặc 'sent' (đã gửi)
    sent_at TIMESTAMPTZ,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_student_weekly_comment UNIQUE (student_id, class_id, school_year, week_number, date)
);

-- ==============================================================================
-- 4. HELPER FUNCTIONS & TRIGGER (SECURITY DEFINER)
-- ==============================================================================

-- Lấy vai trò user hiện tại
CREATE OR REPLACE FUNCTION public.get_current_role()
RETURNS user_role AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Kiểm tra xem user có phải giáo viên phụ trách lớp
CREATE OR REPLACE FUNCTION public.is_class_teacher(target_class_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.classes
        WHERE id = target_class_id AND teacher_id = auth.uid()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Kiểm tra xem user có phải phụ huynh đã xác minh của học sinh
CREATE OR REPLACE FUNCTION public.is_verified_parent(target_student_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.parent_students
        WHERE student_id = target_student_id
          AND parent_id = auth.uid()
          AND is_verified = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- RPC Function: Xác minh token phía máy chủ và liên kết tài khoản phụ huynh
-- Hàm này chạy SECURITY DEFINER để thực hiện liên kết sau khi kiểm tra hợp lệ
CREATE OR REPLACE FUNCTION public.claim_parent_invitation(raw_token TEXT)
RETURNS JSONB AS $$
DECLARE
    v_token_hash VARCHAR(64);
    v_record RECORD;
    v_parent_id UUID;
BEGIN
    v_parent_id := auth.uid();
    IF v_parent_id IS NULL THEN
        RAISE EXCEPTION 'Vui lòng đăng nhập tài khoản phụ huynh trước khi xác nhận liên kết.';
    END IF;

    -- Tính hash SHA-256 của token gửi lên
    v_token_hash := encode(digest(raw_token, 'sha256'), 'hex');

    -- Tìm token hợp lệ
    SELECT * INTO v_record
    FROM public.parent_invitation_tokens
    WHERE token_hash = v_token_hash
      AND is_revoked = FALSE
      AND expires_at > NOW()
    LIMIT 1;

    IF v_record.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Mã liên kết không hợp lệ, đã hết hạn hoặc đã bị giáo viên thu hồi.');
    END IF;

    -- Tạo hoặc kích hoạt liên kết parent_students đã xác minh
    INSERT INTO public.parent_students (parent_id, student_id, relationship, is_verified, verified_at, verified_by)
    VALUES (v_parent_id, v_record.student_id, 'Phụ huynh', TRUE, NOW(), v_record.created_by)
    ON CONFLICT (parent_id, student_id)
    DO UPDATE SET is_verified = TRUE, verified_at = NOW(), verified_by = v_record.created_by;

    -- Đánh dấu token đã sử dụng
    UPDATE public.parent_invitation_tokens
    SET used_at = NOW(), updated_at = NOW()
    WHERE id = v_record.id;

    RETURN jsonb_build_object('ok', true, 'student_id', v_record.student_id, 'message', 'Xác minh và liên kết học sinh thành công!');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==============================================================================
-- 5. ROW LEVEL SECURITY (RLS) POLICIES
-- Mặc định DENY ALL (SELECT, INSERT, UPDATE, DELETE)
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

-- 5.1 PROFILES (Chặn tự leo quyền role)
CREATE POLICY "profiles_select_own"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id OR public.get_current_role() = 'admin');

CREATE POLICY "profiles_update_own"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id AND role = (SELECT role FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "profiles_admin_all"
    ON public.profiles FOR ALL
    USING (public.get_current_role() = 'admin');

-- 5.2 CLASSES
CREATE POLICY "classes_admin_all"
    ON public.classes FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "classes_teacher_manage"
    ON public.classes FOR ALL
    USING (teacher_id = auth.uid());

CREATE POLICY "classes_parent_select"
    ON public.classes FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.class_memberships cm
            WHERE cm.class_id = classes.id
              AND cm.is_active = TRUE
              AND public.is_verified_parent(cm.student_id)
        )
    );

-- 5.3 STUDENTS (Bảo vệ thông tin cá nhân & ngày sinh)
CREATE POLICY "students_admin_all"
    ON public.students FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "students_teacher_manage"
    ON public.students FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.class_memberships cm
            JOIN public.classes c ON c.id = cm.class_id
            WHERE cm.student_id = students.id
              AND cm.is_active = TRUE
              AND c.teacher_id = auth.uid()
        )
    );

CREATE POLICY "students_parent_select"
    ON public.students FOR SELECT
    USING (public.is_verified_parent(students.id));

-- 5.4 CLASS_MEMBERSHIPS
CREATE POLICY "memberships_admin_all"
    ON public.class_memberships FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "memberships_teacher_manage"
    ON public.class_memberships FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "memberships_parent_select"
    ON public.class_memberships FOR SELECT
    USING (public.is_verified_parent(student_id));

-- 5.5 PARENT_INVITATION_TOKENS (Giáo viên quản lý, Phụ huynh không SELECT trực tiếp)
CREATE POLICY "tokens_admin_all"
    ON public.parent_invitation_tokens FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "tokens_teacher_manage"
    ON public.parent_invitation_tokens FOR ALL
    USING (public.is_class_teacher(class_id));

-- 5.6 PARENT_STUDENTS
CREATE POLICY "parent_students_admin_all"
    ON public.parent_students FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "parent_students_teacher_manage"
    ON public.parent_students FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.class_memberships cm
            WHERE cm.student_id = parent_students.student_id
              AND public.is_class_teacher(cm.class_id)
        )
    );

CREATE POLICY "parent_students_parent_select"
    ON public.parent_students FOR SELECT
    USING (parent_id = auth.uid());

-- 5.7 CRITERIA
CREATE POLICY "criteria_admin_all"
    ON public.criteria FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "criteria_teacher_manage"
    ON public.criteria FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "criteria_parent_select"
    ON public.criteria FOR SELECT
    USING (
        public.is_class_teacher(class_id)
        OR EXISTS (
            SELECT 1 FROM public.class_memberships cm
            WHERE cm.class_id = criteria.class_id
              AND public.is_verified_parent(cm.student_id)
        )
    );

-- 5.8 ATTENDANCE
CREATE POLICY "attendance_admin_all"
    ON public.attendance FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "attendance_teacher_manage"
    ON public.attendance FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "attendance_parent_select"
    ON public.attendance FOR SELECT
    USING (public.is_verified_parent(student_id));

-- 5.9 STUDENT_POINTS
CREATE POLICY "points_admin_all"
    ON public.student_points FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "points_teacher_manage"
    ON public.student_points FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "points_parent_select"
    ON public.student_points FOR SELECT
    USING (public.is_verified_parent(student_id));

-- 5.10 WEEKLY_COMMENTS (QUAN TRỌNG: Phụ huynh CHỈ xem status = 'sent')
CREATE POLICY "comments_admin_all"
    ON public.weekly_comments FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "comments_teacher_manage"
    ON public.weekly_comments FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "comments_parent_select_sent_only"
    ON public.weekly_comments FOR SELECT
    USING (
        public.is_verified_parent(student_id)
        AND status = 'sent' -- Chặn hoàn toàn nhận xét bản nháp (draft)
    );
