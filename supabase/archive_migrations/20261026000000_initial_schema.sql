-- ==============================================================================
-- PINK CLASSROOM - SUPABASE POSTGRESQL SCHEMA MIGRATION (DRAFT FOR REVIEW)
-- Giai đoạn: Thiết kế Schema & Row Level Security (RLS)
-- Lưu ý: Đây là bản thảo để xem xét, KHÔNG tự động thực thi.
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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

-- ==============================================================================
-- 3. TABLES DEFINITION
-- ==============================================================================

-- Bảng 1: profiles (Hồ sơ người dùng liên kết với auth.users)
-- Quản trị viên/Giáo viên/Phụ huynh. Tránh việc user tự nâng quyền role.
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT NOT NULL,
    role user_role NOT NULL DEFAULT 'parent', -- Mặc định là parent, không thể tự nâng lên teacher/admin
    phone TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bảng 2: classes (Lớp học)
CREATE TABLE IF NOT EXISTS public.classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    school_year VARCHAR(20) NOT NULL, -- vd: "2026-2027"
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL, -- Giáo viên chủ nhiệm chính
    subject VARCHAR(50),
    note TEXT,
    color VARCHAR(20) NOT NULL DEFAULT '#F7A8C4',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_class_per_year UNIQUE (name, school_year)
);

-- Bảng 3: students (Hồ sơ học sinh cốt lõi)
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL, -- Mã học sinh duy nhất toàn hệ thống (vd: HS0001)
    full_name VARCHAR(100) NOT NULL,
    birth_date DATE, -- Dữ liệu cá nhân, được bảo vệ bởi RLS, không công khai
    gender gender_type,
    avatar VARCHAR(50) NOT NULL DEFAULT 'cat-pink',
    note TEXT,
    status student_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bảng 4: class_memberships (Quan hệ học sinh - lớp học theo năm học / niên khóa)
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

-- Bảng 5: parent_students (Quan hệ tài khoản phụ huynh - học sinh)
-- Cần có cờ is_verified để xác minh quan hệ trước khi cho phép phụ huynh xem dữ liệu con
CREATE TABLE IF NOT EXISTS public.parent_students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    relationship VARCHAR(30) DEFAULT 'Phụ huynh', -- Bố, Mẹ, Người giám hộ
    is_verified BOOLEAN NOT NULL DEFAULT FALSE, -- Bắt buộc TRUE mới được xem điểm & nhận xét
    verified_at TIMESTAMPTZ,
    verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_parent_student UNIQUE (parent_id, student_id)
);

-- Bảng 6: criteria (Tiêu chí điểm thưởng / nhắc nhở)
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

-- Bảng 7: attendance (Điểm danh học sinh)
-- Tránh bản ghi trùng lặp bằng ràng buộc UNIQUE (class_id, student_id, date, session)
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

-- Bảng 8: student_points (Lịch sử điểm thưởng và thi đua)
CREATE TABLE IF NOT EXISTS public.student_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    criterion_id UUID REFERENCES public.criteria(id) ON DELETE SET NULL,
    criterion_name VARCHAR(100) NOT NULL, -- Sao lưu tên tiêu chí tại thời điểm chấm
    delta INT NOT NULL,
    note TEXT,
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
    undone BOOLEAN NOT NULL DEFAULT FALSE,
    undone_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bảng 9: weekly_comments (Nhận xét học sinh theo tuần / theo ngày)
CREATE TABLE IF NOT EXISTS public.weekly_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    week_number INT, -- Tuần học (vd: Tuần 1 -> 35)
    school_year VARCHAR(20) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    content TEXT NOT NULL,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_student_weekly_comment UNIQUE (student_id, class_id, school_year, week_number, date)
);

