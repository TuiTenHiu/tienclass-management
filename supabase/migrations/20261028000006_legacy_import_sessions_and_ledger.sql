-- Migration: 20261028000006_legacy_import_sessions_and_ledger.sql
-- Mục đích: Khung quản lý phiên di trú và sổ cái nguồn gốc bản ghi (Giai đoạn 2.6)

BEGIN;

-- 1. BẢNG QUẢN LÝ PHIÊN DI TRÚ: legacy_import_sessions
CREATE TABLE IF NOT EXISTS public.legacy_import_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'in_progress',
    backup_checksum VARCHAR(64) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Cơ chế Lease Lock & Concurrency Control
    lease_token UUID NOT NULL DEFAULT gen_random_uuid(),
    lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
    lock_version INT NOT NULL DEFAULT 1,
    pipeline_version VARCHAR(20) NOT NULL DEFAULT 'v1.0-cloud',
    
    -- Ghi nhận lỗi và tổng hợp dữ liệu
    last_error_stage VARCHAR(50),
    last_error_message TEXT,
    summary JSONB NOT NULL DEFAULT '{
        "classes": {"created": 0, "skipped": 0, "conflicts": 0},
        "students": {"created": 0, "skipped": 0, "conflicts": 0},
        "memberships": {"created": 0, "skipped": 0},
        "criteria": {"created": 0, "skipped": 0},
        "attendance": {"created": 0, "skipped": 0},
        "points": {"created": 0, "skipped": 0, "sum_delta": 0},
        "comments": {"created": 0, "skipped": 0}
    }'::jsonb,

    CONSTRAINT chk_import_session_status CHECK (
        status IN (
            'in_progress',
            'committed',
            'failed',
            'conflict_aborted',
            'rollback_in_progress',
            'rolled_back',
            'requires_manual_review'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_import_sessions_teacher_status 
    ON public.legacy_import_sessions (teacher_id, status);

-- 2. BẢNG SỔ CÁI NGUỒN GỐC: legacy_import_records
CREATE TABLE IF NOT EXISTS public.legacy_import_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.legacy_import_sessions(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    source_record_id VARCHAR(100) NOT NULL,
    cloud_record_id UUID NOT NULL,
    action_type VARCHAR(20) NOT NULL,
    source_fingerprint VARCHAR(64) NOT NULL DEFAULT 'SHA256_INITIAL',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_import_record_action CHECK (
        action_type IN (
            'created',
            'linked_existing',
            'updated',
            'conflicted',
            'skipped',
            'compensated'
        )
    ),
    CONSTRAINT unique_session_entity_source UNIQUE (session_id, entity_type, source_record_id),
    CONSTRAINT unique_session_entity_cloud UNIQUE (session_id, entity_type, cloud_record_id)
);

CREATE INDEX IF NOT EXISTS idx_import_records_lookup 
    ON public.legacy_import_records (entity_type, cloud_record_id);

CREATE INDEX IF NOT EXISTS idx_import_records_source 
    ON public.legacy_import_records (session_id, entity_type, source_record_id);

-- 3. BẢO MẬT RLS & PHÂN QUYỀN TRÊN BẢNG SỔ CÁI
ALTER TABLE public.legacy_import_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_import_records ENABLE ROW LEVEL SECURITY;

-- Thu hồi toàn bộ quyền khỏi PUBLIC và anon
REVOKE ALL ON public.legacy_import_sessions FROM PUBLIC, anon;
REVOKE ALL ON public.legacy_import_records FROM PUBLIC, anon;

-- Chỉ cấp SELECT cho authenticated; THU HỒI HOÀN TOÀN INSERT/UPDATE/DELETE KHỎI CLIENT
REVOKE INSERT, UPDATE, DELETE ON public.legacy_import_sessions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.legacy_import_records FROM authenticated;
GRANT SELECT ON public.legacy_import_sessions TO authenticated;
GRANT SELECT ON public.legacy_import_records TO authenticated;

-- Policies
DROP POLICY IF EXISTS "sessions_select_own" ON public.legacy_import_sessions;
CREATE POLICY "sessions_select_own" 
    ON public.legacy_import_sessions FOR SELECT 
    USING (teacher_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "records_select_own" ON public.legacy_import_records;
CREATE POLICY "records_select_own" 
    ON public.legacy_import_records FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM public.legacy_import_sessions s 
            WHERE s.id = session_id AND (s.teacher_id = auth.uid() OR public.is_admin())
        )
    );

COMMIT;
