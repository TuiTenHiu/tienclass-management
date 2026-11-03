-- Migration: 20261028000005_unique_active_criteria.sql
-- Mục đích: Chống trùng lặp tiêu chí thi đua đang hoạt động trong cùng lớp học ở cấp Database (Bước 2.6)

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_criteria_per_class 
    ON public.criteria (class_id, lower(btrim(name)), type) 
    WHERE archived = FALSE;

COMMIT;