-- ==============================================================================
-- 4. INDEXES (Tối ưu truy vấn & hiệu năng)
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON public.classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_memberships_class ON public.class_memberships(class_id);
CREATE INDEX IF NOT EXISTS idx_memberships_student ON public.class_memberships(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_query ON public.attendance(class_id, date, session);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON public.attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_student_points_class ON public.student_points(class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_student_points_student ON public.student_points(student_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_parent ON public.parent_students(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_students_student ON public.parent_students(student_id);
CREATE INDEX IF NOT EXISTS idx_weekly_comments_student ON public.weekly_comments(student_id, school_year);

-- ==============================================================================
-- 5. HELPER FUNCTIONS CHO RLS (SECURITY DEFINER ĐỂ TRÁNH ĐỆ QUY VÔ HẠN)
-- ==============================================================================

-- Lấy vai trò của user hiện tại từ bảng profiles
CREATE OR REPLACE FUNCTION public.get_current_role()
RETURNS user_role AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Kiểm tra xem user hiện tại có phải giáo viên phụ trách lớp này không
CREATE OR REPLACE FUNCTION public.is_class_teacher(target_class_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.classes
        WHERE id = target_class_id AND teacher_id = auth.uid()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Kiểm tra xem user hiện tại có phải phụ huynh đã xác minh của học sinh không
CREATE OR REPLACE FUNCTION public.is_verified_parent(target_student_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.parent_students
        WHERE student_id = target_student_id
          AND parent_id = auth.uid()
          AND is_verified = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ==============================================================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- Mặc định: ENABLE ROW LEVEL SECURITY trên tất cả các bảng.
-- Nếu không có policy cho phép -> Mặc định DENY ALL.
-- ==============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_comments ENABLE ROW LEVEL SECURITY;

-- ----------------- 6.1 PROFILES -----------------
-- Ai cũng có thể xem hồ sơ của chính mình
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

-- User có thể sửa thông tin cá nhân của mình, NHƯNG KHÔNG ĐƯỢC ĐỔI ROLE
CREATE POLICY "Users can update own profile except role"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id AND role = (SELECT role FROM public.profiles WHERE id = auth.uid()));

-- Admin có toàn quyền trên profiles
CREATE POLICY "Admin full access on profiles"
    ON public.profiles FOR ALL
    USING (public.get_current_role() = 'admin');

-- ----------------- 6.2 CLASSES -----------------
-- Admin xem và sửa tất cả lớp
CREATE POLICY "Admin full access on classes"
    ON public.classes FOR ALL
    USING (public.get_current_role() = 'admin');

-- Giáo viên xem và cập nhật lớp mình phụ trách
CREATE POLICY "Teacher manage assigned classes"
    ON public.classes FOR ALL
    USING (teacher_id = auth.uid());

-- Phụ huynh xem thông tin lớp mà con mình đang theo học
CREATE POLICY "Parents view classes of their children"
    ON public.classes FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.class_memberships cm
            WHERE cm.class_id = classes.id
              AND cm.is_active = TRUE
              AND public.is_verified_parent(cm.student_id)
        )
    );

-- ----------------- 6.3 STUDENTS -----------------
-- Admin có toàn quyền trên học sinh
CREATE POLICY "Admin full access on students"
    ON public.students FOR ALL
    USING (public.get_current_role() = 'admin');

-- Giáo viên xem và quản lý học sinh thuộc lớp mình phụ trách
CREATE POLICY "Teacher manage students in their classes"
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

-- Phụ huynh chỉ xem được học sinh là con mình và đã xác minh
CREATE POLICY "Verified parents view own student"
    ON public.students FOR SELECT
    USING (public.is_verified_parent(students.id));

-- ----------------- 6.4 CLASS_MEMBERSHIPS -----------------
CREATE POLICY "Admin full access on memberships"
    ON public.class_memberships FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "Teacher manage class memberships"
    ON public.class_memberships FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "Parents view membership of their children"
    ON public.class_memberships FOR SELECT
    USING (public.is_verified_parent(student_id));

-- ----------------- 6.5 PARENT_STUDENTS -----------------
CREATE POLICY "Admin manage parent students"
    ON public.parent_students FOR ALL
    USING (public.get_current_role() = 'admin');

-- Giáo viên xem danh sách phụ huynh của học sinh trong lớp mình
CREATE POLICY "Teacher view parents in their classes"
    ON public.parent_students FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.class_memberships cm
            WHERE cm.student_id = parent_students.student_id
              AND public.is_class_teacher(cm.class_id)
        )
    );

-- Phụ huynh xem liên kết của chính mình
CREATE POLICY "Parent view own student link"
    ON public.parent_students FOR SELECT
    USING (parent_id = auth.uid());

-- ----------------- 6.6 CRITERIA -----------------
CREATE POLICY "Admin manage criteria"
    ON public.criteria FOR ALL
    USING (public.get_current_role() = 'admin');

CREATE POLICY "Teacher manage class criteria"
    ON public.criteria FOR ALL
    USING (public.is_class_teacher(class_id));

CREATE POLICY "Anyone in class can view criteria"
    ON public.criteria FOR SELECT
    USING (
        public.is_class_teacher(class_id)
        OR EXISTS (
            SELECT 1 FROM public.class_memberships cm
            WHERE cm.class_id = criteria.class_id
              AND public.is_verified_parent(cm.student_id)
        )
    );

-- ----------------- 6.7 ATTENDANCE -----------------
CREATE POLICY "Admin full access on attendance"
    ON public.attendance FOR ALL
    USING (public.get_current_role() = 'admin');

-- Giáo viên điểm danh và xem điểm danh lớp mình
CREATE POLICY "Teacher manage attendance"
    ON public.attendance FOR ALL
    USING (public.is_class_teacher(class_id));

-- Phụ huynh chỉ xem điểm danh của con mình
CREATE POLICY "Parents view attendance of their child"
    ON public.attendance FOR SELECT
    USING (public.is_verified_parent(student_id));

-- ----------------- 6.8 STUDENT_POINTS -----------------
CREATE POLICY "Admin full access on student points"
    ON public.student_points FOR ALL
    USING (public.get_current_role() = 'admin');

-- Giáo viên cộng/trừ điểm và xem điểm thi đua lớp mình
CREATE POLICY "Teacher manage student points"
    ON public.student_points FOR ALL
    USING (public.is_class_teacher(class_id));

-- Phụ huynh chỉ xem điểm thi đua của con mình
CREATE POLICY "Parents view points of their child"
    ON public.student_points FOR SELECT
    USING (public.is_verified_parent(student_id));

-- ----------------- 6.9 WEEKLY_COMMENTS -----------------
CREATE POLICY "Admin full access on comments"
    ON public.weekly_comments FOR ALL
    USING (public.get_current_role() = 'admin');

-- Giáo viên ghi nhận xét và sửa nhận xét lớp mình
CREATE POLICY "Teacher manage weekly comments"
    ON public.weekly_comments FOR ALL
    USING (public.is_class_teacher(class_id));

-- Phụ huynh chỉ xem nhận xét của con mình
CREATE POLICY "Parents view comments of their child"
    ON public.weekly_comments FOR SELECT
    USING (public.is_verified_parent(student_id));
